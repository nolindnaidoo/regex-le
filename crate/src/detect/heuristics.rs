//! The three judgments a second implementation is most likely to get
//! subtly wrong: which flags are legal, whether a pattern compiles at
//! all, and whether a slash is a regex or a division sign.

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

/// JavaScript's `[\w$]`, which is **ASCII**: `\w` there is
/// `[A-Za-z0-9_]` and nothing more. Rust's `regex` crate spells `\w`
/// Unicode-aware, so borrowing it would make `café /x/` division here
/// and a regex in the extension.
fn is_word_character(character: char) -> bool {
    character.is_ascii_alphanumeric() || character == '_' || character == '$'
}

/// Whether a slash at `offset` opens a regex rather than dividing.
///
/// After an identifier, a number or a closing bracket a slash is
/// division — unless the identifier is a keyword that may be followed by
/// a regex. Directly after another slash it is a comment or a division
/// chain, which is what keeps `https://…` out of the results.
///
/// It walks backwards over the text before `offset` without copying it.
/// Collecting the document into a `Vec<char>` on each call reads more
/// plainly and is quadratic: one call per candidate slash, and a
/// minified bundle has thousands.
pub(crate) fn is_regex_context(text: &str, offset: usize) -> bool {
    let mut end = offset.min(text.len());
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    let before = text[..end].trim_end_matches([' ', '\t']);

    let Some(previous) = before.chars().next_back() else {
        return true; // start of text
    };
    if previous == '\n' || previous == '\r' {
        return true; // start of line
    }

    if is_word_character(previous) {
        let word = before.trim_end_matches(is_word_character);
        return REGEX_ALLOWING_KEYWORDS.contains(&&before[word.len()..]);
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

    /// JavaScript's `\w` is ASCII, so a non-ASCII letter is not part
    /// of an identifier and the slash after it opens a regex. Rust's
    /// `\w` would answer the other way.
    #[test]
    fn a_non_ascii_letter_does_not_make_an_identifier() {
        assert!(is_regex_context("café /a/", 5));
    }

    /// The keyword scan stops at the identifier, not at the start of
    /// the line.
    #[test]
    fn a_keyword_is_read_off_the_end_of_the_identifier() {
        assert!(is_regex_context("x = return /a/", 11));
        assert!(!is_regex_context("x = noreturn /a/", 13));
    }

    #[test]
    fn an_operator_may_be_followed_by_a_regex() {
        assert!(is_regex_context("x = /a/", 4));
        assert!(is_regex_context("foo(/a/)", 4));
    }
}
