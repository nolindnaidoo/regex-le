//! A wall-clock ceiling on a fixed tree, and a linearity check beside it.
//!
//! secrets-le was fifty times slower than its siblings for a release and
//! nobody noticed, because nothing measured it. This crate went the
//! other way this release — 183 false positives stopped being computed
//! on a real tree — and an unmeasured improvement is one regression away
//! from being gone again.
//!
//! **The tree is generated from a fixed seed, not checked in.** Five
//! hundred files of realistic source is a megabyte of repository for
//! something no human reads; the generator below is deterministic, so
//! the tree is the same on every machine and every run.
//!
//! Timing a debug binary measures the compiler rather than the scan, so
//! this refuses to run under one and says so by name. CI runs it with
//! `--release`.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

const BINARY: &str = env!("CARGO_BIN_EXE_regex-le");
static COUNTER: AtomicUsize = AtomicUsize::new(0);

/// The ceiling, at ten times the local measurement.
///
/// Measured 2026-08-12 on an Apple M-series laptop (macOS 15, release
/// build): **47 ms** for the 500-file tree below, across six runs
/// spanning 46–58 ms. Ten times that is loose enough that a cold shared
/// runner does not flake it and tight enough to catch an order of
/// magnitude, which is the only size of regression worth a red build.
const CEILING: Duration = Duration::from_millis(470);

/// Four times the tree must not cost more than six times the time. The
/// slack is for the fixed cost of starting a process and walking a
/// deeper directory; anything quadratic blows straight through it.
const LINEAR_SLACK: u32 = 6;

const FILES: usize = 500;

struct Tree {
    root: PathBuf,
}

impl Tree {
    fn new(name: &str) -> Self {
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "regex-le-budget-{name}-{}-{unique}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("a temporary directory");
        Self {
            root: std::fs::canonicalize(&root).expect("a canonical directory"),
        }
    }

    fn path(&self) -> &Path {
        &self.root
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// One file per language, each holding a pattern worth finding, a
/// pattern worth ignoring, and a line that must not read as either.
const SOURCES: [(&str, &str); 10] = [
    (
        "js",
        "const email = /(\\w+)+@/g;\nconst ok = /[a-z]+/;\nconst ratio = total / count;\n",
    ),
    (
        "ts",
        "const alt: RegExp = new RegExp('(a|ab)+', 'i');\nconst plain = /^[a-z]{2,8}$/;\n",
    ),
    (
        "py",
        "P = re.compile(r\"(?P<name>\\w+)+@\")\nQ = re.search(r'^[a-z]+$', s)\nROOT = \"/var/log/app.log\"\n",
    ),
    (
        "rs",
        "let bad = Regex::new(r\"(?i)([a-z]+)*\").unwrap();\nlet ok = Regex::new(r\"^\\d{4}$\").unwrap();\n",
    ),
    (
        "go",
        "var bad = regexp.MustCompile(`(?i)(a+)+`)\nvar ok = regexp.MustCompile(`^[a-z]+$`)\n",
    ),
    (
        "java",
        "Pattern bad = Pattern.compile(\"([a-z]+)*\");\nPattern ok = Pattern.compile(\"^\\\\d+$\");\n",
    ),
    ("rb", "BAD = /(a|a)*/\nOK = /[0-9]+/\nratio = a / b / 2\n"),
    (
        "php",
        "preg_match('#(a+)+#i', $s);\npreg_replace('~^[a-z]+$~', '', $s);\n",
    ),
    (
        "cs",
        "var bad = new Regex(@\"(\\d+)+\");\nvar ok = Regex.IsMatch(input, @\"^[a-z]+$\");\n",
    ),
    (
        "txt",
        "see https://example.com/docs\nratio = total / count / 2\nnothing here is a pattern\n",
    ),
];

/// A deterministic tree: no clock, no randomness, the same bytes on
/// every machine.
fn build(tree: &Tree, copies: usize) {
    for copy in 0..copies {
        for index in 0..FILES {
            let (extension, body) = SOURCES[index % SOURCES.len()];
            let directory = tree
                .path()
                .join(format!("copy{copy:02}"))
                .join(format!("pkg{:02}", index % 20));
            std::fs::create_dir_all(&directory).expect("a directory");
            let mut contents = String::with_capacity(body.len() * 12);
            for line in 0..12 {
                use std::fmt::Write as _;
                contents.push_str(body);
                writeln!(contents, "// filler {index} {line}").expect("a string");
            }
            std::fs::write(
                directory.join(format!("file{index:03}.{extension}")),
                contents,
            )
            .expect("a file");
        }
    }
}

/// One scan, timed. The binary is run once untimed first: a cold runner
/// pays to page the executable in, and that cost belongs to the machine
/// rather than to the scan.
fn scan(root: &Path) -> Duration {
    let run = || {
        let status = Command::new(BINARY)
            .args(["--all", &root.to_string_lossy()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("the binary runs");
        assert!(
            status.code().is_some_and(|code| (0..=2).contains(&code)),
            "the scan did not answer: {status}"
        );
    };
    run();
    let started = Instant::now();
    run();
    started.elapsed()
}

fn measuring() -> bool {
    if cfg!(debug_assertions) {
        eprintln!(
            "SKIPPED the scan budget: a debug binary measures the compiler, not the scan. \
             Run `cargo test --release --test budget`."
        );
        return false;
    }
    true
}

#[test]
fn the_scan_stays_inside_its_budget() {
    if !measuring() {
        return;
    }
    let tree = Tree::new("budget");
    build(&tree, 1);

    let elapsed = scan(tree.path());
    // Printed rather than only asserted: the number in CEILING's comment
    // came from a run like this one, and the next person to revisit it
    // should be able to read what this machine actually did.
    eprintln!("{FILES} files scanned in {elapsed:?} (ceiling {CEILING:?})");
    assert!(
        elapsed <= CEILING,
        "{FILES} files took {elapsed:?}, over the {CEILING:?} ceiling. That is an order of \
         magnitude, not a slow runner — something in the scan stopped being linear."
    );
}

/// Four times the tree, no more than six times the time. This is the
/// check that catches the quadratic class directly: a per-file cost that
/// grows with the tree shows up here and nowhere else.
#[test]
fn four_times_the_tree_is_not_more_than_six_times_the_work() {
    if !measuring() {
        return;
    }
    let one = Tree::new("linear-1");
    build(&one, 1);
    let four = Tree::new("linear-4");
    build(&four, 4);

    let small = scan(one.path());
    let large = scan(four.path());
    eprintln!(
        "{FILES} files in {small:?}, {} files in {large:?}",
        FILES * 4
    );
    assert!(
        large <= small * LINEAR_SLACK,
        "{FILES} files took {small:?} and {} took {large:?}, over {LINEAR_SLACK}×. \
         The scan is not linear in the size of the tree.",
        FILES * 4
    );
}
