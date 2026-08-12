# Changelog

The Rust CLI and MCP server. The VS Code extension has its own
[CHANGELOG](../CHANGELOG.md) and its own version — the two products in
this repository release on their own cadence.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Seven more languages.** Patterns are now found at the call sites
  Python, Rust, Go, Java, Ruby, PHP and C# write them at, alongside the
  JavaScript and TypeScript literals and `RegExp` constructors that were
  all this read before. A `.py`, `.rs` or `.go` file holding `(a+)+`
  came back clean; each is now a `high` finding, and the corpus carries
  one document per language so neither frontend can lose them again.
- **`extract_patterns` takes an optional `format` or `filename`** on
  both MCP servers, resolved through a shared alias table
  (`fixtures/aliases.json`) so a name one server reads and the other
  ignores cannot ship. Naming nothing still scans for every spelling; a
  name neither resolves comes back as a `warning` diagnostic rather than
  being silently ignored.
- The extension's MCP `extract_patterns` now carries
  `redos.vulnerableGroups`, which this server already reported. The two
  were free to disagree because no shared case had a vulnerable pattern
  in it; there are nine now.

### Changed

- **A document's language selects which spellings are looked for**, and
  the slash-versus-division walk runs only where a bare `/…/` is legal —
  JavaScript, TypeScript, Ruby. A Python or Go file no longer reports
  `#!/usr/bin/env python` and `/var/log/app.log` as patterns, so the
  pattern count on a Python-heavy tree drops sharply while the finding
  count rises. A file whose language nothing recognises is scanned
  exactly as before.
- **Validity is judged in the pattern's own grammar.**
  `re.compile(r"(?P<year>\d{4})")` is ordinary Python and a syntax error
  to `regress`; it used to be dropped, and calling `detect_redos` on it
  answered `Pattern is invalid`. Validity is now asked of a JavaScript
  *rendering* of the pattern — `(?P<` → `(?<`, `(?>` → `(?:`, an inline
  mode switch dropped, a possessive quantifier's `+` dropped — and only
  what fails that is a syntax error. Nothing rendered reaches a report:
  the pattern reported, and the pattern the ReDoS scan reads, is the
  source as written. `(?P<word>\w+)+@` is reported verbatim and comes
  back `high`.

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

### Fixed

- **A leading byte-order mark is no longer part of the document.** Three
  invisible bytes, added by Notepad, Excel and a PowerShell redirect, and
  stripped by VS Code before the extension ever sees a file — so the two
  frontends read the same file differently. It shifted every column on
  line one, and before a `{` it made a structured parser reject the whole
  document, which is indistinguishable from a file with no patterns in it.

- **A file that cannot be read no longer fails the run.** Every
  repository has a PNG, a zip and something the runner lacks permission
  for. Exiting 2 on those made the tool unusable in CI, which is the one
  place it is most worth running. Such a file is now named on stderr and
  carried in the report with a `skipped` diagnostic, and the exit code
  reflects what was found. `--strict` restores the old behaviour for a
  pipeline that wants zero tolerance.

  A scan that gives up part way through a file still fails without
  asking — that is a coverage failure, and it is now a different thing
  from a file that was never text.

- **A file that is not text is named rather than dropped.** It used to
  vanish from the report entirely, which reads to whoever ran it as
  "that file was clean".
