//! Does this crate open what it claims to open?
//!
//! Three questions, none of which any other test asks:
//!
//! - **Every name in the alias table lands on a file the walk reads.**
//!   One file per alias, plus a dozen extensions nothing here has heard
//!   of, and a report line required for every one of them. There is no
//!   format filter in this crate, so a file the walk skips is a bug
//!   rather than a policy.
//! - **Every language the alias table names is actually understood.**
//!   A report line proves the file was opened; a *finding* proves its
//!   spellings were looked for. "Opens 21 of 88" was visible in a
//!   sibling only because somebody counted by hand.
//! - **Every language the alias table names has a corpus document.**
//!   A language pinned by nothing is a language the two frontends can
//!   drift on without a build going red.
//!
//! The alias table is read from `fixtures/aliases.json` — the file that
//! already holds the two MCP servers' tables equal — rather than from
//! the crate's own constant, because a test that reads the constant it
//! is checking proves only that the constant equals itself.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const BINARY: &str = env!("CARGO_BIN_EXE_regex-le");
const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures");

/// Extensions nothing here resolves. Each must still be opened, read and
/// reported: the language chooses which spellings to look for, never
/// whether to look.
const UNKNOWN: [&str; 13] = [
    "md", "txt", "yaml", "yml", "toml", "ini", "cfg", "sql", "sh", "kt", "swift", "scala", "dart",
];

/// A call site per language, each holding one exponential shape so a
/// finding proves the spelling was looked for rather than the file
/// merely opened.
const SPELLINGS: [(&str, &str); 9] = [
    ("javascript", "const bad = /(a+)+/g;\n"),
    ("typescript", "const bad: RegExp = /(a+)+/;\n"),
    ("python", "BAD = re.compile(r\"(a+)+\")\n"),
    ("rust", "let bad = Regex::new(r\"(a+)+\");\n"),
    ("go", "var bad = regexp.MustCompile(`(a+)+`)\n"),
    ("java", "Pattern bad = Pattern.compile(\"(a+)+\");\n"),
    ("ruby", "BAD = /(a+)+/\n"),
    ("php", "preg_match('/(a+)+/', $s);\n"),
    ("csharp", "var bad = new Regex(@\"(a+)+\");\n"),
];

struct Tree {
    root: PathBuf,
}

impl Tree {
    fn new(name: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("regex-le-coverage-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("a temporary directory");
        Self {
            root: std::fs::canonicalize(&root).expect("a canonical directory"),
        }
    }

    fn path(&self) -> &Path {
        &self.root
    }

    fn write(&self, name: &str, contents: &str) {
        std::fs::write(self.root.join(name), contents).expect("a file");
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn aliases() -> BTreeMap<String, String> {
    let path = Path::new(FIXTURES).join("aliases.json");
    let text = std::fs::read_to_string(&path).expect("the shared alias table");
    serde_json::from_str(&text).expect("the alias table is valid JSON")
}

fn spelling(language: &str) -> &'static str {
    SPELLINGS
        .iter()
        .find(|(name, _)| *name == language)
        .map_or_else(
            || panic!("{language} is in the alias table with no call site written for it here"),
            |(_, source)| *source,
        )
}

fn scan(root: &Path) -> Vec<serde_json::Value> {
    let output = Command::new(BINARY)
        .args(["--all", &root.to_string_lossy()])
        .stdin(Stdio::null())
        .output()
        .expect("the binary runs");
    assert!(
        output
            .status
            .code()
            .is_some_and(|code| (0..=2).contains(&code)),
        "the scan did not answer: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("stdout carries only JSON"))
        .collect()
}

/// One file per alias plus a dozen extensions nothing resolves, and a
/// report line for every one of them.
#[test]
fn every_extension_in_the_table_is_opened_and_reported() {
    let table = aliases();
    assert!(!table.is_empty(), "the alias table is empty");

    let tree = Tree::new("aliases");
    let mut expected: BTreeSet<String> = BTreeSet::new();

    for (index, (alias, language)) in table.iter().enumerate() {
        let name = format!("alias{index:02}.{alias}");
        tree.write(&name, spelling(language));
        expected.insert(name);
    }
    for (index, extension) in UNKNOWN.iter().enumerate() {
        let name = format!("unknown{index:02}.{extension}");
        tree.write(&name, "const bad = /(a+)+/g;\n");
        expected.insert(name);
    }
    // No extension at all, which is neither known nor unknown but has to
    // be read all the same.
    tree.write("Makefile", "PATTERN = /(a+)+/\n");
    expected.insert("Makefile".to_string());

    let reported: BTreeSet<String> = scan(tree.path())
        .iter()
        .filter_map(|report| report["file"].as_str())
        .filter_map(|file| file.rsplit('/').next())
        .map(str::to_string)
        .collect();

    let missing: Vec<&String> = expected.difference(&reported).collect();
    assert!(
        missing.is_empty(),
        "the walk skipped {} files it should have opened: {missing:?}",
        missing.len()
    );
}

/// A report line proves the file was opened. A finding proves its
/// language's spellings were looked for, which is the claim the alias
/// table actually makes.
#[test]
fn every_language_in_the_table_finds_its_own_spelling() {
    let table = aliases();
    let tree = Tree::new("languages");
    let mut expected: BTreeMap<String, String> = BTreeMap::new();

    for (index, (alias, language)) in table.iter().enumerate() {
        let name = format!("alias{index:02}.{alias}");
        tree.write(&name, spelling(language));
        expected.insert(name, language.clone());
    }

    let mut silent: Vec<String> = Vec::new();
    let reports = scan(tree.path());
    for (name, language) in expected {
        let report = reports
            .iter()
            .find(|report| {
                report["file"]
                    .as_str()
                    .is_some_and(|file| file.ends_with(&name))
            })
            .unwrap_or_else(|| panic!("{name}: no report line"));
        if report["summary"]["findings"] != 1 {
            silent.push(format!("{name} ({language})"));
        }
    }
    assert!(
        silent.is_empty(),
        "these names resolve to a language whose spellings were not found: {silent:?}"
    );
}

/// A language nothing in the corpus exercises is one the two frontends
/// can drift on without a build going red.
#[test]
fn every_language_in_the_table_has_a_corpus_document() {
    let table = aliases();
    let languages: BTreeSet<&String> = table.values().collect();

    let documents = Path::new(FIXTURES).join("documents");
    let covered: BTreeSet<String> = std::fs::read_dir(&documents)
        .expect("the corpus documents")
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let extension = name.rsplit_once('.')?.1.to_lowercase();
            table.get(&extension).cloned()
        })
        .collect();

    let uncovered: Vec<&&String> = languages
        .iter()
        .filter(|language| !covered.contains(**language))
        .collect();
    assert!(
        uncovered.is_empty(),
        "these languages are advertised and no corpus document exercises them: {uncovered:?}"
    );
}
