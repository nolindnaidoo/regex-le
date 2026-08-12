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

/// Whether a pattern is a well-formed regular expression in **some**
/// grammar this tool reads.
///
/// `compiles` answers for JavaScript, which is the right judge of a
/// JavaScript literal and the wrong one for the rest: `regress` is the
/// only parser here, so `re.compile(r"(?P<year>\d+)")` — ordinary
/// Python — would come back a syntax error and be reported as
/// `Pattern is invalid`, a verdict on working code.
pub(crate) fn is_well_formed(pattern: &str, flags: &str) -> bool {
    compiles(pattern, flags) || compiles(&javascript_equivalent(pattern), flags)
}

/// PCRE-family flag letters, as Python, PHP, Rust, Go and Java spell an
/// inline mode switch.
const INLINE_FLAGS: &str = "imsxuUXAJn";

/// The non-JavaScript spellings this tool reads, rendered as the
/// JavaScript a parser can answer for.
///
/// **Nothing here reaches a report.** It exists so the validity question
/// has an answer for a pattern written in another language; the pattern
/// text that is reported, and that the `ReDoS` scan reads, is always the
/// source exactly as written. That is why dropping a possessive `+` is
/// safe: `(a++)+` still reaches the scan as `(a++)+` and is still
/// flagged, which is the conservative answer a tool that cannot prove a
/// pattern safe should give.
fn javascript_equivalent(pattern: &str) -> String {
    let characters: Vec<char> = pattern.chars().collect();
    let mut out = String::with_capacity(pattern.len());
    let mut in_class = false;
    let mut after_quantifier = false;
    let mut index = 0;

    while index < characters.len() {
        let character = characters[index];
        if character == '\\' {
            out.push(character);
            if let Some(next) = characters.get(index + 1) {
                out.push(*next);
            }
            after_quantifier = false;
            index += 2;
            continue;
        }
        if in_class {
            in_class = character != ']';
            out.push(character);
            index += 1;
            continue;
        }
        if character == '(' {
            let (rendered, width) = rewrite_group_prefix(&characters, index);
            out.push_str(&rendered);
            after_quantifier = false;
            index += width;
            continue;
        }
        // A possessive quantifier is a `+` on another quantifier —
        // `a++`, `a{2,}+` — which JavaScript spells with no `+` at all.
        if character == '+' && after_quantifier {
            index += 1;
            continue;
        }
        in_class = character == '[';
        after_quantifier = matches!(character, '*' | '+' | '?' | '}');
        out.push(character);
        index += 1;
    }
    out
}

/// Rewrite a group opener JavaScript does not spell the same way,
/// returning the rendering and how many characters it consumed.
fn rewrite_group_prefix(characters: &[char], index: usize) -> (String, usize) {
    // A PCRE comment carries no pattern at all.
    if starts_with(characters, index, "(?#") {
        let end = find(characters, index, ')').map_or(characters.len(), |at| at + 1);
        return (String::new(), end - index);
    }
    if starts_with(characters, index, "(?P<") {
        return ("(?<".to_string(), 4);
    }
    if starts_with(characters, index, "(?P=")
        && let Some(end) = find(characters, index + 4, ')')
    {
        let name: String = characters[index + 4..end].iter().collect();
        return (format!("\\k<{name}>"), end + 1 - index);
    }
    if starts_with(characters, index, "(?'")
        && let Some(end) = find(characters, index + 3, '\'')
    {
        let name: String = characters[index + 3..end].iter().collect();
        return (format!("(?<{name}>"), end + 1 - index);
    }
    // An atomic group is a non-capturing group that refuses to give
    // characters back. JavaScript has no such group, and the shape the
    // ReDoS scan reads is the same either way.
    if starts_with(characters, index, "(?>") {
        return ("(?:".to_string(), 3);
    }
    match inline_flags(characters, index) {
        Some((width, ':')) => ("(?:".to_string(), width),
        Some((width, _)) => (String::new(), width),
        None => ("(".to_string(), 1),
    }
}

/// `(?i)`, `(?im-sx)`, `(?s:` — a mode switch rather than a pattern.
/// Go and Rust write one at the head of nearly every case-insensitive
/// pattern they have.
fn inline_flags(characters: &[char], index: usize) -> Option<(usize, char)> {
    if !starts_with(characters, index, "(?") {
        return None;
    }
    let mut at = index + 2;
    while characters
        .get(at)
        .is_some_and(|c| INLINE_FLAGS.contains(*c))
    {
        at += 1;
    }
    if characters.get(at) == Some(&'-') {
        at += 1;
        let negated = at;
        while characters
            .get(at)
            .is_some_and(|c| INLINE_FLAGS.contains(*c))
        {
            at += 1;
        }
        if at == negated {
            return None;
        }
    }
    match characters.get(at) {
        Some(terminator @ (')' | ':')) => Some((at + 1 - index, *terminator)),
        _ => None,
    }
}

fn starts_with(characters: &[char], index: usize, prefix: &str) -> bool {
    prefix
        .chars()
        .enumerate()
        .all(|(offset, expected)| characters.get(index + offset) == Some(&expected))
}

fn find(characters: &[char], from: usize, needle: char) -> Option<usize> {
    characters
        .get(from..)?
        .iter()
        .position(|character| *character == needle)
        .map(|at| from + at)
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

    /// The spellings `regress` refuses and their own languages accept.
    /// Judging these as syntax errors put `Pattern is invalid` on
    /// working Python, Go and PHP.
    #[test]
    fn another_languages_spelling_is_well_formed() {
        for pattern in [
            r"(?P<year>\d{4})",
            r"(?P<a>x)(?P=a)",
            "(?>a+)",
            "a++",
            r"a{2,}+",
            "(?i)abc",
            "(?im-sx)abc",
            "(?'name'a)",
            "(?#a comment)b",
        ] {
            assert!(!compiles(pattern, ""), "{pattern} compiles as JavaScript");
            assert!(is_well_formed(pattern, ""), "{pattern}");
        }
    }

    /// Widening the judge must not turn a typo into a pattern.
    #[test]
    fn a_syntax_error_is_still_not_well_formed() {
        for pattern in ["(", "a{2,1}", "[z-a]", "(?P<a>x", "(?>a+"] {
            assert!(!is_well_formed(pattern, ""), "{pattern}");
        }
        assert!(!is_well_formed("x", "zz"), "the flags are still judged");
    }

    /// The rewrite answers a question; it never reaches a report. These
    /// pin what it produces so a change to it is visible.
    #[test]
    fn the_javascript_rendering_is_a_translation_not_a_repair() {
        assert_eq!(javascript_equivalent(r"(?P<y>\d+)"), r"(?<y>\d+)");
        assert_eq!(javascript_equivalent("(?P<a>x)(?P=a)"), "(?<a>x)\\k<a>");
        assert_eq!(javascript_equivalent("(?>a+)b"), "(?:a+)b");
        assert_eq!(javascript_equivalent("(?i)abc"), "abc");
        assert_eq!(javascript_equivalent("(?s:a.b)"), "(?:a.b)");
        assert_eq!(javascript_equivalent("a++b*+"), "a+b*");
        assert_eq!(javascript_equivalent("(?#note)a"), "a");
        assert_eq!(javascript_equivalent("(?'n'a)"), "(?<n>a)");
        // Untouched: a class, an escape, a lookaround, a named group
        // JavaScript already spells the same way.
        assert_eq!(
            javascript_equivalent(r"[a+]\+(?<n>x)(?=y)"),
            r"[a+]\+(?<n>x)(?=y)"
        );
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
