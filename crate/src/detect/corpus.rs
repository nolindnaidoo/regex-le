//! The shared corpus, run against this implementation.
//!
//! `../scripts/check-extraction-parity.ts` runs the extension over these
//! same files; this module runs the crate over them. Neither side may be
//! the sole author of a case.

use serde::Deserialize;

use super::extract::{Pattern, extract_patterns};
use super::format::resolve_language;
use super::heuristics;
use super::redos::{Severity, detect_redos};

const EXTRACTION: &str = include_str!("../../fixtures/extraction.json");

const DOCUMENTS: [(&str, &str); 13] = [
    ("log.txt", include_str!("../../fixtures/documents/log.txt")),
    (
        "multiline.js",
        include_str!("../../fixtures/documents/multiline.js"),
    ),
    (
        "patterns.js",
        include_str!("../../fixtures/documents/patterns.js"),
    ),
    (
        "patterns.ts",
        include_str!("../../fixtures/documents/patterns.ts"),
    ),
    (
        "patterns.py",
        include_str!("../../fixtures/documents/patterns.py"),
    ),
    (
        "patterns.rs",
        include_str!("../../fixtures/documents/patterns.rs"),
    ),
    (
        "patterns.go",
        include_str!("../../fixtures/documents/patterns.go"),
    ),
    (
        "patterns.java",
        include_str!("../../fixtures/documents/patterns.java"),
    ),
    (
        "patterns.rb",
        include_str!("../../fixtures/documents/patterns.rb"),
    ),
    (
        "patterns.php",
        include_str!("../../fixtures/documents/patterns.php"),
    ),
    (
        "patterns.cs",
        include_str!("../../fixtures/documents/patterns.cs"),
    ),
    (
        "division.py",
        include_str!("../../fixtures/documents/division.py"),
    ),
    ("pcre.py", include_str!("../../fixtures/documents/pcre.py")),
];

/// Every embedded document, for the fuzzer to seed itself from. Real
/// source in nine grammars is a better starting point than random bytes:
/// a mutation of something the extractor already reaches gets past the
/// first character far more often than noise does.
pub(crate) fn documents() -> &'static [(&'static str, &'static str)] {
    &DOCUMENTS
}

pub(crate) fn document(name: &str) -> &'static str {
    DOCUMENTS
        .iter()
        .find(|(file, _)| *file == name)
        .map_or_else(
            || panic!("the corpus refers to {name}, which is not embedded"),
            |(_, content)| *content,
        )
}

#[derive(Debug, Deserialize)]
struct Corpus {
    documents: Vec<DocumentCase>,
    redos: Vec<RedosCase>,
    heuristics: Heuristics,
}

#[derive(Debug, Deserialize)]
struct DocumentCase {
    name: String,
    file: String,
    expected: Vec<ExpectedPattern>,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
struct ExpectedPattern {
    pattern: String,
    flags: String,
    line: usize,
    column: usize,
    #[serde(rename = "match")]
    matched: String,
    redos: ExpectedRedos,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
struct ExpectedRedos {
    detected: bool,
    severity: Severity,
    reason: String,
    #[serde(rename = "vulnerableGroups", default)]
    vulnerable_groups: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct RedosCase {
    pattern: String,
    flags: String,
    expected: ExpectedRedos,
}

#[derive(Debug, Deserialize)]
struct Heuristics {
    #[serde(rename = "isValidFlagString")]
    is_valid_flag_string: Vec<FlagCase>,
    compiles: Vec<CompileCase>,
    #[serde(rename = "isWellFormed")]
    is_well_formed: Vec<CompileCase>,
    #[serde(rename = "isRegexContext")]
    is_regex_context: Vec<ContextCase>,
}

#[derive(Debug, Deserialize)]
struct FlagCase {
    input: String,
    expected: bool,
}

#[derive(Debug, Deserialize)]
struct CompileCase {
    pattern: String,
    flags: String,
    expected: bool,
}

#[derive(Debug, Deserialize)]
struct ContextCase {
    text: String,
    offset: usize,
    expected: bool,
}

fn corpus() -> Corpus {
    serde_json::from_str(EXTRACTION).expect("the corpus is valid JSON")
}

fn as_expected(found: &Pattern) -> ExpectedPattern {
    ExpectedPattern {
        pattern: found.pattern.clone(),
        flags: found.flags.clone(),
        line: found.line,
        column: found.column,
        matched: found.matched.clone(),
        redos: ExpectedRedos {
            detected: found.redos.detected,
            severity: found.redos.severity,
            reason: found.redos.reason.clone(),
            vulnerable_groups: found.redos.vulnerable_groups.clone(),
        },
    }
}

#[test]
fn every_document_case_reproduces() {
    let corpus = corpus();
    assert!(!corpus.documents.is_empty(), "the corpus is empty");

    for case in corpus.documents {
        // The language comes off the file name, exactly as it does for
        // a walked file and for the extension's parity script — so a
        // case cannot pin an answer neither frontend would produce.
        let language = resolve_language(None, Some(&case.file));
        let actual: Vec<ExpectedPattern> = extract_patterns(document(&case.file), language)
            .expect("the patterns hold")
            .iter()
            .map(as_expected)
            .collect();
        assert_eq!(actual, case.expected, "{}", case.name);
    }
}

#[test]
fn every_redos_case_reproduces() {
    for case in corpus().redos {
        let result = detect_redos(&case.pattern, &case.flags);
        let actual = ExpectedRedos {
            detected: result.detected,
            severity: result.severity,
            reason: result.reason.clone(),
            vulnerable_groups: result.vulnerable_groups.clone(),
        };
        assert_eq!(
            actual, case.expected,
            "redos {:?} /{}",
            case.pattern, case.flags
        );
    }
}

#[test]
fn every_heuristics_case_reproduces() {
    let corpus = corpus();
    for case in corpus.heuristics.is_valid_flag_string {
        assert_eq!(
            heuristics::is_valid_flag_string(&case.input),
            case.expected,
            "isValidFlagString {:?}",
            case.input
        );
    }
    for case in corpus.heuristics.compiles {
        assert_eq!(
            heuristics::compiles(&case.pattern, &case.flags),
            case.expected,
            "compiles {:?} /{}",
            case.pattern,
            case.flags
        );
    }
    for case in corpus.heuristics.is_well_formed {
        assert_eq!(
            heuristics::is_well_formed(&case.pattern, &case.flags),
            case.expected,
            "isWellFormed {:?} /{}",
            case.pattern,
            case.flags
        );
    }
    for case in corpus.heuristics.is_regex_context {
        assert_eq!(
            heuristics::is_regex_context(&case.text, case.offset),
            case.expected,
            "isRegexContext {:?} @{}",
            case.text,
            case.offset
        );
    }
}

/// Every embedded document must be used by a case, and every case must
/// name an embedded document.
#[test]
fn the_corpus_and_the_embedded_documents_match() {
    let corpus = corpus();
    for (name, _) in DOCUMENTS {
        assert!(
            corpus.documents.iter().any(|case| case.file == name),
            "{name} is embedded but no case uses it"
        );
    }
    for case in &corpus.documents {
        assert!(
            DOCUMENTS.iter().any(|(name, _)| *name == case.file),
            "{} names {}, which is not embedded",
            case.name,
            case.file
        );
    }
}
