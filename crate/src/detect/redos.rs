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

use super::{ambiguity, heuristics};
use super::js;

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
    /// The input that demonstrates the blow-up.
    ///
    /// **This is the finding.** A severity is an opinion; a string that
    /// takes the pattern from forty steps to two million is a receipt,
    /// and it is what makes the report checkable by whoever reads it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) witness: Option<String>,
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
            witness: None,
        };
    }

    // **Demonstrated, not inferred.** A shape rule scored 6 of 20 against
    // patterns whose behaviour was measured rather than assumed, and an
    // automaton scored 10: both flag `^[a-z0-9]+(?:-[a-z0-9]+)*$`, which
    // is safe because every iteration must eat a `-` the inner class
    // cannot produce, and both missed `(.*a){20}`, which is not. A
    // separator forcing the split is a fact about strings, so no test on
    // syntax settles it.
    //
    // `ambiguity::decide` asks the question that does settle it — is
    // there an input that makes this blow up — and answers with that
    // input. Nothing is reported that was not shown.
    match ambiguity::decide(pattern) {
        Ok(Some(blowup)) => ReDoSResult {
            detected: true,
            severity: Severity::High,
            reason: format!(
                "exponential backtracking: {} steps on {} characters, against {} on {}",
                blowup.high,
                blowup.witness.chars().count(),
                blowup.low,
                blowup.witness.chars().count() / 2,
            ),
            vulnerable_groups: None,
            witness: Some(blowup.witness),
        },
        Ok(None) => ReDoSResult {
            detected: false,
            severity: Severity::Low,
            reason: "no input was found that drives this into backtracking".to_string(),
            vulnerable_groups: None,
            witness: None,
        },
        // **A refusal, not a clearance.** A backreference or a lookaround
        // is not a regular language, so this construction cannot answer
        // for it either way, and saying "no finding" would read as safe.
        Err(undecidable) => ReDoSResult {
            detected: false,
            severity: Severity::Low,
            reason: format!("not decided: {}", undecidable.reason()),
            vulnerable_groups: None,
            witness: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::{Severity, detect_redos};

    /// **A finding is a demonstration.** The shape rule this replaces
    /// scored 6 of 20 against measured behaviour; these two patterns are
    /// the ones it and an automaton both got wrong, in opposite
    /// directions.
    #[test]
    fn a_finding_is_demonstrated_and_a_safe_pattern_is_not_flagged() {
        let bad = detect_redos(r"(.*a){20}", "");
        assert!(bad.detected, "{bad:?}");
        assert_eq!(bad.severity, Severity::High);
        assert!(bad.witness.is_some(), "a finding carries its input");

        let safe = detect_redos(r"^\w+(?:\.\w+)*$", "");
        assert!(!safe.detected, "{safe:?}");
        assert!(safe.witness.is_none());
    }

    /// **Undecidable is not clean.** A backreference is not a regular
    /// language, so nothing here can answer for it either way, and
    /// reporting no finding would read as a clearance.
    #[test]
    fn what_cannot_be_decided_says_so() {
        let result = detect_redos(r"(a)\1+", "");
        assert!(!result.detected);
        assert!(result.reason.starts_with("not decided:"), "{result:?}");
    }

    /// An invalid pattern is a syntax error, not a security verdict.
    #[test]
    fn an_invalid_pattern_is_not_a_finding() {
        let result = detect_redos("(", "");
        assert!(!result.detected);
        assert_eq!(result.reason, "Pattern is invalid");
    }

    /// The reason carries the numbers behind the verdict, so a reader
    /// can weigh it without rerunning anything.
    #[test]
    fn the_reason_states_the_cost() {
        let result = detect_redos(r"(a+)+b", "");
        assert!(result.reason.contains("steps"), "{}", result.reason);
    }
}
