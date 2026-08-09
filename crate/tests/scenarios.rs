//! The tier that needs a document far larger than any editor opens.
//!
//! Gated behind `REGEX_LE_SCENARIOS` and run by CI. Nothing here
//! substitutes for the unit tests, which run everywhere on every push.
//!
//! **A skipped scenario is never reported as a pass.**

use std::io::Write as _;

fn enabled(name: &str) -> bool {
    if std::env::var_os("REGEX_LE_SCENARIOS").is_some() {
        return true;
    }
    eprintln!("SKIPPED {name}: set REGEX_LE_SCENARIOS to run it");
    false
}

fn scan(content: &str) -> serde_json::Value {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_regex-le"))
        .args(["--stdin", "--all"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            child
                .stdin
                .as_mut()
                .expect("stdin")
                .write_all(content.as_bytes())?;
            child.wait_with_output()
        })
        .expect("the binary runs");
    serde_json::from_slice(&output.stdout).expect("stdout carries JSON")
}

/// A minified bundle is one very long line holding thousands of
/// candidate slashes, and deciding whether each one opens a regex means
/// looking at the text before it. Copying the document to do that is
/// quadratic and finishes in an editor because an editor never opens a
/// file this shape.
#[test]
fn a_single_long_line_completes() {
    if !enabled("a_single_long_line_completes") {
        return;
    }
    let content = "const a = /x/g; const b = total / count; ".repeat(20_000);
    let report = scan(&content);
    assert_eq!(
        report["patterns"].as_array().expect("patterns").len(),
        1,
        "one pattern-and-flags pair, collapsed to its first occurrence"
    );
    assert_eq!(report["summary"]["findings"], 0);
}

/// Distinct patterns are not collapsed, so this is the case where the
/// report grows with the input rather than staying at one line.
#[test]
fn many_distinct_patterns_complete() {
    if !enabled("many_distinct_patterns_complete") {
        return;
    }
    let mut content = String::new();
    for index in 0..20_000 {
        use std::fmt::Write as _;
        writeln!(content, "const p{index} = /a{index}+/g;").expect("a string");
    }
    let report = scan(&content);
    assert_eq!(
        report["patterns"].as_array().expect("patterns").len(),
        20_000
    );
}

/// The `ReDoS` scan walks the pattern *text* with a stack, so a pattern
/// that is itself enormous must not become the slow case — a generated
/// validator is the real-world shape.
#[test]
fn an_enormous_pattern_completes() {
    if !enabled("an_enormous_pattern_completes") {
        return;
    }
    let body: String = (0..20_000).map(|_| "(a)").collect();
    let report = scan(&format!("const p = /{body}+/;\n"));
    assert_eq!(report["patterns"].as_array().expect("patterns").len(), 1);
}
