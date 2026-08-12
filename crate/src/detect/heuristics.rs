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

/// The structure the parser pays stack for.
///
/// `regress` parses by recursive descent, so nesting and alternation
/// cost **stack** rather than heap, and running out of it is not an
/// error a caller sees: the process dies on a signal with no report and
/// no exit code, and one generated file takes a whole tree's scan with
/// it. Measured on a debug build of this crate against an 8 MB stack:
/// about 5.4 KB per nesting level, and about 1.1 KB per alternation
/// branch.
///
/// Both bracket kinds count towards the depth, and a group that is never
/// closed keeps counting. Two fuzzer findings shaped that: under the `v`
/// flag a character class nests as a class rather than as a literal, and
/// 510 of those aborted a 2 MB test thread; and `[(]+(]+(]+…` is a class
/// followed by a thousand groups nobody ever closes, which recursed just
/// as deep while looking balanced to anything counting brackets in
/// pairs.
struct Structure {
    depth: usize,
    branches: usize,
}

/// Past this, the parse gets a stack of its own rather than the caller's.
const DEEP_GROUP_DEPTH: usize = 32;
const DEEP_ALTERNATION_BRANCHES: usize = 256;

/// Past this, nothing parses it on any stack. Deep enough that no
/// hand-written pattern comes close and no generated one this crate has
/// met does either; a pattern beyond it is refused by name rather than
/// silently mis-judged.
pub(crate) const MAX_GROUP_DEPTH: usize = 1_000;
pub(crate) const MAX_ALTERNATION_BRANCHES: usize = 5_000;

/// The stack a deep parse is given: enough for the bounds above three
/// times over. It is *reserved* address space committed page by page as
/// it is used, so a pattern that needs none of it costs none of it.
const DEEP_STACK: usize = 32 * 1024 * 1024;

/// One pass over the pattern, stopping as soon as either bound is
/// exceeded so a hostile input costs no more than an ordinary one.
///
/// The open brackets are kept as a stack rather than a counter, because
/// which bracket is open changes what the next character means: inside a
/// character class a `(` is a literal and a `)` closes nothing, and
/// outside one a `]` with no class open is a literal too. Counting them
/// in pairs read `[(]+(]+(]+…` as balanced when it is a thousand groups
/// deep.
fn structure(pattern: &str) -> Structure {
    let mut characters = pattern.chars();
    let mut open: Vec<char> = Vec::new();
    let mut classes: usize = 0;
    let mut deepest: usize = 0;
    let mut branches: usize = 0;

    while let Some(character) = characters.next() {
        match character {
            '\\' => {
                characters.next();
            }
            '[' => {
                open.push('[');
                classes += 1;
                deepest = deepest.max(open.len());
            }
            ']' if classes > 0 => {
                open.pop();
                classes -= 1;
            }
            '(' if classes == 0 => {
                open.push('(');
                deepest = deepest.max(open.len());
            }
            ')' if classes == 0 => {
                if open.last() == Some(&'(') {
                    open.pop();
                }
            }
            '|' if classes == 0 => branches += 1,
            _ => continue,
        }
        if deepest > MAX_GROUP_DEPTH || branches > MAX_ALTERNATION_BRANCHES {
            break;
        }
    }
    Structure {
        depth: deepest,
        branches,
    }
}

/// Whether the parser can be asked about this pattern at all.
///
/// Extraction consults this before handing over anything that is
/// unambiguously a pattern, so a shape past the bounds becomes a
/// refusal that names itself rather than a pattern that quietly vanished.
pub(crate) fn is_within_parser_limits(pattern: &str) -> bool {
    let found = structure(pattern);
    found.depth <= MAX_GROUP_DEPTH && found.branches <= MAX_ALTERNATION_BRANCHES
}

/// Whether `new RegExp(pattern, flags)` would succeed.
///
/// The **only** place this crate needs a JavaScript-compatible engine,
/// and it is used to parse rather than to match. An invalid pattern is a
/// syntax error, not a vulnerability, and telling the two apart is what
/// this answers.
///
/// A pattern past every bound is answered `false` without the parser
/// being asked. That is not the same claim as "JavaScript would refuse
/// it" — V8 accepts deeper nesting than this — and it is why extraction
/// refuses such a pattern by name before it reaches here. This is the
/// guard for every other caller, and the reason no input can abort the
/// process.
pub(crate) fn compiles(pattern: &str, flags: &str) -> bool {
    if !is_valid_flag_string(flags) {
        return false;
    }
    let found = structure(pattern);
    if found.depth > MAX_GROUP_DEPTH || found.branches > MAX_ALTERNATION_BRANCHES {
        return false;
    }
    if found.depth <= DEEP_GROUP_DEPTH && found.branches <= DEEP_ALTERNATION_BRANCHES {
        return parse(pattern, flags);
    }
    parse_with_room(pattern, flags)
}

fn parse(pattern: &str, flags: &str) -> bool {
    regress::Regex::with_flags(pattern, flags).is_ok()
}

/// Parse on a thread sized for the job.
///
/// Reached only by a pattern deeper or wider than anything hand-written,
/// so the thread costs nothing in the common case. A thread that cannot
/// be started, or a parse that ends any way but normally, answers `false`
/// — the same answer the caller would get for a pattern that does not
/// compile, and the one that cannot take the process with it.
fn parse_with_room(pattern: &str, flags: &str) -> bool {
    std::thread::scope(|scope| {
        std::thread::Builder::new()
            .stack_size(DEEP_STACK)
            .spawn_scoped(scope, || parse(pattern, flags))
            .is_ok_and(|handle| handle.join().unwrap_or(false))
    })
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

    /// The regression a fuzzer found: `regress` parses by recursive
    /// descent, so a deep enough pattern overflowed the stack and the
    /// process died on `SIGABRT` — no report, no exit code, the whole
    /// tree's scan gone because one file held a generated pattern.
    #[test]
    fn a_pattern_too_deep_to_parse_is_answered_rather_than_aborted() {
        let deep = format!("{}a{}", "(".repeat(20_000), ")".repeat(20_000));
        assert!(!is_within_parser_limits(&deep));
        assert!(!compiles(&deep, ""), "answered, not aborted");
        assert!(!is_well_formed(&deep, ""));

        let wide = vec!["a"; 20_000].join("|");
        assert!(!is_within_parser_limits(&wide));
        assert!(!compiles(&wide, ""));
    }

    /// Nested character classes cost the parser stack under the `v`
    /// flag, where a class nests as a class rather than as a literal.
    /// Five hundred of them aborted a test thread, and no test written
    /// by hand had thought to try it.
    #[test]
    fn nested_character_classes_are_answered_rather_than_aborted() {
        let nested = "[".repeat(20_000);
        assert!(!is_within_parser_limits(&nested));
        for flags in ["", "v", "dgimsuvy"] {
            assert!(!compiles(&nested, flags), "{flags}");
            assert!(!is_well_formed(&nested, flags), "{flags}");
        }
    }

    /// The fuzzer's second finding, and the subtler one: a class
    /// followed by groups nobody closes. `]` outside a class is a
    /// literal, so counting brackets in pairs called this balanced while
    /// the parser recursed a thousand deep through it.
    #[test]
    fn unclosed_groups_after_a_class_still_count_as_depth() {
        let unbalanced = format!("-{}", "[(]+(]+".repeat(2_000));
        assert!(!is_within_parser_limits(&unbalanced));
        for flags in ["", "g", "dgimsuvy"] {
            assert!(!compiles(&unbalanced, flags), "{flags}");
        }
        // And the balanced spelling of the same characters is ordinary.
        assert!(is_within_parser_limits(&"[(]+[)]+".repeat(2_000)));
    }

    /// The bound has to leave ordinary patterns alone, and a bracket
    /// behind an escape is not a bracket at all.
    #[test]
    fn an_ordinary_pattern_is_within_the_parser_limits() {
        for pattern in [
            r"^\d{4}-\d{2}-\d{2}$",
            "(a+)+",
            "(?<name>a|b|c)*",
            r"[(|]+\(\|",
            "",
        ] {
            assert!(is_within_parser_limits(pattern), "{pattern}");
            assert!(compiles(pattern, ""), "{pattern}");
        }
        assert!(
            is_within_parser_limits(&"(a)".repeat(20_000)),
            "wide but never deep: 20,000 groups at depth one"
        );
        assert!(
            is_within_parser_limits(&r"\(\[".repeat(MAX_GROUP_DEPTH + 10)),
            "an escaped bracket is a literal, not a level"
        );
    }

    /// Exactly at the bound is judged; one past it is not. The pattern
    /// at the bound is judged on a stack of its own, which is the whole
    /// point of having one.
    #[test]
    fn the_parser_limits_are_inclusive() {
        let at = |depth: usize| format!("{}a{}", "(".repeat(depth), ")".repeat(depth));
        assert!(is_within_parser_limits(&at(MAX_GROUP_DEPTH)));
        assert!(compiles(&at(MAX_GROUP_DEPTH), ""), "judged, not refused");
        assert!(!is_within_parser_limits(&at(MAX_GROUP_DEPTH + 1)));

        let branches = |count: usize| vec!["a"; count + 1].join("|");
        assert!(is_within_parser_limits(&branches(MAX_ALTERNATION_BRANCHES)));
        assert!(compiles(&branches(MAX_ALTERNATION_BRANCHES), ""));
        assert!(!is_within_parser_limits(&branches(
            MAX_ALTERNATION_BRANCHES + 1
        )));
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
