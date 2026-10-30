//! The agent surface: the same extraction over the Model Context
//! Protocol on stdio, so a model can ask for the URLs rather than be
//! handed the files and pattern-match them itself.
//!
//! Three rules the family's MCP surfaces established:
//!
//! - **An empty answer is not an error.** A document with no URLs comes
//!   back as an ordinary result carrying `ok: true` — the scan ran.
//!   Only a malformed question is a protocol error.
//! - **Refusals speak the caller's vocabulary.** An MCP caller has no
//!   command line, so no message here mentions a flag.
//! - **A malformed frame is answered in the npm server's words.** Three
//!   servers ship from this repository, and a client cannot be allowed to
//!   tell them apart by what it sent: the same frame limit, the same
//!   parse errors, the same reading of a null id and of an unknown
//!   method, tool or argument. `scripts/check-cli-pipes.ts` feeds both
//!   binaries the malformed frames and compares the replies.
//!
//! Read-only by construction: nothing on this surface writes, so unlike
//! pixelactions there is no consent gate to design.

pub(crate) mod extract;

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::process::ExitCode;

use serde_json::{Value, json};

use crate::detect::redos::Severity;
use crate::scan::{self, ScanOptions};
use crate::walk::{self, WalkOptions};

const PROTOCOL_VERSION: &str = "2025-06-18";

/// The most bytes one frame may hold before it is refused.
///
/// Input with no newline was held whole: a 16 MiB line was read and
/// answered, and a client streaming without one grew the process without
/// bound. The same figure and message as the npm server's, so a caller
/// diffing the two finds nothing.
pub(crate) const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

/// JSON-RPC error codes, from the spec.
const PARSE_ERROR: i64 = -32700;
const INVALID_PARAMS: i64 = -32602;
const METHOD_NOT_FOUND: i64 = -32601;

pub(crate) fn serve() -> ExitCode {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    serve_streams(stdin.lock(), stdout.lock())
}

/// The stdio loop over any pair of streams, so a test can drive it with
/// bytes.
///
/// Reads newline-delimited JSON. A line that is not UTF-8 is read with
/// replacement characters, as the npm server's decoder reads it. A line
/// that is not JSON, or not a request, is answered with a parse error in
/// the npm server's words rather than dropped, so a client that sent one
/// learns what happened; before, the line vanished without a word.
pub(crate) fn serve_streams(mut input: impl BufRead, mut output: impl Write) -> ExitCode {
    let mut frame: Vec<u8> = Vec::new();
    // Set once a frame has passed the limit: the rest of that line is
    // dropped as it arrives, so the oversized message is never held.
    let mut discarding = false;
    loop {
        let (consumed, complete) = {
            let Ok(chunk) = input.fill_buf() else {
                return ExitCode::from(2);
            };
            if chunk.is_empty() {
                break;
            }
            let newline = chunk.iter().position(|&byte| byte == b'\n');
            if !discarding {
                frame.extend_from_slice(&chunk[..newline.unwrap_or(chunk.len())]);
            }
            (newline.map_or(chunk.len(), |at| at + 1), newline.is_some())
        };
        input.consume(consumed);
        if discarding {
            discarding = !complete;
            continue;
        }
        if !complete {
            if frame.len() > MAX_FRAME_BYTES {
                frame = Vec::new();
                discarding = true;
                if emit(&mut output, &frame_refusal()).is_err() {
                    return ExitCode::from(2);
                }
            }
            continue;
        }
        let line = std::mem::take(&mut frame);
        if line.len() > MAX_FRAME_BYTES {
            // The newline arrived in the chunk that took the frame over the
            // limit, so the check above never saw it. The limit is on the
            // line, not on when its end happened to arrive.
            if emit(&mut output, &frame_refusal()).is_err() {
                return ExitCode::from(2);
            }
            continue;
        }
        let Some(response) = respond_to_line(&line) else {
            continue;
        };
        if emit(&mut output, &response).is_err() {
            return ExitCode::from(2);
        }
    }
    // A partial frame at close was never a request; the npm server drops
    // it the same way.
    ExitCode::SUCCESS
}

/// One line in, at most one reply out: the same refusals, in the same
/// words, as the npm server's loop.
fn respond_to_line(line: &[u8]) -> Option<Value> {
    let text = String::from_utf8_lossy(line);
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let Ok(request) = serde_json::from_str::<Value>(text) else {
        return Some(parse_error("Invalid JSON"));
    };
    if !is_request(&request) {
        return Some(parse_error("Not a JSON-RPC 2.0 request"));
    }
    handle(&request)
}

fn emit(output: &mut impl Write, message: &Value) -> std::io::Result<()> {
    writeln!(output, "{message}")?;
    output.flush()
}

fn is_request(value: &Value) -> bool {
    value.get("jsonrpc").and_then(Value::as_str) == Some("2.0")
        && value.get("method").is_some_and(Value::is_string)
}

fn frame_refusal() -> Value {
    parse_error(&format!(
        "Message exceeds the {MAX_FRAME_BYTES} byte frame limit"
    ))
}

/// A refusal with no id to answer against.
fn parse_error(message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": null,
        "error": { "code": PARSE_ERROR, "message": message },
    })
}

fn handle(request: &Value) -> Option<Value> {
    let method = request.get("method")?.as_str()?;
    // A notification carries no id, or a null one, and takes no reply; the
    // npm server reads both the same way, and this answered the null one.
    let id = request.get("id").filter(|id| !id.is_null())?.clone();

    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "regex-le", "version": env!("CARGO_PKG_VERSION") },
        })),
        "tools/list" => Ok(json!({ "tools": tool_definitions() })),
        "tools/call" => call_tool(request.get("params")),
        "ping" => Ok(json!({})),
        other => Err((METHOD_NOT_FOUND, format!("Unknown method: {other}"))),
    };

    Some(match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message },
        }),
    })
}

fn tool_definitions() -> Value {
    json!([
        extract::definition(),
        {
            "name": "regex_le_lint",
            "description": "Find every regular expression in files or directories and report \
                            which of them can be driven into catastrophic backtracking. Reads \
                            the filesystem; never writes to it, and never runs a pattern. It \
                            flags dangerous shapes and cannot prove a pattern safe.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "a file or directory to scan" },
                    "paths": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "several files or directories, instead of `path`",
                    },
                    "severity": {
                        "type": "string",
                        "enum": ["high", "medium"],
                        "default": "medium",
                        "description": "Count a pattern as a finding at this verdict or worse.",
                    },
                    "all": {
                        "type": "boolean",
                        "default": false,
                        "description": "Report every pattern, not only the vulnerable ones. \
                                        The finding count does not change.",
                    },
                    "hidden": {
                        "type": "boolean",
                        "default": false,
                        "description": "Walk hidden files and directories too.",
                    },
                    "ignored": {
                        "type": "boolean",
                        "default": false,
                        "description": "Walk files excluded by .gitignore too.",
                    },
                },
            },
        },
    ])
}

/// Protocol failures (no tool named, an unknown tool) are JSON-RPC
/// errors; a tool that fails on its arguments returns a result carrying
/// `isError`, so a model reads the reason and reacts rather than
/// concluding the server is broken. Same rule as the npm server.
fn call_tool(params: Option<&Value>) -> Result<Value, (i64, String)> {
    let no_name = || {
        (
            INVALID_PARAMS,
            "tools/call requires a string `name`".to_string(),
        )
    };
    let params = params.ok_or_else(no_name)?;
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(no_name)?;
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    match name {
        "extract_patterns" => Ok(match extract::run(&arguments) {
            Ok(result) => tool_result(&result),
            Err(message) => tool_failure(&message),
        }),
        "regex_le_lint" => Ok(match lint_tool(&arguments) {
            Ok(result) => tool_result(&result),
            Err(message) => tool_failure(&message),
        }),
        other => Err((INVALID_PARAMS, format!("Unknown tool: {other}"))),
    }
}

fn lint_tool(arguments: &Value) -> Result<Value, String> {
    let inputs = requested_paths(arguments)?;
    let flag = |name: &str| {
        arguments
            .get(name)
            .and_then(Value::as_bool)
            .unwrap_or(false)
    };
    let walk_options = WalkOptions {
        hidden: flag("hidden"),
        respect_ignore: !flag("ignored"),
    };
    let options = ScanOptions {
        threshold: threshold(arguments)?,
        all: flag("all"),
    };

    let walked = walk::collect(&inputs, &walk_options)?;
    let reports: Vec<Value> = walked
        .files
        .iter()
        .filter_map(|target| scan::scan_file(target, options))
        .map(|report| serde_json::to_value(report).expect("a report serializes"))
        .collect();
    // A binary file gets no report, so the count is the only place a
    // model can learn the scan covered less than the tree.
    let binary = walked.files.len() - reports.len();

    let findings: u64 = reports
        .iter()
        .map(|report| report["summary"]["findings"].as_u64().unwrap_or(0))
        .sum();
    let diagnostics: Vec<Value> = reports
        .iter()
        .filter(|report| {
            report["diagnostics"]
                .as_array()
                .is_some_and(|list| list.iter().any(|d| d["severity"] == "error"))
        })
        .map(|report| {
            warning(
                "unreadable",
                &format!(
                    "{} could not be examined, so this scan does not cover it",
                    report["file"].as_str().unwrap_or("a file")
                ),
            )
        })
        .collect();
    let count = reports.len();
    Ok(envelope(
        "regex_le_lint",
        &json!({ "reports": reports, "findings": findings, "binary": binary }),
        count,
        &diagnostics,
        false,
    ))
}

/// `low` is refused the same way the CLI refuses it, in the caller's
/// vocabulary: no message here names a flag.
fn threshold(arguments: &Value) -> Result<Severity, String> {
    match arguments.get("severity").and_then(Value::as_str) {
        None | Some("medium") => Ok(Severity::Medium),
        Some("high") => Ok(Severity::High),
        Some("low") => Err(
            "low is not a threshold: every pattern has a verdict, so it would count every \
             regex as a finding. Ask for all instead."
                .to_string(),
        ),
        Some(other) => Err(format!("{other} is not a severity; one of: high, medium")),
    }
}

fn requested_paths(arguments: &Value) -> Result<Vec<PathBuf>, String> {
    if let Some(path) = arguments.get("path").and_then(Value::as_str) {
        return Ok(vec![PathBuf::from(path)]);
    }
    if let Some(items) = arguments.get("paths").and_then(Value::as_array) {
        let paths: Vec<PathBuf> = items
            .iter()
            .filter_map(|item| item.as_str().map(PathBuf::from))
            .collect();
        if paths.is_empty() {
            return Err("the list of paths was empty".to_string());
        }
        return Ok(paths);
    }
    Err("no file or directory was supplied to audit".to_string())
}

/// The one result shape every tool returns, matching the npm server's
/// envelope field for field: `{ ok, data, diagnostics, meta }`.
///
/// **`ok` reports whether the check ran, not whether the answer is
/// yes.** A file full of broken paths is the answer, not a failure to
/// produce one — conflating the two would have a model report a broken
/// tool when what it actually learned is that the paths are wrong.
pub(crate) fn envelope(
    tool: &str,
    data: &Value,
    count: usize,
    diagnostics: &[Value],
    truncated: bool,
) -> Value {
    let ok = !diagnostics
        .iter()
        .any(|diagnostic| diagnostic["severity"].as_str() == Some("error"));
    json!({
        "ok": ok,
        "data": data,
        "diagnostics": diagnostics,
        "meta": { "tool": tool, "count": count, "truncated": truncated },
    })
}

/// An MCP tool result: the envelope as text (what a model reads) and
/// the same envelope structured. Identical to what the npm server
/// emits, so a caller diffing the two servers finds nothing.
fn tool_result(envelope: &Value) -> Value {
    let text = serde_json::to_string_pretty(envelope).expect("an envelope serializes");
    json!({
        "content": [{ "type": "text", "text": text }],
        "structuredContent": envelope,
        "isError": false,
    })
}

fn warning(code: &str, message: &str) -> Value {
    json!({ "severity": "warning", "code": code, "message": message })
}

/// The tool could not run on the arguments given. `isError` so a model
/// reads the message and corrects itself.
fn tool_failure(message: &str) -> Value {
    json!({
        "content": [{ "type": "text", "text": message }],
        "isError": true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::TempTree;

    fn request(method: &str, params: &Value) -> Value {
        json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params })
    }

    fn call(name: &str, arguments: &Value) -> Value {
        handle(&request(
            "tools/call",
            &json!({ "name": name, "arguments": arguments }),
        ))
        .expect("a reply")
    }

    #[test]
    fn initialize_answers_with_the_protocol_version() {
        let response = handle(&request("initialize", &json!({}))).expect("a reply");
        assert_eq!(response["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(response["result"]["serverInfo"]["name"], "regex-le");
    }

    #[test]
    fn tools_list_offers_both_tools() {
        let response = handle(&request("tools/list", &json!({}))).expect("a reply");
        let tools = response["result"]["tools"].as_array().expect("tools");
        let names: Vec<&str> = tools.iter().filter_map(|t| t["name"].as_str()).collect();
        assert_eq!(names, ["extract_patterns", "regex_le_lint"]);
    }

    #[test]
    fn a_notification_gets_no_reply() {
        let notification = json!({ "jsonrpc": "2.0", "method": "initialized" });
        assert!(handle(&notification).is_none());
        let null_id = json!({ "jsonrpc": "2.0", "id": null, "method": "ping" });
        assert!(handle(&null_id).is_none(), "a null id is a notification");
    }

    /// The loop, driven with bytes in the 8 KiB chunks stdin arrives in,
    /// with what it wrote and how it ended.
    fn drive(input: &[u8]) -> (String, Vec<Value>) {
        let mut written = Vec::new();
        let reader = std::io::BufReader::with_capacity(8192, std::io::Cursor::new(input.to_vec()));
        let code = serve_streams(reader, &mut written);
        let replies = String::from_utf8(written)
            .expect("replies are UTF-8")
            .lines()
            .map(|line| serde_json::from_str(line).expect("a reply is JSON"))
            .collect();
        (format!("{code:?}"), replies)
    }

    const PING: &[u8] = b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n";

    /// A line of invalid bytes was dropped without a word; it is a parse
    /// error now, and the ping after it is still answered.
    #[test]
    fn an_invalid_utf8_line_is_a_parse_error_and_the_server_reads_on() {
        let (code, replies) = drive(&[b"\xff\xfe\n".as_slice(), PING].concat());
        assert_eq!(code, format!("{:?}", ExitCode::SUCCESS));
        assert_eq!(replies[0], parse_error("Invalid JSON"));
        assert_eq!(replies[1]["id"], 1);
    }

    /// Inside a string the npm server's decoder replaces the byte and the
    /// request succeeds; this reads it the same way, where it dropped it.
    #[test]
    fn an_invalid_byte_inside_a_string_is_replaced_as_the_npm_server_reads_it() {
        let request = [
            br#"{"jsonrpc":"2.0","id":2,"method":"ping","x":"caf"#.as_slice(),
            b"\xe9",
            br#""}"#,
            b"\n",
        ]
        .concat();
        let (_, replies) = drive(&request);
        assert_eq!(replies[0]["id"], 2);
        assert_eq!(replies[0]["result"], json!({}));
    }

    /// A frame that is not JSON used to be dropped without a word.
    #[test]
    fn a_line_that_is_not_json_is_answered_with_a_parse_error() {
        let (_, replies) = drive(&[b"not json at all\n".as_slice(), PING].concat());
        assert_eq!(replies[0], parse_error("Invalid JSON"));
        assert_eq!(replies[1]["id"], 1);
    }

    /// A request without a method was dropped, and one without `jsonrpc`
    /// or with another version was answered; the npm server refuses all
    /// three the same way. A byte order mark is not whitespace to either
    /// parser, so a frame led by one is not JSON.
    #[test]
    fn a_line_that_is_not_a_request_is_answered_with_a_parse_error() {
        for line in [
            br#"{"id":1}"#.as_slice(),
            br#"{"id":1,"method":"ping"}"#,
            br#"{"jsonrpc":"1.0","id":1,"method":"ping"}"#,
            br#"{"jsonrpc":"2.0","id":1,"method":7}"#,
            b"[1,2,3]",
            b"5",
        ] {
            let (_, replies) = drive(&[line, b"\n"].concat());
            assert_eq!(
                replies[0],
                parse_error("Not a JSON-RPC 2.0 request"),
                "{line:?}"
            );
        }
        let (_, replies) = drive(&[b"\xef\xbb\xbf".as_slice(), PING].concat());
        assert_eq!(replies[0], parse_error("Invalid JSON"));
    }

    /// Input with no newline was held whole. Past the limit the frame is
    /// refused in the npm server's words, the rest of the line is dropped
    /// as it arrives, and the next line is served.
    #[test]
    fn a_frame_over_the_limit_is_refused_and_the_next_line_served() {
        // One byte over, with the newline in the chunk that takes the frame
        // over the limit; and far over, with the newline many chunks later.
        for over in [1, 100_000] {
            let mut input = vec![b'x'; MAX_FRAME_BYTES + over];
            input.extend_from_slice(b"\n");
            input.extend_from_slice(PING);
            let (code, replies) = drive(&input);
            assert_eq!(code, format!("{:?}", ExitCode::SUCCESS));
            assert_eq!(replies[0], frame_refusal(), "{over} over");
            assert_eq!(replies[1]["id"], 1, "{over} over");
            assert_eq!(replies.len(), 2, "{over} over");
        }
    }

    /// Exactly at the limit is served; the limit is a ceiling, not a size.
    #[test]
    fn a_frame_at_the_limit_is_served() {
        let mut input = br#"{"jsonrpc":"2.0","id":1,"method":"ping","params":{"pad":""#.to_vec();
        let padding = MAX_FRAME_BYTES - input.len() - 3;
        input.extend(std::iter::repeat_n(b'x', padding));
        input.extend_from_slice(b"\"}}\n");
        assert_eq!(
            input.len(),
            MAX_FRAME_BYTES + 1,
            "the line plus its newline"
        );
        let (_, replies) = drive(&input);
        assert_eq!(replies[0]["id"], 1);
    }

    /// A last line with no newline was answered; it is a partial frame at
    /// close, which the npm server drops too.
    #[test]
    fn blank_lines_and_a_partial_frame_at_close_are_ignored() {
        let (code, replies) = drive(
            &[
                b"\n\r\n \t\n".as_slice(),
                PING,
                b"{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"ping\"}",
            ]
            .concat(),
        );
        assert_eq!(code, format!("{:?}", ExitCode::SUCCESS));
        assert_eq!(replies.len(), 1);
        assert_eq!(replies[0]["id"], 1);
    }

    /// The refusals a client can provoke read the same from every server
    /// this repository ships.
    #[test]
    fn protocol_refusals_use_the_npm_servers_words() {
        let response = handle(&request("does/not/exist", &json!({}))).expect("a reply");
        assert_eq!(
            response["error"]["message"],
            "Unknown method: does/not/exist"
        );
        let response = call("no_such_tool", &json!({}));
        assert_eq!(response["error"]["message"], "Unknown tool: no_such_tool");
        for params in [json!({}), json!([1]), json!({ "name": 3 })] {
            let response = handle(&request("tools/call", &params)).expect("a reply");
            assert_eq!(
                response["error"]["message"], "tools/call requires a string `name`",
                "{params}"
            );
        }
        let response =
            handle(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call" })).expect("a reply");
        assert_eq!(
            response["error"]["message"],
            "tools/call requires a string `name`"
        );
        let initialized =
            json!({ "jsonrpc": "2.0", "id": 1, "method": "notifications/initialized" });
        assert_eq!(
            handle(&initialized).expect("a reply")["error"]["code"],
            METHOD_NOT_FOUND,
            "a notification sent with an id is a method this server does not implement"
        );
    }

    /// The handshake answers with this server's own revision and bare tool
    /// support, as the extension's server answers, whatever the client asked.
    #[test]
    fn initialize_does_not_echo_the_clients_version() {
        let asked = request("initialize", &json!({ "protocolVersion": "1999-01-01" }));
        let response = handle(&asked).expect("a reply");
        assert_eq!(response["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(response["result"]["capabilities"], json!({ "tools": {} }));
    }

    #[test]
    fn an_unknown_method_is_a_protocol_error() {
        let response = handle(&request("does/not/exist", &json!({}))).expect("a reply");
        assert_eq!(response["error"]["code"], METHOD_NOT_FOUND);
    }

    #[test]
    fn an_unknown_tool_is_a_protocol_error() {
        let response = call("regex_le_test", &json!({}));
        assert_eq!(response["error"]["code"], INVALID_PARAMS);
    }

    /// A bad argument is the tool failing on what it was given, not the
    /// server breaking — so it comes back as a result carrying isError.
    #[test]
    fn a_missing_argument_is_a_tool_failure_not_a_protocol_error() {
        let response = call("regex_le_lint", &json!({}));
        assert!(response.get("error").is_none(), "{response}");
        assert_eq!(response["result"]["isError"], true);
        assert!(
            response["result"]["content"][0]["text"]
                .as_str()
                .expect("a message")
                .contains("no file or directory")
        );
    }

    #[test]
    fn the_shared_tool_is_offered_and_answers() {
        let response = call(
            "extract_patterns",
            &json!({ "content": "const re = /(a+)+b/g;" }),
        );
        let envelope = &response["result"]["structuredContent"];
        assert_eq!(envelope["meta"]["tool"], "extract_patterns");
        assert_eq!(envelope["data"]["patterns"][0]["pattern"], "(a+)+b");
        assert_eq!(envelope["data"]["patterns"][0]["redos"]["severity"], "high");
        assert_eq!(envelope["ok"], true);
        assert_eq!(response["result"]["isError"], false);
    }

    /// The shared tool runs nothing — that is the whole line between
    /// the ported half and the half that stayed in the editor, and a
    /// timing field would mean it had been crossed.
    #[test]
    fn the_shared_tool_runs_no_pattern() {
        let response = call(
            "extract_patterns",
            &json!({ "content": "const re = /(a+)+b/;" }),
        );
        let pattern = &response["result"]["structuredContent"]["data"]["patterns"][0];
        assert_eq!(pattern["redos"]["severity"], "high");
        for absent in ["matches", "duration", "durationMs", "executed"] {
            assert!(
                pattern.get(absent).is_none(),
                "a field like {absent} means it ran"
            );
        }
    }

    /// An empty answer is the scan running and finding nothing, not the
    /// tool breaking.
    #[test]
    fn a_document_with_no_patterns_is_an_ordinary_result() {
        let response = call("extract_patterns", &json!({ "content": "const x = 1;" }));
        let envelope = &response["result"]["structuredContent"];
        assert_eq!(response["result"]["isError"], false);
        assert_eq!(envelope["ok"], true);
        assert_eq!(envelope["meta"]["count"], 0);
    }

    #[test]
    fn the_lint_tool_reports_what_it_found() {
        let tree = TempTree::new("mcp-lint");
        tree.write("src/a.js", "const re = /(a+)+b/g;\n");
        let response = call(
            "regex_le_lint",
            &json!({ "path": tree.path().to_string_lossy() }),
        );
        let envelope = &response["result"]["structuredContent"];
        assert_eq!(response["result"]["isError"], false);
        assert_eq!(envelope["ok"], true);
        assert_eq!(envelope["data"]["findings"], 1);
    }

    /// Reporting more patterns does not find more of them.
    #[test]
    fn asking_for_all_widens_the_report_not_the_verdict() {
        let tree = TempTree::new("mcp-all");
        tree.write("src/a.js", "const a = /[a-z]+/;\nconst b = /(a+)+b/;\n");
        let path = tree.path().to_string_lossy().to_string();

        let lint = call("regex_le_lint", &json!({ "path": path }));
        let reports = &lint["result"]["structuredContent"]["data"]["reports"];
        assert_eq!(
            reports[0]["patterns"].as_array().expect("patterns").len(),
            1
        );
        assert_eq!(lint["result"]["structuredContent"]["data"]["findings"], 1);

        let everything = call("regex_le_lint", &json!({ "path": path, "all": true }));
        let reports = &everything["result"]["structuredContent"]["data"]["reports"];
        assert_eq!(
            reports[0]["patterns"].as_array().expect("patterns").len(),
            2
        );
        assert_eq!(
            everything["result"]["structuredContent"]["data"]["findings"],
            1
        );
    }

    /// The same refusal the CLI gives, without the flag name.
    #[test]
    fn a_low_threshold_is_refused_with_its_reason() {
        let tree = TempTree::new("mcp-low");
        tree.write("src/a.js", "const re = /(a+)+b/;\n");
        let response = call(
            "regex_le_lint",
            &json!({ "path": tree.path().to_string_lossy(), "severity": "low" }),
        );
        assert_eq!(response["result"]["isError"], true);
        let text = response["result"]["content"][0]["text"]
            .as_str()
            .expect("a message");
        assert!(text.contains("every pattern has a verdict"), "{text}");
    }

    /// Refusals speak the caller's vocabulary: an MCP caller has no
    /// command line, so no message may name a flag.
    #[test]
    fn no_message_mentions_a_command_line_flag() {
        let definitions = serde_json::to_string(&tool_definitions()).expect("serializes");
        assert!(!definitions.contains("--"), "{definitions}");

        let tree = TempTree::new("mcp-vocabulary");
        tree.write("a.js", "const re = /(a+)+b/;\n");
        for arguments in [
            json!({}),
            json!({ "paths": [] }),
            json!({ "path": "/no/such/place-xyz" }),
            json!({ "path": tree.path().to_string_lossy(), "severity": "low" }),
        ] {
            let rendered =
                serde_json::to_string(&call("regex_le_lint", &arguments)).expect("serializes");
            assert!(!rendered.contains("--"), "{rendered}");
        }
    }

    /// Every tool returns the same envelope, so a caller writes one
    /// reader for all of them and for both servers.
    #[test]
    fn every_tool_returns_the_same_envelope_shape() {
        let tree = TempTree::new("mcp-envelope");
        tree.write("a.md", "x");
        let results = [
            call(
                "extract_patterns",
                &json!({ "content": "x", "format": "markdown" }),
            ),
            call(
                "regex_le_lint",
                &json!({ "path": tree.path().to_string_lossy() }),
            ),
        ];
        for result in results {
            let envelope = &result["result"]["structuredContent"];
            assert!(envelope["ok"].is_boolean(), "{envelope}");
            assert!(!envelope["data"].is_null(), "{envelope}");
            assert!(envelope["diagnostics"].is_array(), "{envelope}");
            assert!(envelope["meta"]["tool"].is_string(), "{envelope}");
            assert!(envelope["meta"]["count"].is_number(), "{envelope}");
            assert!(envelope["meta"]["truncated"].is_boolean(), "{envelope}");
        }
    }
}
