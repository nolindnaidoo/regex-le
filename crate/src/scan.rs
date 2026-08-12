//! One file end to end — the only path either surface calls.
//!
//! `cli.rs` and `mcp/` both come through here, so a rule can only be
//! written once. `tests/contracts.rs` asserts the two agree.

use std::path::PathBuf;

use serde::Serialize;

use crate::detect::extract::{Pattern, extract_patterns};
use crate::detect::format::{Language, resolve_language};
use crate::detect::redos::Severity;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct Diagnostic {
    pub(crate) severity: String,
    pub(crate) code: String,
    pub(crate) message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub(crate) struct Summary {
    pub(crate) patterns: usize,
    pub(crate) findings: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct FileReport {
    pub(crate) file: String,
    pub(crate) patterns: Vec<Pattern>,
    pub(crate) diagnostics: Vec<Diagnostic>,
    pub(crate) summary: Summary,
}

impl FileReport {
    /// Whether this file looked like text and still could not be read —
    /// a permission error, or bytes that are not UTF-8.
    ///
    /// Reported rather than swallowed, because a report that quietly
    /// skipped a file would be claiming coverage it does not have. It
    /// does **not** fail the run on its own; `--strict` is there for a
    /// pipeline that wants zero tolerance. A binary file never gets
    /// here — `scan_file` returns nothing for one, because it was never
    /// a text candidate and exiting 2 on every repository with an icon
    /// in it made `--strict` unusable.
    pub(crate) fn was_skipped(&self) -> bool {
        self.diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "skipped")
    }

    /// Whether the scan of this file gave up part way. Unlike a skip
    /// this **does** fail the run: reporting no findings when a
    /// detector stopped early would overstate coverage, which is the
    /// one thing an audit tool must never do.
    pub(crate) fn is_incomplete(&self) -> bool {
        self.diagnostics
            .iter()
            .any(|diagnostic| diagnostic.severity == "error")
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ScanOptions {
    /// Fail at this verdict or worse.
    pub(crate) threshold: Severity,
    /// Report every pattern rather than only the ones at or above the
    /// threshold. The count that drives the exit code does not change.
    pub(crate) all: bool,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            threshold: Severity::Medium,
            all: false,
        }
    }
}

fn at_or_above(severity: Severity, threshold: Severity) -> bool {
    match threshold {
        Severity::High => severity == Severity::High,
        Severity::Medium => severity != Severity::Low,
        // Not offered as a threshold: a check that fires on every
        // pattern is a check nobody reads. Present so the match is
        // total, and it behaves as it reads.
        Severity::Low => true,
    }
}

/// How much of a file the binary test reads. Ripgrep's number: a file
/// that has made it 8 KB without a NUL byte is text as far as any tool
/// that greps it is concerned.
const BINARY_SNIFF_BYTES: usize = 8192;

/// Whether this is a binary file rather than a text file that failed to
/// be read. A NUL byte near the start is how ripgrep decides, and the
/// distinction matters: a PNG was never a text candidate, so calling it
/// a skipped file makes `--strict` exit 2 on every repository that has
/// an icon in it.
fn is_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(BINARY_SNIFF_BYTES).any(|byte| *byte == 0)
}

/// Scan one file, or `None` when it is binary.
///
/// `None` is not silence: the caller counts it and says how many files
/// were never text, so the reader still knows coverage was narrower than
/// the tree. What it is not is a per-file report line, and it does not
/// reach `--strict`.
pub(crate) fn scan_file(path: &PathBuf, options: ScanOptions) -> Option<FileReport> {
    let file = path.to_string_lossy().into_owned();
    // The extension is handed a language id by the editor; a walk has
    // only the name on disk, and an unrecognised one is not a refusal —
    // it means every form is scanned for.
    let language = resolve_language(None, Some(&file));
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) => return Some(skipped(file, &error.to_string())),
    };
    if is_binary(&bytes) {
        return None;
    }
    match String::from_utf8(bytes) {
        Ok(content) => Some(scan_content(without_bom(&content), file, language, options)),
        // Named rather than dropped: this one *looked* like text and
        // could not be read, and a file that vanishes from the report is
        // a file the reader believes was covered.
        Err(_) => Some(skipped(file, "not UTF-8 text")),
    }
}

pub(crate) fn scan_content(
    content: &str,
    file: String,
    language: Option<Language>,
    options: ScanOptions,
) -> FileReport {
    let (patterns, diagnostics) = match extract_patterns(content, language) {
        Ok(patterns) => (patterns, Vec::new()),
        // A refusal, not a clean result: reporting no patterns when the
        // scan gave up would overstate coverage.
        Err(message) => (
            Vec::new(),
            vec![Diagnostic {
                severity: "error".to_string(),
                code: "incomplete".to_string(),
                message,
            }],
        ),
    };

    let findings = patterns
        .iter()
        .filter(|pattern| at_or_above(pattern.redos.severity, options.threshold))
        .count();
    let reported: Vec<Pattern> = if options.all {
        patterns
    } else {
        patterns
            .into_iter()
            .filter(|pattern| at_or_above(pattern.redos.severity, options.threshold))
            .collect()
    };

    FileReport {
        file,
        summary: Summary {
            patterns: reported.len(),
            findings,
        },
        patterns: reported,
        diagnostics,
    }
}

/// 0 nothing vulnerable, 1 at least one finding, 2 could not answer.
pub(crate) fn exit_code(reports: &[FileReport], strict: bool) -> u8 {
    // A scan that gave up part way always fails: it would otherwise
    // report "nothing found" for a file it never finished reading.
    if reports.iter().any(FileReport::is_incomplete) {
        return 2;
    }
    if strict && reports.iter().any(FileReport::was_skipped) {
        return 2;
    }
    u8::from(reports.iter().any(|report| report.summary.findings > 0))
}

pub(crate) fn describe(report: &FileReport, pattern: &Pattern) -> String {
    format!(
        "{}:{}:{}  /{}/{}  [{}] {}",
        report.file,
        pattern.line,
        pattern.column,
        pattern.pattern,
        pattern.flags,
        severity_name(pattern.redos.severity),
        pattern.redos.reason
    )
}

pub(crate) fn severity_name(severity: Severity) -> &'static str {
    match severity {
        Severity::Low => "low",
        Severity::Medium => "medium",
        Severity::High => "high",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempTree;

    #[test]
    fn a_clean_file_exits_zero() {
        let report = scan_content(
            "const re = /[a-z]+/;",
            "a.js".into(),
            Some(Language::JavaScript),
            ScanOptions::default(),
        );
        assert_eq!(report.summary.findings, 0);
        assert_eq!(exit_code(&[report], false), 0);
    }

    #[test]
    fn a_vulnerable_pattern_is_a_finding() {
        let report = scan_content(
            "const re = /(a+)+/;",
            "a.js".into(),
            Some(Language::JavaScript),
            ScanOptions::default(),
        );
        assert_eq!(report.summary.findings, 1);
        assert_eq!(exit_code(&[report], false), 1);
    }

    /// By default only the patterns at or above the threshold are
    /// reported — the clean ones are noise in a lint.
    #[test]
    fn only_findings_are_reported_unless_all_is_asked_for() {
        let content = "const a = /[a-z]+/;\nconst b = /(a+)+/;\n";
        let lint = scan_content(
            content,
            "a.js".into(),
            Some(Language::JavaScript),
            ScanOptions::default(),
        );
        assert_eq!(lint.patterns.len(), 1);

        let everything = scan_content(
            content,
            "a.js".into(),
            Some(Language::JavaScript),
            ScanOptions {
                all: true,
                ..ScanOptions::default()
            },
        );
        assert_eq!(everything.patterns.len(), 2);
        assert_eq!(
            everything.summary.findings, 1,
            "reporting more does not find more"
        );
    }

    #[test]
    fn the_threshold_narrows_what_counts() {
        let content = "const re = /(a|a)*/;";
        let medium = scan_content(
            content,
            "a.js".into(),
            Some(Language::JavaScript),
            ScanOptions::default(),
        );
        assert_eq!(medium.summary.findings, 1);
        let high = scan_content(
            content,
            "a.js".into(),
            Some(Language::JavaScript),
            ScanOptions {
                threshold: Severity::High,
                ..ScanOptions::default()
            },
        );
        assert_eq!(high.summary.findings, 0);
    }

    /// Changed deliberately: a PNG was never a text candidate, so it is
    /// not a file that failed to be read. Reporting it as one gave
    /// `--strict` a reason to exit 2 on every repository with an icon in
    /// it, which made the flag useless. It gets no report line; the
    /// caller counts it and says how many.
    #[test]
    fn a_binary_file_is_counted_rather_than_reported() {
        let tree = TempTree::new("scan-binary");
        let file = tree.path().join("logo.png");
        std::fs::write(&file, [0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a]).expect("a file");
        assert!(scan_file(&file, ScanOptions::default()).is_none());
    }

    /// The distinction the NUL byte draws. Both of these are bytes a
    /// `String` cannot hold; only one of them was ever meant to be text.
    #[test]
    fn invalid_utf8_without_a_nul_byte_is_still_a_text_file() {
        let tree = TempTree::new("scan-latin1");
        let file = tree.path().join("notes.txt");
        std::fs::write(&file, [b'c', b'a', b'f', 0xe9]).expect("a file");
        let report = scan_file(&file, ScanOptions::default()).expect("a report");
        assert!(report.was_skipped());
        assert_eq!(report.diagnostics[0].message, "not UTF-8 text");
        assert_eq!(exit_code(&[report], true), 2, "--strict still sees it");
    }

    #[test]
    fn a_nul_byte_past_the_first_pages_is_not_sniffed() {
        let mut bytes = vec![b'a'; BINARY_SNIFF_BYTES];
        bytes.push(0);
        assert!(!is_binary(&bytes));
        assert!(is_binary(&[b'a', 0]));
    }

    /// Changed deliberately: a file that could not be read is reported
    /// and does not fail the run, because every repository has one and
    /// exiting 2 on it meant the tool never got run in CI at all.
    #[test]
    fn an_unreadable_file_is_reported_and_does_not_end_the_run() {
        let tree = TempTree::new("scan-unreadable");
        let report =
            scan_file(&tree.path().join("gone.js"), ScanOptions::default()).expect("a report");
        assert!(report.was_skipped());
        assert_eq!(report.diagnostics[0].severity, "warning");
        assert_eq!(exit_code(std::slice::from_ref(&report), false), 0);
        assert_eq!(exit_code(&[report], true), 2, "--strict is opt-in");
    }

    #[test]
    fn nothing_to_scan_exits_clear() {
        assert_eq!(exit_code(&[], false), 0);
    }

    #[test]
    fn the_human_line_carries_the_pattern_and_its_verdict() {
        let report = scan_content(
            "const re = /(a+)+/g;",
            "a.js".into(),
            Some(Language::JavaScript),
            ScanOptions::default(),
        );
        let line = describe(&report, &report.patterns[0]);
        assert!(line.contains("a.js:1:12"), "{line}");
        assert!(line.contains("/(a+)+/g"), "{line}");
        assert!(line.contains("[high]"), "{line}");
    }
}

/// The report for a file that was not read: named, warned about, and
/// not a failure by itself.
fn skipped(file: String, reason: &str) -> FileReport {
    FileReport {
        file,
        patterns: Vec::new(),
        diagnostics: vec![Diagnostic {
            severity: "warning".to_string(),
            code: "skipped".to_string(),
            message: reason.to_string(),
        }],
        summary: Summary {
            patterns: 0,
            findings: 0,
        },
    }
}

/// Drop a leading byte-order mark.
///
/// No editor shows it and VS Code strips it before the extension ever
/// sees a document, so without this the two frontends read the same file
/// differently the moment anything on Windows saves it — Notepad, Excel,
/// a PowerShell redirect. Three invisible bytes shift every column on
/// the first line, and in a structured format they can lose the
/// document entirely.
pub(crate) fn without_bom(content: &str) -> &str {
    content.strip_prefix('\u{feff}').unwrap_or(content)
}

#[cfg(test)]
mod hazards {
    use super::*;

    /// Three invisible bytes that Notepad, Excel and a PowerShell
    /// redirect all add, and that VS Code strips before the extension
    /// ever sees a document — so without this the two frontends read
    /// the same file differently.
    #[test]
    fn a_byte_order_mark_is_not_part_of_the_document() {
        assert_eq!(without_bom("\u{feff}abc"), "abc");
        assert_eq!(without_bom("abc"), "abc");
        // Only a leading one: elsewhere it is a zero-width no-break
        // space and belongs to the text.
        assert_eq!(without_bom("a\u{feff}b"), "a\u{feff}b");
    }
}
