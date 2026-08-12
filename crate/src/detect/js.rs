//! JavaScript's string primitives, where Rust's differ.
//!
//! The extension calls `String.prototype.trim` and matches `\s` in the
//! extractor, the PHP delimiter reader and the alternation-overlap test.
//! Neither means what the Rust equivalent means: JavaScript's whitespace
//! set includes U+FEFF, which Unicode's `White_Space` property does not,
//! and excludes U+0085, which it does. A file beginning with a
//! byte-order mark is ordinary, so the difference is reachable rather
//! than theoretical — `re.compile\u{feff}("x")` was a pattern to one
//! server and nothing at all to the other.
//!
//! The same rule as `\w` in `heuristics`: spell out what the extension
//! means rather than borrowing what this language happens to give you.
//!
//! Defining the set once, in two forms, and testing that the two agree
//! is the only way this stays correct — a character added to one form
//! and not the other is exactly the drift this guards against.

/// Every character JavaScript treats as whitespace: `WhiteSpace` plus
/// `LineTerminator` from the language spec.
pub(crate) const JS_WHITESPACE: [char; 25] = [
    '\u{9}',    // tab
    '\u{a}',    // line feed
    '\u{b}',    // vertical tab
    '\u{c}',    // form feed
    '\u{d}',    // carriage return
    '\u{20}',   // space
    '\u{a0}',   // no-break space
    '\u{1680}', // ogham space mark
    '\u{2000}', '\u{2001}', '\u{2002}', '\u{2003}', '\u{2004}', '\u{2005}', '\u{2006}', '\u{2007}',
    '\u{2008}', '\u{2009}', '\u{200a}', '\u{2028}', // line separator
    '\u{2029}', // paragraph separator
    '\u{202f}', '\u{205f}', '\u{3000}', '\u{feff}', // zero-width no-break space
];

/// The same set as a regex character-class body, for the call-form
/// patterns that would otherwise write `\s`. Held equal to
/// `JS_WHITESPACE` by a test below.
pub(crate) const JS_SPACE_CLASS: &str =
    r"\t\n\x0B\f\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}";

pub(crate) fn is_js_whitespace(c: char) -> bool {
    JS_WHITESPACE.contains(&c)
}

pub(crate) fn trim(value: &str) -> &str {
    value.trim_matches(is_js_whitespace)
}

#[cfg(test)]
mod tests {
    use regex::Regex;

    use super::*;

    /// The two forms of the set must describe the same characters. A
    /// character added to one and not the other is silent drift between
    /// the trimmer and the patterns that use the class.
    #[test]
    fn the_char_list_and_the_regex_class_agree() {
        let class = Regex::new(&format!("^[{JS_SPACE_CLASS}]$")).expect("the class compiles");
        for c in JS_WHITESPACE {
            assert!(
                class.is_match(&c.to_string()),
                "{c:?} missing from the class"
            );
        }
        // Every code point the class matches must be in the list. The
        // class is BMP-only, so scanning the BMP is exhaustive for it.
        for code in 0u32..=0xffff {
            let Some(c) = char::from_u32(code) else {
                continue;
            };
            if class.is_match(&c.to_string()) {
                assert!(JS_WHITESPACE.contains(&c), "{c:?} missing from the list");
            }
        }
    }

    /// The two differences from Rust's own notion of whitespace, stated
    /// as tests so a future simplification to `str::trim` fails loudly.
    #[test]
    fn a_byte_order_mark_is_whitespace_here_and_not_in_rust() {
        assert!(is_js_whitespace('\u{feff}'));
        assert!(!'\u{feff}'.is_whitespace());
        assert_eq!(trim("\u{feff}a\u{feff}"), "a");
    }

    #[test]
    fn a_next_line_character_is_whitespace_in_rust_and_not_here() {
        assert!(!is_js_whitespace('\u{85}'));
        assert!('\u{85}'.is_whitespace());
        assert_eq!(trim("\u{85}a"), "\u{85}a");
    }

    #[test]
    fn trimming_matches_the_ordinary_cases() {
        assert_eq!(trim("  a b  "), "a b");
        assert_eq!(trim(""), "");
        assert_eq!(trim(" \t\n "), "");
    }
}
