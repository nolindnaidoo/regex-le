//! Finding the regexes: literals and `RegExp` constructors.
//!
//! Whole-content matching, so a constructor split across lines is found.
//! A pattern-and-flags pair is reported **once, at its first
//! occurrence** — the output is a pattern list, not an occurrence list,
//! which is deliberate in the extension and ported here.

use std::sync::LazyLock;

use fancy_regex::Regex;
use serde::Serialize;

use super::heuristics::{self, VALID_FLAGS};
use super::position::PositionIndex;
use super::redos::{self, ReDoSResult};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct Pattern {
    pub(crate) pattern: String,
    pub(crate) flags: String,
    pub(crate) line: usize,
    pub(crate) column: usize,
    /// The full matched text — `/x/gi` or the whole constructor call.
    #[serde(rename = "match")]
    pub(crate) matched: String,
    pub(crate) redos: ReDoSResult,
}

/// `/pattern/flags` — the body may not contain an unescaped slash or
/// newline. Flags are captured greedily and validated afterwards.
static LITERAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"/(?:[^/\r\n\\]|\\.)+/[{VALID_FLAGS}]*"))
        .expect("a constant pattern compiles")
});

/// `new RegExp('…', '…')` / `RegExp("…")`, with escaped quotes handled in
/// both arguments and whitespace wherever a JavaScript parser allows it.
///
/// The lookbehind is why this module uses `fancy-regex`: `(?<![.\w$])`
/// keeps `foo.RegExp` and `myRegExp` from matching, and `regex` cannot
/// express it.
static CONSTRUCTOR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"(?<![.\w$])(?:new\s+)?RegExp\s*\(\s*(?:'(?<sq>(?:[^'\\\r\n]|\\.)*)'|"(?<dq>(?:[^"\\\r\n]|\\.)*)")\s*(?:,\s*(?:'(?<sqf>[{VALID_FLAGS}]*)'|"(?<dqf>[{VALID_FLAGS}]*)")\s*)?,?\s*\)"#
    ))
    .expect("a constant pattern compiles")
});

/// Resolve the JavaScript string-literal escapes that change regex
/// meaning: doubled backslashes (`'\\d'` is the pattern `\d`) and
/// escaped quotes. Other escapes are left intact — as regex source they
/// match the same characters the string escape would have produced.
fn unescape_string_literal(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\\' && matches!(chars.peek(), Some('\\' | '\'' | '"')) {
            out.push(chars.next().expect("peeked"));
            continue;
        }
        out.push(character);
    }
    out
}

pub(crate) fn extract_patterns(text: &str) -> Result<Vec<Pattern>, String> {
    let index = PositionIndex::new(text);
    let mut patterns: Vec<Pattern> = Vec::new();
    let mut seen: Vec<String> = Vec::new();

    let mut push = |pattern: String, flags: String, offset: usize, matched: String| {
        let key = format!("{pattern}::{flags}");
        if seen.contains(&key) {
            return;
        }
        seen.push(key);
        let position = index.at(offset);
        patterns.push(Pattern {
            redos: redos::detect_redos(&pattern, &flags),
            pattern,
            flags,
            line: position.line,
            column: position.column,
            matched,
        });
    };

    for found in LITERAL.find_iter(text) {
        let found = found.map_err(|error| format!("the literal pattern gave up: {error}"))?;
        let full = found.as_str();
        let last = full.rfind('/').expect("a literal has a closing slash");
        let body = &full[1..last];
        let flags = &full[last + 1..];
        if !heuristics::is_regex_context(text, found.start()) {
            continue;
        }
        if !heuristics::is_valid_flag_string(flags) || !heuristics::compiles(body, flags) {
            continue;
        }
        push(
            body.to_string(),
            flags.to_string(),
            found.start(),
            full.to_string(),
        );
    }

    for captures in CONSTRUCTOR.captures_iter(text) {
        let captures =
            captures.map_err(|error| format!("the constructor pattern gave up: {error}"))?;
        let body = captures
            .name("sq")
            .or_else(|| captures.name("dq"))
            .map(|found| found.as_str())
            .unwrap_or_default();
        if body.is_empty() {
            continue;
        }
        let flags = captures
            .name("sqf")
            .or_else(|| captures.name("dqf"))
            .map(|found| found.as_str())
            .unwrap_or_default();
        let pattern = unescape_string_literal(body);
        if !heuristics::compiles(&pattern, flags) {
            continue;
        }
        let whole = captures.get(0).expect("a match has group zero");
        push(
            pattern,
            flags.to_string(),
            whole.start(),
            whole.as_str().to_string(),
        );
    }

    patterns.sort_by(|a, b| a.line.cmp(&b.line).then(a.column.cmp(&b.column)));
    Ok(patterns)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values(text: &str) -> Vec<(String, String)> {
        extract_patterns(text)
            .expect("the patterns hold")
            .into_iter()
            .map(|found| (found.pattern, found.flags))
            .collect()
    }

    #[test]
    fn a_literal_is_found_with_its_flags() {
        assert_eq!(values("const re = /a+b/gi;"), [("a+b".into(), "gi".into())]);
    }

    #[test]
    fn a_constructor_is_found() {
        assert_eq!(
            values("new RegExp('a+b', 'g')"),
            [("a+b".into(), "g".into())]
        );
        assert_eq!(values(r#"RegExp("x")"#), [("x".into(), String::new())]);
    }

    /// The string literal escapes a level: `'\\d'` is the pattern `\d`.
    #[test]
    fn a_constructor_unescapes_one_level() {
        assert_eq!(
            values(r"new RegExp('\\d+')"),
            [(r"\d+".into(), String::new())]
        );
    }

    #[test]
    fn a_constructor_split_across_lines_is_found() {
        assert_eq!(
            values("new RegExp(\n  'a+',\n  'g',\n)"),
            [("a+".into(), "g".into())]
        );
    }

    /// The lookbehind's job.
    #[test]
    fn a_member_or_prefixed_identifier_is_not_a_constructor() {
        assert!(values("foo.RegExp('a')").is_empty());
        assert!(values("myRegExp('a')").is_empty());
    }

    #[test]
    fn a_division_is_not_a_regex() {
        assert!(values("const x = a / b / c;").is_empty());
        assert!(values("const url = 'https://x/y';").is_empty());
    }

    #[test]
    fn an_invalid_flag_string_is_not_a_literal() {
        assert!(values("/a/gg").is_empty(), "a repeated flag");
    }

    #[test]
    fn an_uncompilable_literal_is_skipped() {
        assert!(values("const re = /a{2,1}/;").is_empty());
    }

    /// The output is a pattern list, not an occurrence list.
    #[test]
    fn a_repeated_pattern_is_reported_once_at_its_first_occurrence() {
        let found =
            extract_patterns("const a = /x+/g;\nconst b = /x+/g;\n").expect("the patterns hold");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].line, 1);
    }

    /// The same pattern with different flags is a different pattern.
    #[test]
    fn flags_are_part_of_the_identity() {
        assert_eq!(values("const a = /x+/g;\nconst b = /x+/i;\n").len(), 2);
    }

    #[test]
    fn results_come_back_in_document_order() {
        let found =
            extract_patterns("new RegExp('z+')\nconst a = /a+/;\n").expect("the patterns hold");
        assert_eq!(found[0].line, 1);
        assert_eq!(found[1].line, 2);
    }

    #[test]
    fn the_verdict_travels_with_the_pattern() {
        let found = extract_patterns("const re = /(a+)+/;").expect("the patterns hold");
        assert!(found[0].redos.detected);
        assert_eq!(found[0].redos.severity, super::redos::Severity::High);
    }
}
