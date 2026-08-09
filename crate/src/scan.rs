//! One file end to end — the only path either surface calls.
//!
//! `cli.rs` and `mcp/` both come through here, so a rule can only be
//! written once. `tests/contracts.rs` asserts the two agree.

use std::path::PathBuf;

use serde::Serialize;

use crate::detect::extract::{Pattern, extract_patterns};
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
    pub(crate) fn is_unexamined(&self) -> bool {
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

pub(crate) fn scan_file(path: &PathBuf, options: ScanOptions) -> Option<FileReport> {
    let file = path.to_string_lossy().into_owned();
    match std::fs::read(path) {
        // A file that is not UTF-8 holds no source to read. Failing on
        // each would make the tool unusable in a repository full of
        // images.
        Ok(bytes) => String::from_utf8(bytes)
            .ok()
            .map(|content| scan_content(&content, file, options)),
        Err(error) => Some(FileReport {
            file,
            patterns: Vec::new(),
            diagnostics: vec![Diagnostic {
                severity: "error".to_string(),
                code: "unreadable".to_string(),
                message: format!("could not be read: {error}"),
            }],
            summary: Summary {
                patterns: 0,
                findings: 0,
            },
        }),
    }
}

pub(crate) fn scan_content(content: &str, file: String, options: ScanOptions) -> FileReport {
    let (patterns, diagnostics) = match extract_patterns(content) {
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
pub(crate) fn exit_code(reports: &[FileReport]) -> u8 {
    if reports.iter().any(FileReport::is_unexamined) {
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
            ScanOptions::default(),
        );
        assert_eq!(report.summary.findings, 0);
        assert_eq!(exit_code(&[report]), 0);
    }

    #[test]
    fn a_vulnerable_pattern_is_a_finding() {
        let report = scan_content("const re = /(a+)+/;", "a.js".into(), ScanOptions::default());
        assert_eq!(report.summary.findings, 1);
        assert_eq!(exit_code(&[report]), 1);
    }

    /// By default only the patterns at or above the threshold are
    /// reported — the clean ones are noise in a lint.
    #[test]
    fn only_findings_are_reported_unless_all_is_asked_for() {
        let content = "const a = /[a-z]+/;\nconst b = /(a+)+/;\n";
        let lint = scan_content(content, "a.js".into(), ScanOptions::default());
        assert_eq!(lint.patterns.len(), 1);

        let everything = scan_content(
            content,
            "a.js".into(),
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
        let medium = scan_content(content, "a.js".into(), ScanOptions::default());
        assert_eq!(medium.summary.findings, 1);
        let high = scan_content(
            content,
            "a.js".into(),
            ScanOptions {
                threshold: Severity::High,
                ..ScanOptions::default()
            },
        );
        assert_eq!(high.summary.findings, 0);
    }

    #[test]
    fn a_binary_file_is_skipped_rather_than_failed() {
        let tree = TempTree::new("scan-binary");
        let file = tree.path().join("logo.png");
        std::fs::write(&file, [0x89, 0x50, 0xff, 0xfe]).expect("a file");
        assert!(scan_file(&file, ScanOptions::default()).is_none());
    }

    #[test]
    fn an_unreadable_file_ends_the_run_at_two() {
        let tree = TempTree::new("scan-unreadable");
        let report =
            scan_file(&tree.path().join("gone.js"), ScanOptions::default()).expect("a report");
        assert!(report.is_unexamined());
        assert_eq!(exit_code(&[report]), 2);
    }

    #[test]
    fn nothing_to_scan_exits_clear() {
        assert_eq!(exit_code(&[]), 0);
    }

    #[test]
    fn the_human_line_carries_the_pattern_and_its_verdict() {
        let report = scan_content(
            "const re = /(a+)+/g;",
            "a.js".into(),
            ScanOptions::default(),
        );
        let line = describe(&report, &report.patterns[0]);
        assert!(line.contains("a.js:1:12"), "{line}");
        assert!(line.contains("/(a+)+/g"), "{line}");
        assert!(line.contains("[high]"), "{line}");
    }
}
