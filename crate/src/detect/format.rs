//! Which language's regex spellings a document can hold.
//!
//! Two layers, matching the extension's split. `determine_language`
//! accepts VS Code language ids and nothing else, because that is what
//! the extension is handed by the editor. `resolve_format` widens for a
//! caller holding a filename or a loose alias.
//!
//! **The language is a hint, never a gate.** A document nothing
//! recognises is scanned for every form rather than refused: a caller
//! who cannot name the language should still get answers, and that is
//! also what this tool did before it knew languages existed.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Language {
    JavaScript,
    TypeScript,
    Python,
    Rust,
    Go,
    Java,
    Ruby,
    Php,
    CSharp,
}

impl Language {
    /// Whether a bare `/…/` can be a regex in this grammar.
    ///
    /// Three languages have the literal; everywhere else a regex is
    /// written at a call site. That matters because deciding whether a
    /// slash opens a regex or divides is a *guess* — see
    /// `heuristics::is_regex_context` — and a guess made in a language
    /// that has no regex literal is all cost and no finding: every path
    /// in a Python file reads as a pattern.
    pub(crate) fn has_slash_literals(self) -> bool {
        matches!(self, Self::JavaScript | Self::TypeScript | Self::Ruby)
    }
}

/// The language ids the extractor has forms for.
pub(crate) const SUPPORTED_FORMATS: [&str; 9] = [
    "javascript",
    "typescript",
    "python",
    "rust",
    "go",
    "java",
    "ruby",
    "php",
    "csharp",
];

pub(crate) fn determine_language(language_id: &str) -> Option<Language> {
    match language_id {
        "javascript" => Some(Language::JavaScript),
        "typescript" => Some(Language::TypeScript),
        "python" => Some(Language::Python),
        "rust" => Some(Language::Rust),
        "go" => Some(Language::Go),
        "java" => Some(Language::Java),
        "ruby" => Some(Language::Ruby),
        "php" => Some(Language::Php),
        "csharp" => Some(Language::CSharp),
        _ => None,
    }
}

/// Every language id the extractor understands, keyed by what a caller
/// might send.
///
/// Held equal to the extension's table by `fixtures/aliases.json`: the
/// two MCP servers offer the same `extract_patterns`, so a name one side
/// reads and the other ignores makes them two different tools rather
/// than one.
const ALIASES: [(&str, &str); 32] = [
    ("javascript", "javascript"),
    ("javascriptreact", "javascript"),
    ("js", "javascript"),
    ("jsx", "javascript"),
    ("mjs", "javascript"),
    ("cjs", "javascript"),
    ("typescript", "typescript"),
    ("typescriptreact", "typescript"),
    ("ts", "typescript"),
    ("tsx", "typescript"),
    ("mts", "typescript"),
    ("cts", "typescript"),
    ("python", "python"),
    ("py", "python"),
    ("pyi", "python"),
    ("pyw", "python"),
    ("rust", "rust"),
    ("rs", "rust"),
    ("go", "go"),
    ("golang", "go"),
    ("java", "java"),
    ("ruby", "ruby"),
    ("rb", "ruby"),
    ("rake", "ruby"),
    ("gemspec", "ruby"),
    ("php", "php"),
    ("phtml", "php"),
    ("csharp", "csharp"),
    ("cs", "csharp"),
    ("csx", "csharp"),
    // `c#` is what a model writes when asked to name the language, and
    // it is not a filename extension anything would resolve.
    ("c#", "csharp"),
    ("cake", "csharp"),
];

/// `raw.trim().toLowerCase().replace(/^\./, '')`, spelled out.
///
/// `str::trim` is not `String.prototype.trim`: Rust trims Unicode's
/// `White_Space`, JavaScript trims its own set, and the two disagree
/// about U+FEFF and U+0085. A format name arriving with a byte-order
/// mark resolved to Python on one server and to nothing on the other,
/// which — because an unresolved name means *every* language's spellings
/// are looked for — is not a refusal but two different pattern lists for
/// the same document.
fn normalise(value: &str) -> String {
    let trimmed = super::js::trim(value).to_lowercase();
    trimmed.strip_prefix('.').unwrap_or(&trimmed).to_string()
}

fn alias(key: &str) -> Option<&'static str> {
    ALIASES
        .iter()
        .find(|(from, _)| *from == key)
        .map(|(_, to)| *to)
}

/// Resolve a language id from an explicit format, else from a filename.
///
/// `None` means "nothing recognised it", which is an answer rather than
/// a failure: the caller scans every form.
pub(crate) fn resolve_format(format: Option<&str>, filename: Option<&str>) -> Option<&'static str> {
    if let Some(format) = format
        && let Some(direct) = alias(&normalise(format))
    {
        return Some(direct);
    }
    let filename = filename?;
    let extension = filename.rsplit_once('.').map(|(_, rest)| rest)?;
    alias(&normalise(extension))
}

/// The language a document is written in, from a format hint, a
/// filename, or neither.
pub(crate) fn resolve_language(format: Option<&str>, filename: Option<&str>) -> Option<Language> {
    resolve_format(format, filename).and_then(determine_language)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_ids_map_to_languages() {
        assert_eq!(determine_language("python"), Some(Language::Python));
        assert_eq!(determine_language("csharp"), Some(Language::CSharp));
        assert_eq!(determine_language("markdown"), None);
    }

    #[test]
    fn an_explicit_format_wins() {
        assert_eq!(resolve_format(Some("py"), None), Some("python"));
        assert_eq!(resolve_format(Some(".RS"), None), Some("rust"));
        assert_eq!(resolve_format(Some(" go "), None), Some("go"));
    }

    #[test]
    fn a_filename_resolves_by_extension() {
        assert_eq!(resolve_format(None, Some("app/main.py")), Some("python"));
        assert_eq!(resolve_format(None, Some("Program.cs")), Some("csharp"));
        assert_eq!(resolve_format(None, Some("a/b/lib.rs")), Some("rust"));
    }

    /// Nothing recognised is an answer, not a refusal — the caller
    /// scans every form, which is what this did before it knew
    /// languages existed.
    #[test]
    fn nothing_recognisable_returns_none() {
        assert_eq!(resolve_format(Some("kotlin"), None), None);
        assert_eq!(resolve_format(None, Some("notes.md")), None);
        assert_eq!(resolve_format(None, Some("Makefile")), None);
        assert_eq!(resolve_format(None, None), None);
    }

    /// Only the three grammars that actually have the literal, because
    /// the slash-versus-division walk is a guess and a Python path
    /// would read as a pattern.
    #[test]
    fn only_three_languages_have_slash_literals() {
        for language in [Language::JavaScript, Language::TypeScript, Language::Ruby] {
            assert!(language.has_slash_literals(), "{language:?}");
        }
        for language in [
            Language::Python,
            Language::Rust,
            Language::Go,
            Language::Java,
            Language::Php,
            Language::CSharp,
        ] {
            assert!(!language.has_slash_literals(), "{language:?}");
        }
    }

    /// Every format the schema advertises must resolve, or the tool
    /// names something it does not read.
    #[test]
    fn every_advertised_format_resolves() {
        for format in SUPPORTED_FORMATS {
            assert!(resolve_language(Some(format), None).is_some(), "{format}");
        }
    }

    #[test]
    fn every_alias_lands_on_a_known_language() {
        for (from, to) in ALIASES {
            assert!(determine_language(to).is_some(), "{from} -> {to}");
        }
    }

    /// The two frontends offer the same `extract_patterns`, so a name
    /// one reads and the other ignores makes them two different tools.
    /// `../scripts/check-extraction-parity.ts` is the other side of it.
    #[test]
    fn the_alias_table_matches_the_shared_contract() {
        let shared: std::collections::BTreeMap<String, String> =
            serde_json::from_str(include_str!("../../fixtures/aliases.json"))
                .expect("the alias contract is valid JSON");
        let mine: std::collections::BTreeMap<String, String> = ALIASES
            .iter()
            .map(|(from, to)| ((*from).to_string(), (*to).to_string()))
            .collect();
        assert_eq!(mine.len(), ALIASES.len(), "an alias is listed twice");
        assert_eq!(mine, shared);
    }
}
