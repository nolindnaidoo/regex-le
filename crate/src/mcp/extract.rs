//! `extract_patterns` — the tool **both** servers offer.
//!
//! The npm server (`src/mcp/tools.ts`) and this one are meant to be the
//! same tool, not two similar ones: same schema, same envelope,
//! byte-identical output. `fixtures/mcp-extract-patterns.json` runs
//! against both, so changing one without the other fails a build.
//!
//! It touches no filesystem. An agent already has file-read tools;
//! duplicating them here would add a path-traversal surface for no
//! capability. The tool that needs a filesystem is `regex_le_lint`.

use serde_json::{Value, json};

use crate::detect::extract::extract_patterns;
use crate::detect::format::{SUPPORTED_FORMATS, resolve_language};

const DEFAULT_MAX_RESULTS: usize = 500;
const MAX_MAX_RESULTS: usize = 5000;

pub(crate) fn definition() -> Value {
    json!({
        "name": "extract_patterns",
        "description": "Find every regular expression in a document — JavaScript and \
                        TypeScript literals and RegExp constructors, and the call sites \
                        Python, Rust, Go, Java, Ruby, PHP and C# write a pattern at — with \
                        1-based line and column and a ReDoS verdict for each. Nothing is \
                        executed: the verdict comes from the shape of the pattern text. It \
                        flags dangerous shapes and cannot prove a pattern safe.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "content": { "type": "string", "description": "The document text to scan." },
                "format": {
                    "type": "string",
                    "description": format!(
                        "Language of the document, so only its own spellings are looked for: \
                         {}. Common extensions and aliases are accepted. Optional — with no \
                         language every spelling is looked for, which finds more and \
                         mistakes a path for a pattern more often.",
                        SUPPORTED_FORMATS.join(", ")
                    ),
                },
                "filename": {
                    "type": "string",
                    "description": "Filename used to infer the language when `format` is \
                                    absent, e.g. \"validate.py\".",
                },
                "maxResults": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_MAX_RESULTS,
                    "default": DEFAULT_MAX_RESULTS,
                    "description": format!(
                        "Cap on returned patterns (default {DEFAULT_MAX_RESULTS}). \
                         meta.truncated reports whether any were dropped."
                    ),
                },
            },
            "required": ["content"],
            "additionalProperties": false,
        },
    })
}

pub(crate) fn run(arguments: &Value) -> Result<Value, String> {
    let content = arguments
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| "content is required and must be a string".to_string())?;
    let max_results = read_max_results(arguments)?;
    let format = arguments.get("format").and_then(Value::as_str);
    let filename = arguments.get("filename").and_then(Value::as_str);
    let language = resolve_language(format, filename);

    // Named rather than silently ignored: a caller who asked for Kotlin
    // and got JavaScript's answers should be told which question was
    // actually run. It is a warning, not an error — the scan happened.
    let mut diagnostics: Vec<Value> = Vec::new();
    if language.is_none()
        && let Some(named) = format.or(filename)
    {
        diagnostics.push(json!({
            "severity": "warning",
            "code": "unknown-format",
            "message": format!(
                "no regex spellings are known for {named}, so every spelling was looked for"
            ),
        }));
    }

    let patterns = match extract_patterns(content, language) {
        Ok(patterns) => patterns,
        // A refusal, not an empty document: reporting no patterns when
        // the scan gave up would have a model conclude the file is
        // clean.
        Err(message) => {
            diagnostics.push(json!({
                "severity": "error",
                "code": "incomplete",
                "message": message,
            }));
            Vec::new()
        }
    };

    let mut values: Vec<Value> = patterns
        .iter()
        .map(|pattern| serde_json::to_value(pattern).expect("a pattern serializes"))
        .collect();

    // The `truncated` flag matters more than the cap: a silently
    // incomplete answer is wrong in the most expensive way.
    let truncated = values.len() > max_results;
    values.truncate(max_results);

    let count = values.len();
    Ok(super::envelope(
        "extract_patterns",
        &json!({ "patterns": values }),
        count,
        &diagnostics,
        truncated,
    ))
}

/// Clamp quietly, reject loudly — the npm server's asymmetry.
fn read_max_results(arguments: &Value) -> Result<usize, String> {
    let Some(raw) = arguments.get("maxResults") else {
        return Ok(DEFAULT_MAX_RESULTS);
    };
    let invalid = "maxResults must be a positive integer".to_string();
    let value = raw.as_u64().ok_or(invalid.clone())?;
    if value < 1 {
        return Err(invalid);
    }
    Ok(usize::try_from(value)
        .unwrap_or(MAX_MAX_RESULTS)
        .min(MAX_MAX_RESULTS))
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::*;
    use crate::detect::corpus::document;

    const CASES: &str = include_str!("../../fixtures/mcp-extract-patterns.json");

    #[derive(Debug, Deserialize)]
    struct Case {
        name: String,
        file: Option<String>,
        content: Option<String>,
        arguments: Value,
        expected: Option<Value>,
        #[serde(rename = "expectedError")]
        expected_error: Option<String>,
    }

    #[test]
    fn every_shared_case_answers_identically() {
        let cases: Vec<Case> = serde_json::from_str(CASES).expect("the corpus is valid JSON");
        assert!(!cases.is_empty(), "the corpus is empty");

        for case in cases {
            let mut arguments = case.arguments.clone();
            let content = case
                .file
                .as_deref()
                .map(document)
                .map(str::to_string)
                .or(case.content);
            if let Some(content) = content {
                arguments["content"] = json!(content);
            }

            match (case.expected, case.expected_error) {
                (_, Some(expected)) => {
                    assert_eq!(
                        run(&arguments).expect_err(&case.name),
                        expected,
                        "{}",
                        case.name
                    );
                }
                (Some(expected), None) => {
                    assert_eq!(
                        run(&arguments).expect(&case.name),
                        expected,
                        "{}",
                        case.name
                    );
                }
                (None, None) => panic!("{} pins neither a result nor an error", case.name),
            }
        }
    }

    #[test]
    fn the_tool_name_is_pinned() {
        assert_eq!(definition()["name"], "extract_patterns");
    }

    /// The tester half is not here, and the schema may not imply it is.
    #[test]
    fn the_schema_offers_no_text_to_match_against() {
        let definition = definition();
        let properties = definition["inputSchema"]["properties"]
            .as_object()
            .expect("properties");
        for absent in ["text", "input", "subject", "timeout"] {
            assert!(!properties.contains_key(absent), "{absent} is offered");
        }
    }

    #[test]
    fn a_fractional_cap_is_refused() {
        let error = run(&json!({ "content": "x", "maxResults": 1.5 })).expect_err("a refusal");
        assert_eq!(error, "maxResults must be a positive integer");
    }
}
