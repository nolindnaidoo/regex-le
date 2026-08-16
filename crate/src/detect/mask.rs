//! The spans of a document that are prose, not code.
//!
//! A regex written inside a comment is an *example* — documentation, a
//! line someone commented out, a `JSDoc` block explaining the very hazard
//! this tool reports. Scanning it finds a pattern nobody runs, and the
//! finding is worse than noise: it fails a build over a sentence.
//!
//! **The rule is about where a candidate starts, not where it sits.**
//! `re.compile(r"(a+)+b")` has its pattern inside a string and is a real
//! call; a docstring holding that whole line has the *call itself*
//! inside a string and is prose. Testing the start offset separates the
//! two with no parser and no per-language special case:
//!
//! ```text
//! re.compile(r"(a+)+b")     call starts in code  → scanned
//! """ re.compile(r"(a+)+b") """   call starts in a string → skipped
//! ```
//!
//! This is a lexer for comments and strings and nothing else. It does not
//! parse the language; it tracks just enough to know when a quote closes
//! and when a comment ends, which is what makes it cheap enough to run
//! over every document before extraction.

use super::format::Language;

/// A half-open byte range that extraction should not start a match in.
type Span = (usize, usize);

/// Every comment and string span in the document, sorted and
/// non-overlapping.
///
/// With no language, nothing is masked. A document whose grammar is
/// unknown is scanned for every spelling at once — see
/// `extract_patterns` — and a comment rule guessed from the wrong
/// grammar would drop real patterns rather than phantom ones. Finding an
/// example regex in a comment is the lesser error.
pub(crate) fn prose_spans(text: &str, language: Option<Language>) -> Vec<Span> {
    let Some(language) = language else {
        return Vec::new();
    };
    match language {
        Language::Python => scan(text, &Syntax::PYTHON),
        Language::Ruby => scan(text, &Syntax::RUBY),
        Language::Rust => scan(text, &Syntax::RUST),
        Language::Go => scan(text, &Syntax::GO),
        Language::CSharp => scan(text, &Syntax::CSHARP),
        Language::Php => scan(text, &Syntax::PHP),
        Language::JavaScript | Language::TypeScript | Language::Java => scan(text, &Syntax::C_LIKE),
    }
}

/// Whether an offset falls inside one of the spans.
///
/// Binary search rather than a walk: `scan_literals` asks once per
/// candidate slash, and a minified bundle has thousands of them.
pub(crate) fn is_prose(spans: &[Span], offset: usize) -> bool {
    spans
        .binary_search_by(|&(start, end)| {
            if offset < start {
                std::cmp::Ordering::Greater
            } else if offset >= end {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

/// What a grammar spells its comments and strings with.
struct Syntax {
    line_comments: &'static [&'static str],
    /// Opener and closer, e.g. `("/*", "*/")`.
    block_comments: &'static [(&'static str, &'static str)],
    /// Quote characters whose strings honour a `\` escape.
    escaped_quotes: &'static [char],
    /// Openers and closers for strings that take no escape — Go's
    /// backticks, Python's triple quotes, C#'s verbatim strings.
    raw_strings: &'static [(&'static str, &'static str)],
    /// Rust's `r#"…"#`, whose closer depends on the opener's hash count.
    rust_raw_strings: bool,
}

impl Syntax {
    const C_LIKE: Self = Self {
        line_comments: &["//"],
        block_comments: &[("/*", "*/")],
        escaped_quotes: &['"', '\'', '`'],
        raw_strings: &[],
        rust_raw_strings: false,
    };
    const PYTHON: Self = Self {
        line_comments: &["#"],
        block_comments: &[],
        escaped_quotes: &['"', '\''],
        // Triple quotes first: they must win over the single-quote rule
        // that shares their first character.
        raw_strings: &[("\"\"\"", "\"\"\""), ("'''", "'''")],
        rust_raw_strings: false,
    };
    const RUBY: Self = Self {
        line_comments: &["#"],
        block_comments: &[("=begin", "=end")],
        escaped_quotes: &['"', '\''],
        raw_strings: &[],
        rust_raw_strings: false,
    };
    const RUST: Self = Self {
        line_comments: &["//"],
        block_comments: &[("/*", "*/")],
        escaped_quotes: &['"'],
        raw_strings: &[],
        rust_raw_strings: true,
    };
    const GO: Self = Self {
        line_comments: &["//"],
        block_comments: &[("/*", "*/")],
        escaped_quotes: &['"'],
        raw_strings: &[("`", "`")],
        rust_raw_strings: false,
    };
    const CSHARP: Self = Self {
        line_comments: &["//"],
        block_comments: &[("/*", "*/")],
        escaped_quotes: &['"', '\''],
        raw_strings: &[("@\"", "\"")],
        rust_raw_strings: false,
    };
    const PHP: Self = Self {
        line_comments: &["//", "#"],
        block_comments: &[("/*", "*/")],
        escaped_quotes: &['"', '\''],
        raw_strings: &[],
        rust_raw_strings: false,
    };
}

fn scan(text: &str, syntax: &Syntax) -> Vec<Span> {
    let bytes = text.as_bytes();
    let mut spans: Vec<Span> = Vec::new();
    let mut at = 0usize;

    while at < bytes.len() {
        if let Some(end) = block_comment_end(text, at, syntax) {
            spans.push((at, end));
            at = end;
            continue;
        }
        if let Some(end) = line_comment_end(text, at, syntax) {
            spans.push((at, end));
            at = end;
            continue;
        }
        if let Some(end) = raw_string_end(text, at, syntax) {
            spans.push((at, end));
            at = end;
            continue;
        }
        if let Some(end) = quoted_string_end(text, at, syntax) {
            spans.push((at, end));
            at = end;
            continue;
        }
        at += 1;
        while at < bytes.len() && !text.is_char_boundary(at) {
            at += 1;
        }
    }
    spans
}

fn line_comment_end(text: &str, at: usize, syntax: &Syntax) -> Option<usize> {
    let opener = syntax
        .line_comments
        .iter()
        .find(|opener| text[at..].starts_with(**opener))?;
    let rest = at + opener.len();
    // The newline itself stays out: nothing starts a match on it, and
    // leaving it unmasked keeps the spans from touching.
    Some(text[rest..].find('\n').map_or(text.len(), |at| rest + at))
}

fn block_comment_end(text: &str, at: usize, syntax: &Syntax) -> Option<usize> {
    let (opener, closer) = syntax
        .block_comments
        .iter()
        .find(|(opener, _)| text[at..].starts_with(*opener))?;
    let rest = at + opener.len();
    // **An unterminated block comment runs to the end of the document**,
    // which is what the compiler does with one. Ending the span at the
    // opener instead would scan the rest of the file as code.
    Some(
        text[rest..]
            .find(closer)
            .map_or(text.len(), |found| rest + found + closer.len()),
    )
}

fn raw_string_end(text: &str, at: usize, syntax: &Syntax) -> Option<usize> {
    if syntax.rust_raw_strings
        && let Some(end) = rust_raw_string_end(text, at)
    {
        return Some(end);
    }
    let (opener, closer) = syntax
        .raw_strings
        .iter()
        .find(|(opener, _)| text[at..].starts_with(*opener))?;
    let rest = at + opener.len();
    Some(
        text[rest..]
            .find(closer)
            .map_or(text.len(), |found| rest + found + closer.len()),
    )
}

/// `r"…"`, `r#"…"#`, `r##"…"##` — the closer carries the opener's hashes.
fn rust_raw_string_end(text: &str, at: usize) -> Option<usize> {
    let rest = text[at..].strip_prefix('r')?;
    let hashes = rest.len() - rest.trim_start_matches('#').len();
    let rest = &rest[hashes..];
    let body = rest.strip_prefix('"')?;
    let closer = format!("\"{}", "#".repeat(hashes));
    let opened = at + 1 + hashes + 1;
    Some(
        body.find(&closer)
            .map_or(text.len(), |found| opened + found + closer.len()),
    )
}

fn quoted_string_end(text: &str, at: usize, syntax: &Syntax) -> Option<usize> {
    let quote = text[at..].chars().next()?;
    if !syntax.escaped_quotes.contains(&quote) {
        return None;
    }
    let mut chars = text[at + quote.len_utf8()..].char_indices();
    while let Some((offset, character)) = chars.next() {
        if character == '\\' {
            // Skip whatever the backslash escapes, including a quote.
            chars.next();
            continue;
        }
        if character == quote {
            return Some(at + quote.len_utf8() + offset + character.len_utf8());
        }
        // A single-quoted or double-quoted string does not span lines in
        // any of these grammars. An unterminated one is a typo, and
        // running its span to the end of the document would hide the
        // whole file from extraction.
        if character == '\n' && quote != '`' {
            return Some(at + quote.len_utf8() + offset);
        }
    }
    Some(text.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn masked(text: &str, language: Language, needle: &str) -> bool {
        let spans = prose_spans(text, Some(language));
        let offset = text.find(needle).expect("the needle is in the text");
        is_prose(&spans, offset)
    }

    #[test]
    fn a_line_comment_is_prose_and_the_next_line_is_not() {
        let text = "// const bad = /(a+)+b/;\nconst ok = /[a-z]+/;\n";
        assert!(masked(text, Language::JavaScript, "/(a+)+b/"));
        assert!(!masked(text, Language::JavaScript, "/[a-z]+/"));
    }

    /// The bug this module exists for: a `JSDoc` block spans lines, and a
    /// per-line view of comments only masked the first one.
    #[test]
    fn a_block_comment_is_prose_across_every_line_it_spans() {
        let text = "/**\n * Example: /(a+)+b/ is dangerous.\n */\nconst ok = /[a-z]+/;\n";
        assert!(masked(text, Language::JavaScript, "/(a+)+b/"));
        assert!(!masked(text, Language::JavaScript, "/[a-z]+/"));
    }

    #[test]
    fn an_unterminated_block_comment_runs_to_the_end() {
        let text = "/* opened and never closed\nconst bad = /(a+)+b/;\n";
        assert!(masked(text, Language::JavaScript, "/(a+)+b/"));
    }

    /// The distinction the whole module turns on: the argument of a real
    /// call is inside a string, and the call is not.
    #[test]
    fn a_call_outside_a_string_is_code_even_though_its_argument_is_not() {
        let text = "GOOD = re.compile(r\"[a-z]+\")\n";
        assert!(!masked(text, Language::Python, "re.compile"));
        assert!(masked(text, Language::Python, "\"[a-z]+\""));
    }

    #[test]
    fn a_python_docstring_is_prose_including_the_calls_inside_it() {
        let text =
            "\"\"\"\nExample: re.compile(r\"(a+)+b\")\n\"\"\"\nGOOD = re.compile(r\"[a-z]+\")\n";
        assert!(masked(text, Language::Python, "re.compile(r\"(a+)+b\")"));
        assert!(!masked(text, Language::Python, "re.compile(r\"[a-z]+\")"));
    }

    #[test]
    fn a_hash_comment_is_prose_in_python_and_ruby() {
        let text = "# re.compile(r\"(a+)+b\")\nGOOD = 1\n";
        assert!(masked(text, Language::Python, "re.compile"));
        assert!(masked("# /(a+)+b/\nOK = 1\n", Language::Ruby, "/(a+)+b/"));
    }

    #[test]
    fn ruby_block_comments_are_prose() {
        let text = "=begin\n/(a+)+b/\n=end\nok = /[a-z]+/\n";
        assert!(masked(text, Language::Ruby, "/(a+)+b/"));
        assert!(!masked(text, Language::Ruby, "/[a-z]+/"));
    }

    #[test]
    fn a_rust_raw_string_closes_on_its_own_hashes() {
        let text = "let a = r#\"say \"hi\" here\"#;\nlet b = Regex::new(r\"[a-z]+\");\n";
        assert!(masked(text, Language::Rust, "\"hi\""));
        assert!(!masked(text, Language::Rust, "Regex::new"));
    }

    #[test]
    fn a_go_backtick_string_spans_lines() {
        let text = "var a = `line one\nregexp.MustCompile(`\nvar b = 1\n";
        assert!(masked(text, Language::Go, "regexp.MustCompile"));
    }

    #[test]
    fn an_escaped_quote_does_not_close_a_string() {
        let text = "const a = \"he said \\\" /(a+)+b/ \";\nconst ok = /[a-z]+/;\n";
        assert!(masked(text, Language::JavaScript, "/(a+)+b/"));
        assert!(!masked(text, Language::JavaScript, "/[a-z]+/"));
    }

    /// An unterminated single-quoted string is a typo. Running its span
    /// to the end of the file would hide every real pattern below it.
    #[test]
    fn an_unterminated_quote_ends_at_the_line() {
        let text = "const a = \"oops;\nconst ok = /[a-z]+/;\n";
        assert!(!masked(text, Language::JavaScript, "/[a-z]+/"));
    }

    #[test]
    fn an_unknown_language_masks_nothing() {
        let text = "// const bad = /(a+)+b/;\n";
        assert!(prose_spans(text, None).is_empty());
    }

    #[test]
    fn spans_are_sorted_and_do_not_overlap() {
        let text = "// one\nconst a = \"two\";\n/* three */\nconst b = 'four';\n";
        let spans = prose_spans(text, Some(Language::JavaScript));
        assert!(spans.len() >= 4, "{spans:?}");
        for pair in spans.windows(2) {
            assert!(pair[0].1 <= pair[1].0, "{spans:?}");
        }
    }

    #[test]
    fn a_url_inside_a_comment_does_not_leak_a_pattern() {
        let text = "// see https://example.com/docs/x\nconst ok = /[a-z]+/;\n";
        assert!(masked(text, Language::JavaScript, "https://"));
        assert!(!masked(text, Language::JavaScript, "/[a-z]+/"));
    }
}
