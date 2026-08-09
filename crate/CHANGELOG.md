# Changelog

The Rust CLI and MCP server. The VS Code extension has its own
[CHANGELOG](../CHANGELOG.md) and its own version — the two products in
this repository release on their own cadence.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-09

First release. The extension's lint engine, ported and pinned against a
shared corpus, over a tree instead of a buffer.

### Added

- **Pattern detection** — regex literals and `RegExp` constructors,
  including constructors split across lines, with the extension's
  `isRegexContext` rule ported verbatim so a division sign and a URL
  stay out of the results. A pattern-and-flags pair is reported once, at
  its first occurrence.
- **The ReDoS verdict** — `high` for a quantified group whose body holds
  another unbounded quantifier, `medium` for a quantified group whose
  body is an overlapping alternation, `low` for everything else
  including patterns that do not compile. Reproduces the extension's
  answer for every case in `fixtures/`.
- **The CLI**: JSON reports on stdout one per line, a human summary on
  stderr, and exit codes — 0 nothing vulnerable, 1 at least one finding,
  2 the question was malformed. `--severity`, `--all`, `--stdin`,
  `--hidden`, `--no-ignore`.
- **The MCP server** (`regex-le mcp`) with two tools:
  `extract_patterns`, shared byte-for-byte with the npm server and
  pinned by `fixtures/mcp-extract-patterns.json`, and `regex_le_lint`.

### The shape of it

**Half the extension, on purpose.** The lint ports; the tester does not.
Running *your* pattern against *your* text with JavaScript semantics
needs a JavaScript engine, and getting it nearly right would mean this
tool reporting different matches than the extension for the same
pattern. The lint half needs no engine at all: the ReDoS scan reads the
pattern *text*, and the only place a real parser is required is deciding
whether a pattern is valid. Contract tests on both surfaces assert no
flag and no tool schema offers text to match against.

**It flags shapes and cannot prove a pattern safe.** That is the
extension's wording and it ports with the code. Silence is not a
clearance, and the help text says so rather than implying otherwise.

[0.1.0]: https://github.com/nolindnaidoo/regex-le/releases/tag/crate-v0.1.0
