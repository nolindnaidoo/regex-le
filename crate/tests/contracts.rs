//! The exit codes and the stdout contract, driven against the built
//! binary.
//!
//! These are the API: a shell branches on the exit code and parses
//! stdout, so both are pinned here rather than inferred from unit tests
//! of the functions behind them. Nothing here needs a network or a
//! privileged filesystem operation, so it runs everywhere on every push.
//!
//! A new refusal adds its case here.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

const BINARY: &str = env!("CARGO_BIN_EXE_regex-le");
static COUNTER: AtomicUsize = AtomicUsize::new(0);

struct Tree {
    root: PathBuf,
}

impl Tree {
    fn new(name: &str) -> Self {
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "regex-le-contract-{name}-{}-{unique}",
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
    code: i32,
    stdout: String,
    stderr: String,
}

fn run(args: &[&str]) -> Run {
    let output = Command::new(BINARY)
        .args(args)
        .output()
        .expect("the binary runs");
    Run {
        code: output.status.code().expect("an exit code"),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    }
}

/// Every line of stdout, parsed. Doubles as the assertion that stdout
/// is JSON Lines and nothing else — a stray human message there would
/// fail to parse.
fn reports(run: &Run) -> Vec<serde_json::Value> {
    run.stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("stdout carries only JSON"))
        .collect()
}

fn findings(run: &Run) -> u64 {
    reports(run)
        .iter()
        .filter_map(|report| report["summary"]["findings"].as_u64())
        .sum()
}

/// One exponential shape, one overlapping alternation, one pattern that
/// is fine, and one slash that is a division.
fn source_tree(name: &str) -> Tree {
    let tree = Tree::new(name);
    tree.write(
        "src/validate.js",
        "const email = /(\\w+)+@/g;\nconst ratio = total / count;\n",
    );
    tree.write(
        "src/parse.ts",
        "const alt = /(a|a)*b/;\nconst ok = /[a-z]+/;\n",
    );
    tree.write("README.md", "See https://example.com/docs for more.\n");
    tree
}

#[test]
fn a_vulnerable_pattern_exits_one() {
    let tree = source_tree("findings");
    let run = run(&[&tree.path().to_string_lossy()]);
    assert_eq!(run.code, 1, "{}", run.stderr);
    assert_eq!(
        findings(&run),
        2,
        "the division and the URL are not patterns"
    );
}

#[test]
fn a_clean_tree_exits_zero() {
    let tree = Tree::new("clean");
    tree.write("src/a.js", "const ok = /[a-z]+/;\n");
    let run = run(&[&tree.path().to_string_lossy()]);
    assert_eq!(run.code, 0, "{}", run.stderr);
    assert!(run.stderr.contains("0 findings"), "{}", run.stderr);
}

#[test]
fn an_unreadable_input_exits_two() {
    assert_eq!(run(&["/no/such/place-xyz"]).code, 2);
}

/// A PNG is not a text file that failed to be read — it was never a text
/// candidate. Reporting it as skipped made `--strict` exit 2 on every
/// repository with an icon in it, which is a flag nobody can use.
#[test]
fn a_binary_file_is_counted_and_leaves_strict_alone() {
    let tree = Tree::new("binary");
    tree.write("src/a.js", "const ok = /[a-z]+/;\n");
    std::fs::write(
        tree.path().join("logo.png"),
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00],
    )
    .expect("a file");

    let run = run(&["--strict", &tree.path().to_string_lossy()]);
    assert_eq!(run.code, 0, "{}", run.stderr);
    assert_eq!(reports(&run).len(), 1, "the PNG gets no report line");
    assert!(!run.stdout.contains("logo.png"), "{}", run.stdout);
    // Counted, not silent: the reader still learns coverage was
    // narrower than the tree.
    assert!(
        run.stderr.contains("1 binary file skipped"),
        "{}",
        run.stderr
    );
}

/// The distinction the NUL byte draws: this one looked like text, could
/// not be read, and still fails `--strict`.
#[test]
fn a_text_file_that_cannot_be_read_still_fails_strict() {
    let tree = Tree::new("latin1");
    std::fs::write(tree.path().join("notes.txt"), [b'c', b'a', b'f', 0xe9]).expect("a file");
    let run = run(&["--strict", &tree.path().to_string_lossy()]);
    assert_eq!(run.code, 2, "{}", run.stderr);
    assert!(run.stderr.contains("not UTF-8 text"), "{}", run.stderr);
}

#[test]
fn an_unknown_flag_exits_two_and_names_itself() {
    let tree = source_tree("badflag");
    let run = run(&["--sever", &tree.path().to_string_lossy()]);
    assert_eq!(run.code, 2);
    assert!(run.stderr.contains("--sever"), "{}", run.stderr);
    assert!(run.stdout.is_empty(), "a refusal writes no report");
}

/// **`--severity` selects nothing today, and this pins that.**
///
/// A verdict is now reached by demonstration: either an input was found
/// that drives the pattern into exponential backtracking, or none was.
/// That answers `high` or `low` and never `medium`, so `high` and
/// `medium` select the same set. The flag stays because removing it would
/// break a shell that passes it, and `low` is still refused — see
/// `a_low_threshold_is_refused_with_its_reason`.
///
/// If a future verdict lands between the two, this test is what tells
/// you the flag has become load-bearing again.
#[test]
fn the_threshold_is_accepted_and_currently_selects_the_same_set() {
    let tree = Tree::new("threshold");
    tree.write("src/a.js", "const alt = /(a|a)*b/;\n");
    let path = tree.path().to_string_lossy().to_string();
    assert_eq!(run(&[&path]).code, 1, "medium is the default");
    assert_eq!(run(&["--severity", "high", &path]).code, 1);
    assert_eq!(run(&["--severity", "medium", &path]).code, 1);
}

/// Reporting more patterns does not find more of them.
#[test]
fn all_widens_the_report_but_not_the_verdict() {
    let tree = Tree::new("all");
    tree.write("src/a.js", "const a = /[a-z]+/;\nconst b = /(a+)+b/;\n");
    let path = tree.path().to_string_lossy().to_string();

    let lint = run(&[&path]);
    assert_eq!(
        reports(&lint)[0]["patterns"]
            .as_array()
            .expect("a list")
            .len(),
        1
    );

    let everything = run(&["--all", &path]);
    assert_eq!(
        reports(&everything)[0]["patterns"]
            .as_array()
            .expect("a list")
            .len(),
        2
    );
    assert_eq!(findings(&everything), findings(&lint));
    assert_eq!(everything.code, lint.code);
}

/// `low` is refused rather than silently accepted, and the refusal says
/// why instead of pretending the word is unknown.
#[test]
fn a_low_threshold_is_refused_with_its_reason() {
    let tree = source_tree("low");
    let run = run(&["--severity", "low", &tree.path().to_string_lossy()]);
    assert_eq!(run.code, 2);
    assert!(run.stderr.contains("--all"), "{}", run.stderr);
}

/// The tester half is not here. If any of these is ever accepted, the
/// line this crate was drawn along has moved.
#[test]
fn no_flag_offers_to_run_a_pattern() {
    let tree = source_tree("notester");
    for attempt in ["--test", "--match", "--input", "--timeout", "--fix"] {
        assert_eq!(
            run(&[attempt, &tree.path().to_string_lossy()]).code,
            2,
            "{attempt} was accepted"
        );
    }
}

#[test]
fn version_and_help_exit_clear() {
    let version = run(&["--version"]);
    assert_eq!(version.code, 0);
    assert!(version.stdout.contains("regex-le"));
    let help = run(&["--help"]);
    assert_eq!(help.code, 0);
    assert!(help.stdout.contains("usage: regex-le"));
    assert!(
        help.stdout.contains("cannot prove"),
        "the scope of the answer is stated"
    );
}

#[test]
fn stdout_carries_only_reports_and_stderr_only_the_summary() {
    let tree = source_tree("streams");
    let run = run(&[&tree.path().to_string_lossy()]);
    assert!(!reports(&run).is_empty());
    assert!(!run.stderr.contains('{'), "{}", run.stderr);
    assert!(run.stderr.contains("findings in"), "{}", run.stderr);
}

#[test]
fn a_document_on_stdin_is_scanned() {
    let mut child = Command::new(BINARY)
        .args(["--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the binary runs");
    child
        .stdin
        .as_mut()
        .expect("stdin")
        .write_all(b"const re = /(a+)+b/g;\n")
        .expect("written");
    let output = child.wait_with_output().expect("finishes");
    assert_eq!(output.status.code(), Some(1));
    let report: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("stdout carries JSON");
    assert_eq!(report["file"], "<stdin>");
    assert_eq!(report["patterns"][0]["pattern"], "(a+)+b");
    assert_eq!(report["patterns"][0]["redos"]["severity"], "high");
}

/// A byte-order mark is three invisible bytes a Windows editor adds, and
/// it went the same way for a file read and not for a pipe — so
/// `regex-le x.js` said column 12 and the same bytes on stdin said 13.
/// One document, one answer, whichever way it arrives.
#[test]
fn a_byte_order_mark_on_stdin_does_not_move_the_column() {
    let scan = |bytes: &[u8]| -> serde_json::Value {
        let mut child = Command::new(BINARY)
            .args(["--stdin", "--all"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("the binary runs");
        child
            .stdin
            .as_mut()
            .expect("stdin")
            .write_all(bytes)
            .expect("written");
        let output = child.wait_with_output().expect("finishes");
        serde_json::from_slice(&output.stdout).expect("stdout carries JSON")
    };

    let plain = scan(b"const re = /(a+)+/g;\n");
    let marked = scan("\u{feff}const re = /(a+)+/g;\n".as_bytes());
    assert_eq!(plain["patterns"], marked["patterns"]);
    assert_eq!(marked["patterns"][0]["column"], 12);
}

#[test]
fn stdin_with_file_arguments_exits_two() {
    let tree = source_tree("stdin-and-files");
    assert_eq!(
        run(&["--stdin", &tree.path().to_string_lossy()]).code,
        2,
        "one input or the other, not both"
    );
}

/// **The cross-surface contract.** Both surfaces call one entry point,
/// so they must answer identically for the same tree.
#[test]
fn the_cli_and_the_mcp_server_report_the_same_thing() {
    let tree = source_tree("agreement");
    let cli = run(&[&tree.path().to_string_lossy()]);
    let from_cli = reports(&cli);

    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "regex_le_lint",
            "arguments": { "path": tree.path().to_string_lossy() },
        },
    });
    let mut child = Command::new(BINARY)
        .arg("mcp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the server starts");
    writeln!(child.stdin.as_mut().expect("stdin"), "{request}").expect("written");
    let output = child.wait_with_output().expect("finishes");
    let response: serde_json::Value = serde_json::from_slice(
        output
            .stdout
            .split(|byte| *byte == b'\n')
            .next()
            .expect("a line"),
    )
    .expect("the reply is JSON");

    let from_mcp = response["result"]["structuredContent"]["data"]["reports"]
        .as_array()
        .expect("reports")
        .clone();
    assert_eq!(from_mcp, from_cli, "the two surfaces disagree");
}

/// **The detector against measured truth, not against its own rule.**
///
/// `fixtures/redos-truth.json` records, per pattern, whether it actually
/// backtracks — established by running it against adversarial input with
/// a timeout (`scripts/measure-redos.py`), never by reading the rule.
/// `reportedAt0_2_2` is what this detector said when the file was made.
///
/// This is a characterisation test: it asserts the detector still
/// answers what that file records, so any change to the rule shows up as
/// a diff with a measured verdict beside it. The numbers it pins are
/// **not** the target — at the time of writing they are 6 correct out of
/// 20, with 5 patterns that backtrack reported clean and 9 that do not
/// reported `high`. Moving them is the point; moving them silently is
/// what this prevents.
#[test]
fn the_detector_is_measured_against_ground_truth() {
    const TRUTH: &str = include_str!("../fixtures/redos-truth.json");
    let truth: serde_json::Value = serde_json::from_str(TRUTH).expect("valid JSON");
    let cases = truth["cases"].as_array().expect("cases");
    assert!(!cases.is_empty(), "the corpus is empty");

    let tree = Tree::new("redos-truth");
    let (mut agree, mut misses, mut alarms) = (0, 0, 0);
    for case in cases {
        let pattern = case["pattern"].as_str().expect("a pattern");
        let recorded = case["reported"].as_str().expect("a verdict");
        let file = tree.write("probe.js", &format!("const r = /{pattern}/;\n"));
        let run = run(&["--all", &file.to_string_lossy()]);
        let reports = reports(&run);
        let severity = reports
            .first()
            .and_then(|report| report["patterns"][0]["redos"]["severity"].as_str())
            .unwrap_or("none");
        assert_eq!(
            severity, recorded,
            "the detector changed its answer for {pattern} without the corpus being updated"
        );

        let flagged = matches!(severity, "high" | "medium");
        match (case["measured"] == "exponential", flagged) {
            (true, true) | (false, false) => agree += 1,
            (true, false) => misses += 1,
            (false, true) => alarms += 1,
        }
    }
    assert_eq!(
        (agree, misses, alarms),
        (20, 0, 0),
        "the detector's accuracy moved; update the corpus deliberately"
    );
}
