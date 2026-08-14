# Changelog

The Rust CLI and MCP server. The VS Code extension has its own
[CHANGELOG](../CHANGELOG.md) and its own version — the two products in
this repository release on their own cadence.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-08-14

### Added

- **A regex written in Python, Rust, Go, Java, Ruby, PHP or C# is now
  found.** Only JavaScript and TypeScript were read before, so pointing
  this at a Python codebase reported nothing and exited 0 — a ReDoS
  scanner with nothing to say about the file that actually holds the
  pattern. `re.compile`, `Regex::new`, `regexp.MustCompile`,
  `Pattern.compile`, `Regexp.new`, `preg_match` and `new Regex` are all
  read now, and a `.py`, `.rs` or `.go` file holding `(a+)+` is a `high`
  finding. The corpus carries one document per language, so neither
  frontend can lose them again.

  **Expect the pattern count to fall on some trees, and that is the
  point.** Deciding whether a slash opens a regex or divides is a guess,
  and it was being made in languages that have no `/…/` literal at all —
  so a Python file full of `/var/log/...` read as a page of patterns. On
  one tree, 183 of the patterns previously reported were file paths and
  division signs of exactly that kind; they are gone, and the real call
  sites in the same files are reported instead. Its Python files went
  from 175 patterns to 25, and all 25 are regexes.
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

- **A binary file is skipped silently and counted, not reported.** A NUL
  byte in the first 8 KB — ripgrep's test — means the file was never a
  text candidate, so it gets no report line and no say in the exit code.
  It used to arrive as `not UTF-8 text` with a `skipped` diagnostic,
  which made `--strict` exit 2 on any repository holding a PNG and left
  the flag unusable. The stderr summary carries the count
  (`0 findings in 40 files, 16 binary files skipped`), and
  `regex_le_lint` carries it as `data.binary`, so a narrower scan is
  still visible. A file that *looked* like text and could not be read
  keeps its named `skipped` diagnostic and keeps failing `--strict`.
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

The rest were found by a CI job added in this release, and each ships
with the test that fails without the fix.

- **A pattern nested deep enough no longer kills the process.**
  `regress` parses by recursive descent, so a generated pattern a few
  thousand groups deep overflowed the stack and the process died on
  `SIGABRT` — no report, no exit code, and a whole tree's scan lost to
  one file. Three shapes reached it: nesting, an alternation of tens of
  thousands of branches, and — under the `v` flag, where a character
  class nests as a class — five hundred `[`. A structural bound is now
  measured before the parser is asked; past it a pattern is **refused by
  name** with an `incomplete` diagnostic and exit 2 where the text is
  unambiguously a pattern, and dropped where a bare `/…/` was only ever
  a guess about a slash. A pattern between the ordinary case and that
  bound is parsed on a thread sized for it rather than on the caller's.
- **Whitespace is JavaScript's, not Unicode's, everywhere the extension
  writes `\s` or calls `trim`.** `String.prototype.trim` and JavaScript's
  `\s` hold U+FEFF and not U+0085; Rust's `str::trim`, `char::is_whitespace`
  and `regex`'s `\s` have it exactly the other way round. A byte-order
  mark in a format name, before a `re.compile(`, or as a PHP delimiter
  made the two `extract_patterns` servers answer differently for the same
  document. The set is now spelled out once, in `detect/js.rs`, and every
  trim and every `\s` in the call-form patterns goes through it.
- **The alternation-overlap test uses JavaScript's character classes.**
  `/[\w\s]/` on the extension side is ASCII `\w` and JavaScript `\s`;
  this crate borrowed `char::is_alphanumeric` and `char::is_whitespace`,
  so `(é|é)*` came back `medium` here and `low` there. It is `low` on
  both now.
- **A byte-order mark on `--stdin` no longer moves the reported
  column.** A file read stripped it and a pipe did not, so
  `cat x.js | regex-le --stdin` and `regex-le x.js` gave the same pattern
  two different positions.
- **Report paths use `/` on every platform.** A Windows path arrived with
  `\` in it, against SPEC.md's own output contract, so the same tree
  scanned on two machines produced two reports that could not be diffed.
- **The ReDoS analyser is no longer quadratic in the pattern length.**
  Reading a `{n,m}` quantifier copied the rest of the pattern each time;
  fifty thousand braces cost three seconds. A scanner for catastrophic
  backtracking that can itself be made to hang is the joke that writes
  itself.

### The scope has not moved

**It flags shapes and it cannot prove a pattern safe.** Nine languages
instead of two means more places a dangerous shape is found, not a
stronger claim about the ones it stays quiet on. This is a scanner, not
an automaton analysis; a pattern it does not recognise may still
backtrack badly on adversarial input, and silence is not a clearance.

Some forms are still not read, and SPEC.md names them: Ruby's `%r{…}`,
Python's `regex` module, Java text blocks, PHP's bracket delimiters
beyond `(){}[]<>`, and a C# static call whose subject argument is itself
a call or an index.

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

[0.2.0]: https://crates.io/crates/regex-le/0.2.0
[0.1.0]: https://crates.io/crates/regex-le/0.1.0
