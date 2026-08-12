//! `ReDoS` detection: structural, heuristic, and honest about it.
//!
//! Two shapes are flagged:
//!
//! - **Nested unbounded quantifiers** — a quantified group whose body
//!   also contains an unbounded quantifier: `(a+)+`, `([a-z]+)*`,
//!   `(\w*)+`. The classic exponential shape. High severity.
//! - **Quantified alternation with overlapping branches** — `(a|a)*`,
//!   `(a|ab)+`: two branches that can match the same prefix inside a
//!   quantified group. Medium severity.
//!
//! **Honest scope, ported with the code: this is a scanner, not an
//! automaton analysis. It cannot prove a pattern safe** — only flag the
//! common dangerous shapes. Patterns it does not recognise may still
//! backtrack badly on adversarial input. A tool implying more would be
//! worse than one finding less, so the wording stays.
//!
//! No engine is involved below the validity check: everything here is a
//! walk over the pattern text with a stack.

use serde::{Deserialize, Serialize};

use super::heuristics;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Severity {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct ReDoSResult {
    pub(crate) detected: bool,
    pub(crate) severity: Severity,
    pub(crate) reason: String,
    #[serde(rename = "vulnerableGroups", skip_serializing_if = "Option::is_none")]
    pub(crate) vulnerable_groups: Option<Vec<String>>,
}

struct Group {
    body: String,
    quantifier: Option<String>,
}

pub(crate) fn detect_redos(pattern: &str, flags: &str) -> ReDoSResult {
    // An invalid pattern is a syntax error, not a ReDoS finding. Saying
    // otherwise would put a security verdict on a typo. The judge is
    // `is_well_formed` rather than `compiles` because this scan reads
    // patterns from every language the extractor finds one in, and
    // `regress` speaks only JavaScript: a Python named group would
    // otherwise come back as a syntax error on working code.
    if !heuristics::is_well_formed(pattern, flags) {
        return ReDoSResult {
            detected: false,
            severity: Severity::Low,
            reason: "Pattern is invalid".to_string(),
            vulnerable_groups: None,
        };
    }

    let groups = scan_groups(pattern);

    let nested: Vec<String> = groups
        .iter()
        .filter(|group| {
            group.quantifier.as_deref().is_some_and(is_unbounded)
                && contains_unbounded_quantifier(&group.body)
        })
        .map(rendered)
        .collect();
    if !nested.is_empty() {
        return ReDoSResult {
            detected: true,
            severity: Severity::High,
            reason: "Nested unbounded quantifiers can cause exponential backtracking".to_string(),
            vulnerable_groups: Some(nested),
        };
    }

    let overlapping: Vec<String> = groups
        .iter()
        .filter(|group| {
            group.quantifier.as_deref().is_some_and(is_unbounded)
                && has_overlapping_alternation(&group.body)
        })
        .map(rendered)
        .collect();
    if !overlapping.is_empty() {
        return ReDoSResult {
            detected: true,
            severity: Severity::Medium,
            reason: "Quantified alternation with overlapping branches may backtrack heavily"
                .to_string(),
            vulnerable_groups: Some(overlapping),
        };
    }

    ReDoSResult {
        detected: false,
        severity: Severity::Low,
        reason: "No obvious ReDoS vulnerabilities detected".to_string(),
        vulnerable_groups: None,
    }
}

fn rendered(group: &Group) -> String {
    format!(
        "({}){}",
        group.body,
        group.quantifier.as_deref().unwrap_or_default()
    )
}

/// Every parenthesised group with its trailing quantifier, skipping
/// escapes and character classes — so `[(]+` is a class, not a group,
/// and `\(a+\)+` is escaped literal parentheses. Nested groups are each
/// reported with their full body.
fn scan_groups(pattern: &str) -> Vec<Group> {
    let characters: Vec<char> = pattern.chars().collect();
    let mut groups = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    let mut in_class = false;

    let mut index = 0;
    while index < characters.len() {
        let character = characters[index];
        if character == '\\' {
            index += 2;
            continue;
        }
        if in_class {
            if character == ']' {
                in_class = false;
            }
            index += 1;
            continue;
        }
        match character {
            '[' => in_class = true,
            '(' => stack.push(index),
            ')' => {
                if let Some(start) = stack.pop() {
                    let body: String = characters[start + 1..index].iter().collect();
                    groups.push(Group {
                        body: strip_group_prefix(&body),
                        quantifier: read_quantifier(&characters, index + 1),
                    });
                }
            }
            _ => {}
        }
        index += 1;
    }
    groups
}

fn read_quantifier(characters: &[char], offset: usize) -> Option<String> {
    match characters.get(offset)? {
        c @ ('*' | '+' | '?') => Some(c.to_string()),
        '{' => {
            // `{n}` or `{n,}` or `{n,m}` — anything else is a literal
            // brace and not a quantifier.
            let rest: String = characters[offset..].iter().collect();
            let mut end = 1;
            let bytes: Vec<char> = rest.chars().collect();
            if !bytes.get(1)?.is_ascii_digit() {
                return None;
            }
            while bytes.get(end).is_some_and(char::is_ascii_digit) {
                end += 1;
            }
            if bytes.get(end) == Some(&',') {
                end += 1;
                while bytes.get(end).is_some_and(char::is_ascii_digit) {
                    end += 1;
                }
            }
            (bytes.get(end) == Some(&'}')).then(|| bytes[..=end].iter().collect())
        }
        _ => None,
    }
}

fn is_unbounded(quantifier: &str) -> bool {
    if quantifier == "*" || quantifier == "+" {
        return true;
    }
    // `{n,}` — an open upper bound.
    quantifier.starts_with('{')
        && quantifier.ends_with(",}")
        && quantifier[1..quantifier.len() - 2]
            .chars()
            .all(|c| c.is_ascii_digit())
        && quantifier.len() > 3
}

/// Drop a group's non-capturing or lookaround prefix so the body is the
/// pattern rather than the syntax announcing it.
fn strip_group_prefix(body: &str) -> String {
    for prefix in ["?:", "?=", "?!", "?<=", "?<!"] {
        if let Some(rest) = body.strip_prefix(prefix) {
            return rest.to_string();
        }
    }
    // A named group: `?<name>`, but not `?<=` or `?<!`, which are above.
    if let Some(rest) = body.strip_prefix("?<")
        && !rest.starts_with('=')
        && !rest.starts_with('!')
        && let Some(end) = rest.find('>')
    {
        return rest[end + 1..].to_string();
    }
    body.to_string()
}

fn contains_unbounded_quantifier(body: &str) -> bool {
    let characters: Vec<char> = body.chars().collect();
    let mut in_class = false;
    let mut index = 0;
    while index < characters.len() {
        let character = characters[index];
        if character == '\\' {
            index += 2;
            continue;
        }
        if in_class {
            if character == ']' {
                in_class = false;
            }
            index += 1;
            continue;
        }
        match character {
            '[' => in_class = true,
            '*' | '+' => return true,
            '{' => {
                let rest: String = characters[index..].iter().collect();
                if open_ended_brace(&rest) {
                    return true;
                }
            }
            _ => {}
        }
        index += 1;
    }
    false
}

/// `{n,}` — a comma with **no upper bound after it**.
///
/// The `}` has to follow the comma immediately. Accepting any comma
/// makes `{1,3}` look unbounded, which reported `(a{1,3})*` as an
/// exponential shape — a false high-severity finding on a perfectly
/// bounded pattern.
fn open_ended_brace(rest: &str) -> bool {
    let mut chars = rest.chars().skip(1).peekable();
    let mut digits = 0;
    while chars.peek().is_some_and(char::is_ascii_digit) {
        chars.next();
        digits += 1;
    }
    digits > 0 && chars.next() == Some(',') && chars.next() == Some('}')
}

fn has_overlapping_alternation(body: &str) -> bool {
    let branches = split_top_level_alternation(body);
    if branches.len() < 2 {
        return false;
    }
    let first: Vec<char> = branches
        .iter()
        .filter_map(|branch| first_literal_char(branch))
        .collect();
    let mut seen: Vec<char> = Vec::new();
    for character in &first {
        if seen.contains(character) {
            return true;
        }
        seen.push(*character);
    }
    false
}

fn split_top_level_alternation(body: &str) -> Vec<String> {
    let characters: Vec<char> = body.chars().collect();
    let mut branches = Vec::new();
    let mut current = String::new();
    let mut depth: usize = 0;
    let mut in_class = false;

    let mut index = 0;
    while index < characters.len() {
        let character = characters[index];
        if character == '\\' {
            current.push(character);
            if let Some(next) = characters.get(index + 1) {
                current.push(*next);
            }
            index += 2;
            continue;
        }
        if in_class {
            if character == ']' {
                in_class = false;
            }
            current.push(character);
            index += 1;
            continue;
        }
        match character {
            '[' => in_class = true,
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            '|' if depth == 0 => {
                branches.push(std::mem::take(&mut current));
                index += 1;
                continue;
            }
            _ => {}
        }
        current.push(character);
        index += 1;
    }
    branches.push(current);
    branches
}

/// A branch's first character, when it is one an overlap can be judged
/// from. A branch starting with a metacharacter is not compared.
fn first_literal_char(branch: &str) -> Option<char> {
    let character = branch.chars().next()?;
    (character.is_alphanumeric() || character == '_' || character.is_whitespace())
        .then_some(character)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn verdict(pattern: &str) -> (bool, Severity) {
        let result = detect_redos(pattern, "");
        (result.detected, result.severity)
    }

    #[test]
    fn nested_unbounded_quantifiers_are_high() {
        for pattern in [
            "(a+)+",
            "([a-z]+)*",
            r"(\w*)+",
            "((a)*)*",
            "(?:a+)+",
            "(a+)+b",
        ] {
            assert_eq!(verdict(pattern), (true, Severity::High), "{pattern}");
        }
    }

    #[test]
    fn overlapping_quantified_alternation_is_medium() {
        for pattern in ["(a|a)*", "(a|ab)+"] {
            assert_eq!(verdict(pattern), (true, Severity::Medium), "{pattern}");
        }
    }

    /// A detector that only ever fires is as broken as one that never
    /// does, so the shapes it must *not* flag are pinned too.
    #[test]
    fn ordinary_patterns_are_low() {
        for pattern in [r"^\d{4}-\d{2}-\d{2}$", "[a-z]+", "(abc)+", "(a+)", "(a|b)*"] {
            assert_eq!(verdict(pattern), (false, Severity::Low), "{pattern}");
        }
    }

    /// The group scanner must respect character classes and escapes —
    /// neither of these is a quantified group.
    #[test]
    fn a_class_and_an_escape_are_not_groups() {
        assert_eq!(verdict("[(]+"), (false, Severity::Low));
        assert_eq!(verdict(r"\(a+\)+"), (false, Severity::Low));
    }

    #[test]
    fn an_invalid_pattern_is_a_syntax_error_not_a_vulnerability() {
        for pattern in ["(", "a{2,1}", "[z-a]"] {
            let result = detect_redos(pattern, "");
            assert!(!result.detected, "{pattern}");
            assert_eq!(result.reason, "Pattern is invalid", "{pattern}");
        }
        assert_eq!(detect_redos("x", "zz").reason, "Pattern is invalid");
    }

    /// `{1,3}` is bounded and `{1,}` is not — the distinction is the
    /// `}` immediately after the comma, and getting it wrong reported a
    /// bounded pattern as exponential.
    #[test]
    fn a_bounded_quantifier_is_not_unbounded() {
        assert!(is_unbounded("*"));
        assert!(is_unbounded("+"));
        assert!(is_unbounded("{2,}"));
        assert!(!is_unbounded("?"));
        assert!(!is_unbounded("{2}"));
        assert!(!is_unbounded("{2,4}"));
        assert_eq!(verdict("(a{1,3})*"), (false, Severity::Low));
        assert_eq!(verdict("(a{1,})*"), (true, Severity::High));
        assert!(open_ended_brace("{2,}"));
        assert!(!open_ended_brace("{2,4}"));
        assert!(!open_ended_brace("{2}"));
    }

    #[test]
    fn a_group_prefix_is_stripped_from_the_body() {
        assert_eq!(strip_group_prefix("?:abc"), "abc");
        assert_eq!(strip_group_prefix("?=abc"), "abc");
        assert_eq!(strip_group_prefix("?<!abc"), "abc");
        assert_eq!(strip_group_prefix("?<name>abc"), "abc");
        assert_eq!(strip_group_prefix("abc"), "abc");
    }

    #[test]
    fn a_named_group_is_still_scanned() {
        assert_eq!(verdict("(?<name>a+)+"), (true, Severity::High));
    }

    #[test]
    fn the_vulnerable_group_is_named_in_the_result() {
        let result = detect_redos("(a+)+", "");
        assert_eq!(
            result.vulnerable_groups.as_deref(),
            Some(["(a+)+".to_string()].as_slice())
        );
    }

    #[test]
    fn a_clean_result_names_no_groups() {
        assert_eq!(detect_redos("[a-z]+", "").vulnerable_groups, None);
    }

    #[test]
    fn alternation_is_split_at_the_top_level_only() {
        assert_eq!(split_top_level_alternation("a|b"), ["a", "b"]);
        assert_eq!(split_top_level_alternation("(a|b)|c"), ["(a|b)", "c"]);
        assert_eq!(split_top_level_alternation("[a|b]"), ["[a|b]"]);
        assert_eq!(split_top_level_alternation(r"a\|b"), [r"a\|b"]);
    }
}
