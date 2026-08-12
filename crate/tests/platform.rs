//! Behaviour that differs by operating system, asserted rather than
//! hoped.
//!
//! Each of these was a real release somewhere in this family: report
//! paths that carried `\` on Windows for a version, a suite that read the
//! environment's clock, a walk that reported one file twice on a
//! case-insensitive filesystem, and a stdin test that raced the refusal
//! it was asserting. None of them is visible on one platform, which is
//! why this file runs on all three.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

const BINARY: &str = env!("CARGO_BIN_EXE_regex-le");
static COUNTER: AtomicUsize = AtomicUsize::new(0);

const FINDING: &str = "const email = /(\\w+)+@/g;\n";

struct Tree {
    root: PathBuf,
}

impl Tree {
    fn new(name: &str) -> Self {
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "regex-le-platform-{name}-{}-{unique}",
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

    fn write(&self, relative: &str, contents: &str) -> PathBuf {
        let target = self.root.join(relative);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).expect("a parent directory");
        }
        std::fs::write(&target, contents).expect("a file");
        target
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

struct Run {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

fn run(args: &[&str]) -> Run {
    run_with_timezone(args, Some("UTC"))
}

/// The binary, with `TZ` set to a value or removed from the environment
/// entirely.
fn run_with_timezone(args: &[&str], timezone: Option<&str>) -> Run {
    let mut command = Command::new(BINARY);
    command.args(args).stdin(Stdio::null());
    match timezone {
        Some(value) => command.env("TZ", value),
        None => command.env_remove("TZ"),
    };
    let output = command.output().expect("the binary runs");
    Run {
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    }
}

fn reports(outcome: &Run) -> Vec<serde_json::Value> {
    outcome
        .stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("stdout carries only JSON"))
        .collect()
}

fn files(outcome: &Run) -> Vec<String> {
    reports(outcome)
        .iter()
        .map(|report| {
            report["file"]
                .as_str()
                .expect("a report names its file")
                .to_string()
        })
        .collect()
}

/// The `file:line:column` half of a human line on stderr.
///
/// `scan::describe` writes the location, two spaces, then the pattern
/// itself — and a pattern is regex source, so the backslash in `\w`
/// belongs to it. Only the half that names a place is a path.
fn location(line: &str) -> &str {
    line.split("  ").next().unwrap_or(line)
}

/// SPEC.md's output contract writes `src/validate.ts`. A Windows path
/// carries `\`, and a sibling in this family shipped a release writing
/// those into its reports — so the same tree scanned on two machines
/// produced two reports that could not be diffed against each other.
/// stderr is a projection of the same field and follows it.
///
/// The tree is built with ordinary names on purpose: a backslash is a
/// legal character in a POSIX filename, so a file called `a\b.js` would
/// make this assertion wrong rather than the code.
///
/// The first assertion is the guard against a vacuous pass. On a
/// platform whose separator is `\`, the path handed to the binary
/// *contains* backslashes — so if the rewrite were removed, the report
/// would carry them and the rest of this test would fail. Without that
/// check the whole test passes on Windows even with the code wrong,
/// which is how a sibling shipped it.
#[test]
fn every_path_in_the_report_uses_a_forward_slash() {
    let tree = Tree::new("separators");
    tree.write("src/deep/validate.js", FINDING);
    tree.write("src/parse.ts", FINDING);
    tree.write("README.md", "nothing here\n");

    let root = tree.path().to_string_lossy().to_string();
    let separator = std::path::MAIN_SEPARATOR;
    assert!(
        root.contains(separator),
        "the tree has no separator in it, so this test asserts nothing"
    );
    if separator == '\\' {
        assert!(
            root.contains('\\'),
            "the input path carries no backslash, so the rewrite is untested here"
        );
    } else {
        eprintln!(
            "NOTE: this platform separates with {separator:?}, so the rewrite is exercised \
             by scan.rs's own unit test rather than here"
        );
    }

    let outcome = run(&["--all", &root]);
    let named = files(&outcome);
    assert_eq!(named.len(), 3, "{}", outcome.stderr);
    for file in &named {
        assert!(!file.contains('\\'), "{file} carries a backslash");
        assert!(file.contains('/'), "{file} is not spelled with separators");
    }
    assert!(
        named
            .iter()
            .any(|file| file.ends_with("src/deep/validate.js")),
        "{named:?}"
    );

    // stderr restates the same paths, and a reader diffing two machines'
    // logs is in the same position as one diffing their reports. Only
    // the path half of each line is checked: the pattern half is regex
    // source, where `\w` is a backslash that belongs there.
    for line in outcome.stderr.lines() {
        assert!(
            !location(line).contains('\\'),
            "a human line spells its path with a backslash: {line}"
        );
    }
    assert!(
        outcome.stderr.contains("src/deep/validate.js:1:"),
        "the human line names the file:\n{}",
        outcome.stderr
    );

    // A refusal names its path the same way.
    let missing = run(&["--all", &format!("{root}/nope")]);
    assert_eq!(missing.code, Some(2));
    for line in missing.stderr.lines() {
        assert!(
            !location(line).contains('\\'),
            "a refusal spells its path with a backslash: {line}"
        );
    }
}

/// Nothing in the answer may come from the clock, and Windows ignores
/// `TZ` entirely — so a suite that depended on it would be green on two
/// platforms and red on the third for a reason nobody could reproduce.
/// The whole suite is run twice by the workflow; this pins the binary's
/// own output.
#[test]
fn the_answer_does_not_depend_on_the_timezone() {
    let tree = Tree::new("timezone");
    tree.write("src/a.js", FINDING);
    tree.write("src/b.py", "P = re.compile(r\"(?P<w>\\w+)+@\")\n");
    let root = tree.path().to_string_lossy().to_string();

    let utc = run_with_timezone(&["--all", &root], Some("UTC"));
    let tokyo = run_with_timezone(&["--all", &root], Some("Asia/Tokyo"));
    let absent = run_with_timezone(&["--all", &root], None);

    assert_eq!(utc.stdout, absent.stdout, "TZ unset changed the report");
    assert_eq!(utc.stdout, tokyo.stdout, "a timezone changed the report");
    assert_eq!(utc.code, absent.code);
    assert_eq!(utc.code, tokyo.code);
}

/// `README.md` and `readme.md` are one file on macOS and Windows and two
/// on Linux. Either way the walk reports each file it found once: a
/// report line per entry, never a line per spelling.
#[test]
fn a_case_insensitive_filesystem_does_not_report_one_file_twice() {
    let tree = Tree::new("case");
    tree.write("README.md", FINDING);
    tree.write("readme.md", FINDING);

    let entries = std::fs::read_dir(tree.path())
        .expect("the tree is readable")
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .count();
    assert!(
        (1..=2).contains(&entries),
        "one entry on a case-insensitive filesystem, two on a case-sensitive one"
    );

    let outcome = run(&["--all", &tree.path().to_string_lossy()]);
    let mut named = files(&outcome);
    assert_eq!(named.len(), entries, "one report line per file on disk");
    named.sort();
    let before = named.len();
    named.dedup();
    assert_eq!(named.len(), before, "a file was reported twice");
}

/// `CON`, `PRN`, `AUX`, `NUL` and `COM1` are device names on Windows and
/// cannot be created there. The walk has to survive the *failure* to
/// create them, which is why nothing here asserts they exist.
#[test]
fn reserved_windows_filenames_do_not_stop_the_walk() {
    let tree = Tree::new("reserved");
    tree.write("ordinary.js", FINDING);

    let mut created = Vec::new();
    for name in ["CON", "PRN", "AUX", "NUL", "COM1"] {
        match std::fs::write(tree.path().join(name), FINDING) {
            Ok(()) => created.push(name),
            Err(error) => eprintln!("SKIPPED {name}: this platform refuses the name ({error})"),
        }
    }

    let outcome = run(&["--all", &tree.path().to_string_lossy()]);
    assert_eq!(outcome.code, Some(1), "{}", outcome.stderr);
    let named = files(&outcome);
    assert!(
        named.iter().any(|file| file.ends_with("ordinary.js")),
        "the ordinary file was lost: {named:?}"
    );
    assert_eq!(
        named.len(),
        created.len() + 1,
        "every name that was created is reported: {named:?}"
    );
}

/// The race that cost a red CI once: the child refuses before the write
/// finishes, the write fails with a broken pipe, and the test reports a
/// failure that has nothing to do with the code.
///
/// The exit code is the assertion. The write is not.
#[test]
fn a_child_that_refuses_immediately_is_judged_by_its_exit_code() {
    let tree = Tree::new("stdin-race");
    let file = tree.write("a.js", FINDING);

    // Reading stdin and naming files together is refused, so this child
    // exits before it has read a byte.
    let mut child = Command::new(BINARY)
        .args(["--stdin", &file.to_string_lossy()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the binary runs");

    // Deliberately unchecked: a broken pipe here is the child having
    // already answered, which is the thing being tested.
    let mut stdin = child.stdin.take().expect("stdin is piped");
    let _ = stdin.write_all(&vec![b'x'; 1024 * 1024]);
    drop(stdin);

    let output = child.wait_with_output().expect("finishes");
    assert_eq!(output.status.code(), Some(2));
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("stdin"),
        "the refusal names what it refused"
    );
}
