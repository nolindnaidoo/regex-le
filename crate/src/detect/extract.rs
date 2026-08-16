//! Finding the regexes: literals, `RegExp` constructors, and the call
//! sites eight other languages write a pattern at.
//!
//! Whole-content matching, so a constructor split across lines is found.
//! A pattern-and-flags pair is reported **once, at its first
//! occurrence** — the output is a pattern list, not an occurrence list,
//! which is deliberate in the extension and ported here.
//!
//! **The language selects the forms, and nothing else.** With no
//! language every form is scanned for, which is close to what this did
//! when it knew only JavaScript: a caller who cannot name the language
//! gets answers rather than a refusal. What the language buys is
//! precision — a `.py` file is not scanned for bare `/…/` literals, so
//! `#!/usr/bin/env python` stops reading as a pattern.

use std::sync::LazyLock;

use fancy_regex::{Captures, Regex, RegexBuilder};
use serde::Serialize;

use super::format::Language;
use super::heuristics::{self, VALID_FLAGS};
use super::js;
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
/// fancy-regex's default backtracking budget is spent by a long enough
/// document rather than by a pathological pattern: the lookbehind sits
/// at the start, so there is no literal prefix to scan for and every
/// byte is a candidate start. A minified bundle on one line exhausts it
/// and the whole file comes back as a refusal.
///
/// Measured on 800 KB of one line, which needed roughly 20× the default.
/// The ceiling stays — a scan that cannot finish still says so rather
/// than reporting a clean file.
const BACKTRACK_LIMIT: usize = 100_000_000;

static CONSTRUCTOR: LazyLock<Regex> = LazyLock::new(|| {
    build(&format!(
        r#"(?<![.\w$])(?:new[{SPACE}]+)?RegExp[{SPACE}]*\([{SPACE}]*(?:'(?<sq>(?:[^'\\\r\n]|\\.)*)'|"(?<dq>(?:[^"\\\r\n]|\\.)*)")[{SPACE}]*(?:,[{SPACE}]*(?:'(?<sqf>[{VALID_FLAGS}]*)'|"(?<dqf>[{VALID_FLAGS}]*)")[{SPACE}]*)?,?[{SPACE}]*\)"#
    ))
});

fn build(source: &str) -> Regex {
    RegexBuilder::new(source)
        .backtrack_limit(BACKTRACK_LIMIT)
        .build()
        .expect("a constant pattern compiles")
}

/// JavaScript's `\s`, spelled out as a class body.
///
/// The extension writes `\s` in every one of these patterns, and `\s`
/// there is not `\s` here: `regex` reads Unicode's `White_Space`, which
/// holds U+0085 and not U+FEFF, and JavaScript reads the opposite. A
/// `re.compile` with a byte-order mark before its bracket was a pattern
/// to one server and nothing at all to the other. See `detect/js.rs`.
const SPACE: &str = js::JS_SPACE_CLASS;

/// A double-quoted string body, as JavaScript, Python, Java, Go, C# and
/// PHP all spell one: anything but a quote, a backslash or a newline,
/// plus any escape.
const DOUBLE_QUOTED: &str = r#"(?:[^"\\\r\n]|\\.)*"#;
/// The same, single-quoted.
const SINGLE_QUOTED: &str = r"(?:[^'\\\r\n]|\\.)*";

/// The group names a call form captures its pattern into.
///
/// A `raw*` group is the regex source verbatim — a Python or Rust raw
/// string, a Go backquoted string, a C# verbatim string — and a `esc*`
/// group is a quoted string, which escapes a level exactly as the
/// JavaScript constructor's argument does. Fixed names rather than a
/// per-form table, so one reader serves every form.
const RAW_GROUPS: [&str; 4] = ["raw1", "raw2", "raw3", "raw4"];
const ESCAPED_GROUPS: [&str; 4] = ["esc1", "esc2", "esc3", "esc4"];

/// A call site that takes a pattern.
///
/// Every language below `JavaScript` sets its flags with constants,
/// builder methods or an inline `(?i)` rather than a string argument, so
/// a call form reports no flags. Reading `re.I` or `RegexOptions` as a
/// JavaScript flag string is not something this could get right, and the
/// `ReDoS` scan does not depend on flags.
#[derive(Clone, Copy)]
struct CallForm {
    /// Named in the refusal when a scan gives up, so the message says
    /// which form ran out of budget rather than "a pattern".
    name: &'static str,
    matcher: &'static LazyLock<Regex>,
    /// PHP writes the delimiters and modifiers *inside* the string.
    delimited: bool,
}

static PYTHON: LazyLock<Regex> = LazyLock::new(|| {
    build(&format!(
        r#"(?<![A-Za-z0-9_$.])re\.(?:compile|fullmatch|finditer|findall|match|search|split|subn|sub)[{SPACE}]*\([{SPACE}]*(?:[rR][bB]?"""(?<raw1>[\s\S]*?)"""|[rR][bB]?'''(?<raw2>[\s\S]*?)'''|[rR][bB]?"(?<raw3>{DOUBLE_QUOTED})"|[rR][bB]?'(?<raw4>{SINGLE_QUOTED})'|"""(?<esc1>[\s\S]*?)"""|'''(?<esc2>[\s\S]*?)'''|"(?<esc3>{DOUBLE_QUOTED})"|'(?<esc4>{SINGLE_QUOTED})')"#
    ))
});

/// Rust raw strings carry an arbitrary run of hashes, so the closing
/// delimiter is a backreference to the opening one rather than a fixed
/// list of two or three levels.
static RUST: LazyLock<Regex> = LazyLock::new(|| {
    build(&format!(
        r#"(?<![A-Za-z0-9_$])(?:Regex|RegexBuilder)::new[{SPACE}]*\([{SPACE}]*(?:r(?<hash>#*)"(?<raw1>[\s\S]*?)"\k<hash>|"(?<esc1>{DOUBLE_QUOTED})")"#
    ))
});

static GO: LazyLock<Regex> = LazyLock::new(|| {
    build(&format!(
        r#"(?<![A-Za-z0-9_$.])regexp\.(?:MustCompilePOSIX|MustCompile|CompilePOSIX|Compile)[{SPACE}]*\([{SPACE}]*(?:`(?<raw1>[^`]*)`|"(?<esc1>{DOUBLE_QUOTED})")"#
    ))
});

static JAVA: LazyLock<Regex> = LazyLock::new(|| {
    build(&format!(
        r#"(?<![A-Za-z0-9_$])Pattern\.(?:compile|matches)[{SPACE}]*\([{SPACE}]*"(?<esc1>{DOUBLE_QUOTED})""#
    ))
});

static RUBY: LazyLock<Regex> = LazyLock::new(|| {
    build(&format!(
        r#"(?<![A-Za-z0-9_$])Regexp\.(?:new|compile)[{SPACE}]*\([{SPACE}]*(?:"(?<esc1>{DOUBLE_QUOTED})"|'(?<esc2>{SINGLE_QUOTED})')"#
    ))
});

static PHP: LazyLock<Regex> = LazyLock::new(|| {
    build(&format!(
        r#"(?<![A-Za-z0-9_$])preg_(?:match_all|match|replace_callback|replace|split|grep)[{SPACE}]*\([{SPACE}]*(?:'(?<esc1>{SINGLE_QUOTED})'|"(?<esc2>{DOUBLE_QUOTED})")"#
    ))
});

/// C# verbatim strings (`@"…"`) escape nothing but a doubled quote, so
/// the body is taken as written.
static CSHARP_NEW: LazyLock<Regex> = LazyLock::new(|| {
    build(&format!(
        r#"(?<![A-Za-z0-9_$])(?:new[{SPACE}]+)?Regex[{SPACE}]*\([{SPACE}]*(?:@"(?<raw1>(?:[^"]|"")*)"|"(?<esc1>{DOUBLE_QUOTED})")"#
    ))
});

/// The static methods take the subject first and the pattern second, so
/// the first argument is skipped. It is skipped as a string literal or
/// as a simple expression: a call or an index sitting there is out of
/// reach of a scan that does not parse C#.
static CSHARP_STATIC: LazyLock<Regex> = LazyLock::new(|| {
    build(&format!(
        r#"(?<![A-Za-z0-9_$])Regex\.(?:Matches|Match|IsMatch|Replace|Split|Count)[{SPACE}]*\([{SPACE}]*(?:@"(?:[^"]|"")*"|"{DOUBLE_QUOTED}"|[^,()"']*)[{SPACE}]*,[{SPACE}]*(?:@"(?<raw1>(?:[^"]|"")*)"|"(?<esc1>{DOUBLE_QUOTED})")"#
    ))
});

const PYTHON_FORM: CallForm = CallForm {
    name: "python",
    matcher: &PYTHON,
    delimited: false,
};
const RUST_FORM: CallForm = CallForm {
    name: "rust",
    matcher: &RUST,
    delimited: false,
};
const GO_FORM: CallForm = CallForm {
    name: "go",
    matcher: &GO,
    delimited: false,
};
const JAVA_FORM: CallForm = CallForm {
    name: "java",
    matcher: &JAVA,
    delimited: false,
};
const RUBY_FORM: CallForm = CallForm {
    name: "ruby",
    matcher: &RUBY,
    delimited: false,
};
const PHP_FORM: CallForm = CallForm {
    name: "php",
    matcher: &PHP,
    delimited: true,
};
const CSHARP_FORMS: [CallForm; 2] = [
    CallForm {
        name: "csharp",
        matcher: &CSHARP_NEW,
        delimited: false,
    },
    CallForm {
        name: "csharp",
        matcher: &CSHARP_STATIC,
        delimited: false,
    },
];

/// The call forms to scan a document for. With no language, all of
/// them: a form belonging to another language costs a scan and finds
/// nothing, which is cheaper than an answer that is missing.
fn call_forms(language: Option<Language>) -> Vec<CallForm> {
    match language {
        Some(Language::JavaScript | Language::TypeScript) => Vec::new(),
        Some(Language::Python) => vec![PYTHON_FORM],
        Some(Language::Rust) => vec![RUST_FORM],
        Some(Language::Go) => vec![GO_FORM],
        Some(Language::Java) => vec![JAVA_FORM],
        Some(Language::Ruby) => vec![RUBY_FORM],
        Some(Language::Php) => vec![PHP_FORM],
        Some(Language::CSharp) => CSHARP_FORMS.to_vec(),
        None => [
            PYTHON_FORM,
            RUST_FORM,
            GO_FORM,
            JAVA_FORM,
            RUBY_FORM,
            PHP_FORM,
        ]
        .into_iter()
        .chain(CSHARP_FORMS)
        .collect(),
    }
}

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

pub(crate) fn extract_patterns(
    text: &str,
    language: Option<Language>,
) -> Result<Vec<Pattern>, String> {
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

    // JavaScript, TypeScript and Ruby are the grammars with a bare
    // `/…/`, and the only ones the slash-versus-division walk runs for.
    if language.is_none_or(Language::has_slash_literals) {
        scan_literals(text, &mut push)?;
    }
    if language
        .is_none_or(|language| matches!(language, Language::JavaScript | Language::TypeScript))
    {
        scan_constructors(text, &mut push)?;
    }
    for form in call_forms(language) {
        scan_call_form(form, text, &mut push)?;
    }

    patterns.sort_by(|a, b| a.line.cmp(&b.line).then(a.column.cmp(&b.column)));
    Ok(patterns)
}

/// What extraction hands back for each pattern it finds: the source, the
/// flags, where it starts, and the text it was written as.
type Push<'a> = dyn FnMut(String, String, usize, String) + 'a;

fn scan_literals(text: &str, push: &mut Push<'_>) -> Result<(), String> {
    for found in LITERAL.find_iter(text) {
        let found = found.map_err(|error| format!("the literal pattern gave up: {error}"))?;
        let full = found.as_str();
        let last = full.rfind('/').expect("a literal has a closing slash");
        let body = &full[1..last];
        let flags = &full[last + 1..];
        if !heuristics::is_regex_context(text, found.start()) {
            continue;
        }
        // A bare `/…/` is a guess about a slash, not a declared pattern,
        // so one past the parser limits is dropped here rather than
        // refused: `compiles` answers `false` without asking the parser.
        // Refusing the file instead would exit 2 over a division chain
        // with a hundred brackets in it, which is the mistake the PNG
        // rule already taught this crate once.
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
    Ok(())
}

/// The refusal for a pattern the parser cannot be asked about.
///
/// It reads as a refusal rather than a clean result because that is what
/// it is: the shape is a pattern, and this could not judge it. Silence
/// would read to whoever ran the scan as a file with nothing in it. No
/// flag is named — an MCP caller has no command line.
fn too_complex(form: &str) -> String {
    format!(
        "the {form} pattern is nested past {} groups or carries more than {} alternation \
         branches, which cannot be judged without overflowing the stack",
        heuristics::MAX_GROUP_DEPTH,
        heuristics::MAX_ALTERNATION_BRANCHES
    )
}

fn scan_constructors(text: &str, push: &mut Push<'_>) -> Result<(), String> {
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
        // A constructor argument is unambiguously a pattern, so one this
        // cannot judge is refused by name rather than dropped.
        if !heuristics::is_within_parser_limits(&pattern) {
            return Err(too_complex("constructor"));
        }
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
    Ok(())
}

fn scan_call_form(form: CallForm, text: &str, push: &mut Push<'_>) -> Result<(), String> {
    for captures in form.matcher.captures_iter(text) {
        let captures =
            captures.map_err(|error| format!("the {} pattern gave up: {error}", form.name))?;
        let Some(body) = call_body(&captures) else {
            continue;
        };
        let candidate = if form.delimited {
            strip_php_delimiters(&body)
        } else {
            Some(body)
        };
        let Some(pattern) = candidate else {
            continue;
        };
        // A call argument is unambiguously a pattern, so one this cannot
        // judge is refused by name rather than dropped.
        if !heuristics::is_within_parser_limits(&pattern) {
            return Err(too_complex(form.name));
        }
        // The validity judge is the language-tolerant one: `regress`
        // speaks JavaScript, and a Python or Go pattern that it refuses
        // is far more often valid than a typo.
        if pattern.is_empty() || !heuristics::is_well_formed(&pattern, "") {
            continue;
        }
        let whole = captures.get(0).expect("a match has group zero");
        push(
            pattern,
            String::new(),
            whole.start(),
            whole.as_str().to_string(),
        );
    }
    Ok(())
}

/// The pattern a call form captured, unescaped when the language's
/// string literal escapes.
fn call_body(captures: &Captures<'_, str>) -> Option<String> {
    if let Some(found) = RAW_GROUPS.iter().find_map(|name| captures.name(name)) {
        return Some(found.as_str().to_string());
    }
    let found = ESCAPED_GROUPS.iter().find_map(|name| captures.name(name))?;
    Some(unescape_string_literal(found.as_str()))
}

/// PCRE's modifier letters, PHP-flavoured.
const PHP_MODIFIERS: &str = "imsxeADSUXJnu";

/// Strip the delimiters PHP writes inside the pattern string —
/// `'/(a+)+/i'`, `'#a+#'`, `'~a+~u'`, `'{a+}'`.
///
/// The modifiers are dropped rather than reported as flags: PHP's set is
/// not JavaScript's, and handing `x` to a JavaScript parser would report
/// a working PCRE pattern as a syntax error. The bracket pairs and the
/// common single-character delimiters are handled; a delimiter that is a
/// letter or a digit is not one PHP accepts, and is refused rather than
/// guessed at.
fn strip_php_delimiters(value: &str) -> Option<String> {
    let open = value.chars().next()?;
    // `/[A-Za-z0-9\\\s]/` on the extension side, and `\s` there is
    // JavaScript's set rather than Unicode's — a byte-order mark is
    // whitespace to it and not to `char::is_whitespace`.
    if open.is_ascii_alphanumeric() || open == '\\' || js::is_js_whitespace(open) {
        return None;
    }
    let close = match open {
        '(' => ')',
        '{' => '}',
        '[' => ']',
        '<' => '>',
        same => same,
    };
    let end = value.rfind(close).filter(|at| *at > 0)?;
    let modifiers = &value[end + close.len_utf8()..];
    if !modifiers
        .chars()
        .all(|letter| PHP_MODIFIERS.contains(letter))
    {
        return None;
    }
    Some(value[open.len_utf8()..end].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values_in(text: &str, language: Option<Language>) -> Vec<(String, String)> {
        extract_patterns(text, language)
            .expect("the patterns hold")
            .into_iter()
            .map(|found| (found.pattern, found.flags))
            .collect()
    }

    /// With no language every form is scanned for, which is what a
    /// caller who cannot name one gets.
    fn values(text: &str) -> Vec<(String, String)> {
        values_in(text, None)
    }

    fn patterns_in(text: &str, language: Language) -> Vec<String> {
        values_in(text, Some(language))
            .into_iter()
            .map(|(pattern, _)| pattern)
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
        let found = extract_patterns("const a = /x+/g;\nconst b = /x+/g;\n", None)
            .expect("the patterns hold");
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
        let found = extract_patterns("new RegExp('z+')\nconst a = /a+/;\n", None)
            .expect("the patterns hold");
        assert_eq!(found[0].line, 1);
        assert_eq!(found[1].line, 2);
    }

    #[test]
    fn the_verdict_travels_with_the_pattern() {
        let found = extract_patterns("const re = /(a+)+b/;", None).expect("the patterns hold");
        assert!(found[0].redos.detected);
        assert_eq!(found[0].redos.severity, super::redos::Severity::High);
    }

    /// The regression the corpus could not have caught: a document long
    /// enough to spend the backtracking budget came back as a refusal,
    /// so a minified bundle reported nothing rather than its patterns.
    #[test]
    fn a_long_single_line_document_is_scanned_rather_than_refused() {
        let content = "const a = /x/g; const b = total / count; ".repeat(20_000);
        let patterns = extract_patterns(&content, None).expect("a scan, not a refusal");
        assert_eq!(patterns.len(), 1, "collapsed to its first occurrence");
        assert_eq!(patterns[0].pattern, "x");
    }

    /// The seven regressions this whole language pass exists for: a
    /// catastrophic pattern in each grammar, found and flagged high.
    ///
    /// `(a+)+b`, not the bare `(a+)+` this used to carry. The loop alone
    /// succeeds on any input holding an `a`, so nothing makes it
    /// backtrack — measured, not assumed. The `b` is what forces the
    /// failure the loop then pays for, which is why the literature
    /// always writes it that way.
    #[test]
    fn the_exponential_shape_is_found_in_every_language() {
        for (language, text) in [
            (Language::Python, r#"BAD = re.compile(r"(a+)+b")"#),
            (Language::Rust, r#"let bad = Regex::new(r"(a+)+b");"#),
            (Language::Go, "var bad = regexp.MustCompile(`(a+)+b`)"),
            (Language::Java, r#"Pattern.compile("(a+)+b");"#),
            (Language::Ruby, "BAD = /(a+)+b/"),
            (Language::Php, "preg_match('/(a+)+b/', $s);"),
            (Language::CSharp, r#"var bad = new Regex(@"(a+)+b");"#),
        ] {
            let found = extract_patterns(text, Some(language)).expect("the patterns hold");
            assert_eq!(found.len(), 1, "{language:?}");
            assert_eq!(found[0].pattern, "(a+)+b", "{language:?}");
            assert_eq!(
                found[0].redos.severity,
                super::redos::Severity::High,
                "{language:?}"
            );
        }
    }

    /// A raw string is the regex source; a quoted one escapes a level.
    #[test]
    fn a_raw_string_is_verbatim_and_a_quoted_one_escapes() {
        assert_eq!(
            patterns_in(r#"re.compile(r"\d+")"#, Language::Python),
            [r"\d+"]
        );
        assert_eq!(
            patterns_in(r#"re.compile("\\d+")"#, Language::Python),
            [r"\d+"]
        );
        assert_eq!(
            patterns_in(r#"Regex::new("\\d+")"#, Language::Rust),
            [r"\d+"]
        );
        assert_eq!(
            patterns_in(r#"regexp.Compile("\\d+")"#, Language::Go),
            [r"\d+"]
        );
    }

    /// Rust's raw strings take any number of hashes, so the closing
    /// delimiter has to match the opening one rather than the first
    /// quote it meets.
    #[test]
    fn a_rust_raw_string_closes_on_its_own_hashes() {
        assert_eq!(
            patterns_in(r##"Regex::new(r#"a"b+"#)"##, Language::Rust),
            [r#"a"b+"#]
        );
        assert_eq!(
            patterns_in(r###"Regex::new(r##"a"#b+"##)"###, Language::Rust),
            [r##"a"#b+"##]
        );
    }

    /// The three Python argument forms the extension names.
    #[test]
    fn python_reads_its_string_forms() {
        assert_eq!(
            patterns_in(r"re.search(r'^[a-z]+$', s)", Language::Python),
            ["^[a-z]+$"]
        );
        assert_eq!(
            patterns_in(r#"re.sub("""a|ab""", "", s)"#, Language::Python),
            ["a|ab"]
        );
        assert!(patterns_in("score.compile(r'x')", Language::Python).is_empty());
    }

    /// PHP writes the delimiters and the modifiers inside the string,
    /// and the modifiers are dropped rather than reported as flags a
    /// JavaScript engine would refuse.
    #[test]
    fn php_delimiters_are_stripped_and_modifiers_dropped() {
        assert_eq!(
            values_in("preg_replace('#(a+)+#ix', '', $s);", Some(Language::Php)),
            [("(a+)+".to_string(), String::new())]
        );
        assert_eq!(
            patterns_in("preg_split('~\\d+~', $s);", Language::Php),
            [r"\d+"]
        );
        assert_eq!(
            patterns_in("preg_match('{^[a-z]+$}', $s);", Language::Php),
            ["^[a-z]+$"]
        );
        assert!(
            strip_php_delimiters("abc").is_none(),
            "a letter is not a delimiter PHP accepts"
        );
        assert!(strip_php_delimiters("/a+").is_none(), "never closed");
    }

    /// The static methods take the subject first, so reading argument
    /// one as the pattern would report a variable name.
    #[test]
    fn csharp_reads_the_pattern_argument_not_the_subject() {
        assert_eq!(
            patterns_in(r#"Regex.IsMatch(input, @"(a+)+")"#, Language::CSharp),
            ["(a+)+"]
        );
        assert_eq!(
            patterns_in(r#"Regex.Replace("abc", "\\s+", "")"#, Language::CSharp),
            [r"\s+"]
        );
    }

    /// Only the three grammars with a bare literal are asked the
    /// slash-versus-division question at all, so a Python path stops
    /// reading as a pattern.
    #[test]
    fn a_path_in_python_is_not_a_pattern() {
        let text = "#!/usr/bin/env python\nROOT = \"/var/log/app.log\"\n";
        assert!(patterns_in(text, Language::Python).is_empty());
        assert!(
            !values(text).is_empty(),
            "with no language the slash walk still runs, as it always did"
        );
    }

    /// Ruby joins JavaScript and TypeScript in having the literal.
    #[test]
    fn ruby_has_both_a_literal_and_a_constructor() {
        assert_eq!(patterns_in("BAD = /(a+)+/", Language::Ruby), ["(a+)+"]);
        assert_eq!(
            patterns_in("BUILT = Regexp.new('(a|ab)+')", Language::Ruby),
            ["(a|ab)+"]
        );
        assert!(
            patterns_in("ratio = a / b / 2", Language::Ruby).is_empty(),
            "division is division in Ruby too"
        );
    }

    /// A `RegExp` constructor is JavaScript's, and a Python document
    /// holding the word is not scanned for one.
    #[test]
    fn a_language_scans_only_its_own_forms() {
        assert!(patterns_in("new RegExp('a+b', 'g')", Language::Python).is_empty());
        assert!(patterns_in(r#"re.compile(r"(a+)+")"#, Language::Go).is_empty());
    }

    /// Ordinary Python that `regress` refuses: reported and judged on
    /// its shape rather than dismissed as a syntax error.
    #[test]
    fn a_pattern_javascript_cannot_parse_is_still_read() {
        let found = extract_patterns(r#"re.compile(r"(?P<w>\w+)+@")"#, Some(Language::Python))
            .expect("the patterns hold");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].pattern, r"(?P<w>\w+)+@", "reported as written");
        assert_eq!(found[0].redos.severity, super::redos::Severity::High);
    }

    /// The regression a fuzzer found. A pattern nested past what
    /// `regress` can parse used to abort the process on `SIGABRT`,
    /// taking the whole tree's scan with it. Where the text is
    /// unambiguously a pattern the answer is a refusal that names it,
    /// never silence.
    #[test]
    fn a_pattern_too_deep_to_parse_is_refused_rather_than_aborted() {
        let deep = format!("{}a{}", "(".repeat(20_000), ")".repeat(20_000));

        let error = extract_patterns(&format!(r#"re.compile(r"{deep}")"#), Some(Language::Python))
            .expect_err("a refusal");
        assert!(error.contains("python"), "{error}");
        assert!(error.contains("nested past"), "{error}");

        let error =
            extract_patterns(&format!("new RegExp('{deep}')"), None).expect_err("a refusal");
        assert!(error.contains("constructor"), "{error}");
    }

    /// A bare `/…/` is a guess about a slash rather than a declared
    /// pattern, so the same shape is dropped there instead of failing
    /// the file — the division chain in a minified bundle is not a
    /// reason to refuse to answer about the rest of it.
    #[test]
    fn a_slash_literal_too_deep_to_parse_is_dropped_not_refused() {
        let deep = format!("{}a{}", "(".repeat(20_000), ")".repeat(20_000));
        let found = extract_patterns(&format!("const p = /{deep}/;\nconst q = /(a+)+/;\n"), None)
            .expect("the rest of the document still answers");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].pattern, "(a+)+");
    }

    /// A real syntax error is still a real syntax error.
    #[test]
    fn a_broken_pattern_is_still_dropped() {
        assert!(patterns_in(r#"re.compile(r"a{2,1}")"#, Language::Python).is_empty());
        assert!(patterns_in(r#"re.compile(r"")"#, Language::Python).is_empty());
    }
}
