//! The three judgments a second implementation is most likely to get
//! subtly wrong: which flags are legal, whether a pattern compiles at
//! all, and whether a slash is a regex or a division sign.

use std::sync::LazyLock;

use regex::Regex;

pub(crate) const VALID_FLAGS: &str = "dgimsuvy";

/// Keywords a regex literal may directly follow.
///
/// Ported verbatim rather than re-derived. A second implementation
/// guessing at this list is how two frontends start disagreeing about
/// what is even a pattern — `return /x/` is a regex, `count /x/` is two
/// divisions.
const REGEX_ALLOWING_KEYWORDS: [&str; 15] = [
    "return",
    "typeof",
    "instanceof",
    "in",
    "of",
    "new",
    "delete",
    "void",
    "do",
    "else",
    "case",
    "yield",
    "await",
    "throw",
    "",
];

/// Legal flags, each appearing at most once — `gg` is not valid.
pub(crate) fn is_valid_flag_string(flags: &str) -> bool {
    let mut seen = Vec::new();
    for flag in flags.chars() {
        if !VALID_FLAGS.contains(flag) || seen.contains(&flag) {
            return false;
        }
        seen.push(flag);
    }
    true
}

/// Whether `new RegExp(pattern, flags)` would succeed.
///
/// The **only** place this crate needs a JavaScript-compatible engine,
/// and it is used to parse rather than to match. An invalid pattern is a
/// syntax error, not a vulnerability, and telling the two apart is what
/// this answers.
pub(crate) fn compiles(pattern: &str, flags: &str) -> bool {
    if !is_valid_flag_string(flags) {
        return false;
    }
    regress::Regex::with_flags(pattern, flags).is_ok()
}

static WORD_CHARACTER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\w$]").expect("a constant pattern compiles"));

/// Whether a slash at `offset` opens a regex rather than dividing.
///
/// After an identifier, a number or a closing bracket a slash is
/// division — unless the identifier is a keyword that may be followed by
/// a regex. Directly after another slash it is a comment or a division
/// chain, which is what keeps `https://…` out of the results.
pub(crate) fn is_regex_context(text: &str, offset: usize) -> bool {
    let characters: Vec<char> = text.chars().collect();
    // The extension indexes UTF-16 code units; offsets here come from
    // byte-indexed matches, so the scan walks back over characters from
    // the character index the byte offset lands on.
    let offset = text[..offset.min(text.len())].chars().count();

    let mut index = offset as isize - 1;
    while index >= 0 {
        match characters.get(index as usize) {
            Some(' ' | '\t') => index -= 1,
            _ => break,
        }
    }
    if index < 0 {
        return true; // start of text
    }

    let previous = characters[index as usize];
    if previous == '\n' || previous == '\r' {
        return true; // start of line
    }

    if WORD_CHARACTER.is_match(&previous.to_string()) {
        let mut start = index;
        while start > 0
            && characters
                .get((start - 1) as usize)
                .is_some_and(|c| WORD_CHARACTER.is_match(&c.to_string()))
        {
            start -= 1;
        }
        let word: String = characters[start as usize..=index as usize].iter().collect();
        return REGEX_ALLOWING_KEYWORDS.contains(&word.as_str());
    }

    !matches!(previous, ')' | ']' | '.' | '/')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legal_flags_appear_at_most_once() {
        assert!(is_valid_flag_string(""));
        assert!(is_valid_flag_string("gi"));
        assert!(is_valid_flag_string("dgimsuvy"));
        assert!(!is_valid_flag_string("gg"), "a repeat is not valid");
        assert!(!is_valid_flag_string("x"));
        assert!(!is_valid_flag_string("GI"), "flags are lowercase");
    }

    #[test]
    fn an_invalid_pattern_does_not_compile() {
        assert!(compiles("a+", ""));
        assert!(!compiles("(", ""));
        assert!(!compiles("a{2,1}", ""));
        assert!(!compiles("[z-a]", ""));
    }

    /// Bad flags are a compile failure too — the extension's
    /// `new RegExp('x', 'zz')` throws.
    #[test]
    fn bad_flags_fail_to_compile() {
        assert!(!compiles("x", "zz"));
        assert!(!compiles("x", "q"));
    }

    #[test]
    fn a_slash_at_the_start_opens_a_regex() {
        assert!(is_regex_context("/a/", 0));
        assert!(is_regex_context("\n/a/", 1));
        assert!(is_regex_context("  /a/", 2));
    }

    #[test]
    fn a_slash_after_a_value_is_division() {
        assert!(!is_regex_context("a / b", 2));
        assert!(!is_regex_context("1 / 2", 2));
        assert!(!is_regex_context("] / 2", 2));
        assert!(!is_regex_context(")/a/", 1));
    }

    /// The case that keeps every URL in a codebase out of the results.
    #[test]
    fn a_slash_after_a_slash_is_not_a_regex() {
        assert!(!is_regex_context("https://x", 7));
    }

    #[test]
    fn a_keyword_may_be_followed_by_a_regex() {
        assert!(is_regex_context("return /a/", 7));
        assert!(is_regex_context("case /a/", 5));
        assert!(!is_regex_context("count /a/", 6), "not a keyword");
    }

    #[test]
    fn an_operator_may_be_followed_by_a_regex() {
        assert!(is_regex_context("x = /a/", 4));
        assert!(is_regex_context("foo(/a/)", 4));
    }
}
