//! Turning what the caller named into the list of files to scan.
//!
//! Directories are walked with ripgrep's `ignore`, so "what this tool
//! scans" and "what ripgrep scans" are the same answer. A file named
//! explicitly is always scanned, ignore rules included: you asked for it.
//!
//! There is no format filter. A regex literal is a regex literal
//! wherever it appears, and the extension's engine takes raw text rather
//! than a language id — the corpus includes a `.txt` for that reason.

use std::path::{Path as StdPath, PathBuf};

#[derive(Debug, Clone)]
pub(crate) struct WalkOptions {
    pub(crate) hidden: bool,
    pub(crate) respect_ignore: bool,
}

impl Default for WalkOptions {
    fn default() -> Self {
        Self {
            hidden: false,
            respect_ignore: true,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Walked {
    pub(crate) files: Vec<PathBuf>,
}

// What the ignore rules kept out is deliberately not counted. On a
// checkout with dependencies installed the number is around thirty
// thousand and every one of them is `node_modules`, so a line reporting
// it reads as a shortfall when the walk did exactly what it was asked.
// A dangerous regex inside a dependency is also not a line you can go
// and fix. `--no-ignore` is how you widen it, and the second walk the
// count needed doubled the cost of every run.

/// Collect every file to scan, in a stable order.
///
/// The sort is not cosmetic: `ignore` makes no ordering guarantee, and a
/// report whose lines move between two runs over an unchanged tree
/// cannot be diffed — which is most of what a report in CI is for.
pub(crate) fn collect(inputs: &[PathBuf], options: &WalkOptions) -> Result<Walked, String> {
    let mut files = Vec::new();

    for input in inputs {
        let metadata =
            std::fs::metadata(input).map_err(|error| format!("{}: {error}", input.display()))?;

        if metadata.is_file() {
            files.push(input.clone());
            continue;
        }

        files.extend(walk_directory(input, options)?.files);
    }

    files.sort();
    files.dedup();
    Ok(Walked { files })
}

fn walk_directory(root: &StdPath, options: &WalkOptions) -> Result<Walked, String> {
    let mut builder = ignore::WalkBuilder::new(root);
    builder
        .hidden(!options.hidden)
        .git_ignore(options.respect_ignore)
        .git_global(options.respect_ignore)
        .git_exclude(options.respect_ignore)
        .ignore(options.respect_ignore)
        .parents(options.respect_ignore)
        // Never followed. A link out of the tree would have this scan
        // reading files the caller did not point it at, and reporting
        // their paths.
        .follow_links(false);

    Ok(Walked {
        files: files_under(&mut builder, root)?,
    })
}

fn files_under(builder: &mut ignore::WalkBuilder, root: &StdPath) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    for entry in builder.build() {
        let entry = entry.map_err(|error| format!("{}: {error}", root.display()))?;
        if entry.file_type().is_some_and(|kind| kind.is_file()) {
            files.push(entry.path().to_path_buf());
        }
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempTree;

    fn names(walked: &Walked) -> Vec<String> {
        walked
            .files
            .iter()
            .map(|path| {
                path.file_name()
                    .expect("a name")
                    .to_string_lossy()
                    .into_owned()
            })
            .collect()
    }

    /// Every text file, whatever its extension — a credential does not
    /// care what the file is called.
    #[test]
    fn a_directory_yields_every_file_regardless_of_extension() {
        let tree = TempTree::new("walk-all");
        tree.write("a.json", "{}");
        tree.write("notes.md", "x");
        tree.write("config.bak", "x");
        tree.write("Makefile", "x");
        let walked = collect(&[tree.path().to_path_buf()], &WalkOptions::default()).expect("walks");
        assert_eq!(
            names(&walked),
            ["Makefile", "a.json", "config.bak", "notes.md"]
        );
    }

    #[test]
    fn the_order_is_stable() {
        let tree = TempTree::new("walk-order");
        for name in ["z.js", "a.js", "m.js"] {
            tree.write(name, "x");
        }
        let first = collect(&[tree.path().to_path_buf()], &WalkOptions::default()).expect("walks");
        let second = collect(&[tree.path().to_path_buf()], &WalkOptions::default()).expect("walks");
        assert_eq!(names(&first), ["a.js", "m.js", "z.js"]);
        assert_eq!(first, second);
    }

    /// A secret in an ignored file is not going to be committed, which
    /// is the threat — but it is still a secret on the disk, so the
    /// count of what was held back has to be visible.
    #[test]
    fn ignored_files_are_skipped() {
        let tree = TempTree::new("walk-ignore");
        tree.mkdir(".git");
        tree.write(".gitignore", "ignored.js\n");
        tree.write("ignored.js", "const re = /(a+)+/;");
        tree.write("kept.js", "x");

        let walked = collect(&[tree.path().to_path_buf()], &WalkOptions::default()).expect("walks");
        assert!(names(&walked).contains(&"kept.js".to_string()));
        assert!(!names(&walked).contains(&"ignored.js".to_string()));
    }

    #[test]
    fn hidden_files_are_scanned_on_request() {
        let tree = TempTree::new("walk-hidden");
        tree.write(".hidden.js", "const re = /(a+)+/;");
        let default =
            collect(&[tree.path().to_path_buf()], &WalkOptions::default()).expect("walks");
        assert!(default.files.is_empty());

        let all = collect(
            &[tree.path().to_path_buf()],
            &WalkOptions {
                hidden: true,
                ..WalkOptions::default()
            },
        )
        .expect("walks");
        assert_eq!(names(&all), [".hidden.js"]);
    }

    #[test]
    fn an_explicitly_named_file_beats_the_ignore_rules() {
        let tree = TempTree::new("walk-explicit");
        tree.mkdir(".git");
        tree.write(".gitignore", ".hidden.js\n");
        let file = tree.write(".hidden.js", "const re = /(a+)+/;");
        let walked = collect(&[file], &WalkOptions::default()).expect("walks");
        assert_eq!(names(&walked), [".hidden.js"]);
    }

    #[test]
    fn a_missing_input_is_refused_by_name() {
        let tree = TempTree::new("walk-missing");
        let error =
            collect(&[tree.path().join("nope")], &WalkOptions::default()).expect_err("a refusal");
        assert!(error.contains("nope"), "{error}");
    }

    #[test]
    fn naming_the_same_file_twice_scans_it_once() {
        let tree = TempTree::new("walk-dedupe");
        let file = tree.write("a.js", "x");
        let walked = collect(&[file.clone(), file], &WalkOptions::default()).expect("walks");
        assert_eq!(walked.files.len(), 1);
    }
}
