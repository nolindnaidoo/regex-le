# The shared corpus

These files are the contract between the two frontends of Regex-LE: the
VS Code extension at the repository root, and the Rust CLI and MCP server
in this crate. **Both read them, and CI fails when either side drifts.**

They live inside `crate/` because `cargo package` cannot reach above its
own directory, and `cargo test` on the published crate runs them.

| File | What it pins |
|---|---|
| `documents/` | The source documents both sides extract from. |
| `extraction.json` → `documents` | Every pattern found, with flags, position, matched text and verdict. |
| `extraction.json` → `redos` | The detector over the shapes it exists to catch, the shapes it must not flag, and the invalid patterns. |
| `extraction.json` → `heuristics` | Flag validation, compilability in JavaScript and in any grammar read, and the slash-is-division context test. |
| `mcp-extract-patterns.json` | The `extract_patterns` MCP tool, which **both** servers offer and must answer identically. |
| `aliases.json` | The language-name table both servers resolve `format` and `filename` through. |

## Deliberate contents

- **The `redos` cases carry both directions.** `(a+)+`, `([a-z]+)*` and
  `(\w*)+` must come back `high`; `(abc)+`, `(a+)` and a date pattern
  must come back `low`. A detector that only ever fires is as broken as
  one that never does.
- **Four patterns are invalid** — `(`, `a{2,1}`, `[z-a]`, and `x` with
  flags `zz`. They pin that a syntax error is reported as a syntax error
  and not as a vulnerability, which is the one place this crate needs a
  JavaScript-compatible parser.
- **`[(]+` and `\(a+\)+`** pin that the group scanner respects character
  classes and escapes: neither is a quantified group.
- **The `isRegexContext` cases** pin where a slash is division rather
  than a regex — after an identifier, a number or a closing bracket.
- **One document per language** — `patterns.py`, `.rs`, `.go`, `.java`,
  `.rb`, `.php`, `.cs` — each holding `(a+)+`, because each of the seven
  came back clean before the languages were read and nothing would have
  noticed them going quiet again.
- **`division.py`** pins that a Python file of paths and divisions holds
  no patterns: the slash-versus-division walk is a guess, and it is not
  asked in a language with no `/…/` literal.
- **`pcre.py`** pins what happens to a pattern a JavaScript parser
  refuses. `(?P<year>…)` and `(?i)(?>…)` are reported as written;
  `(?P<word>\w+)+@` is reported *and* flagged `high`; `a{2,1}` is a real
  syntax error and is still dropped.
- **The `isWellFormed` cases** pin that widening the validity judge did
  not turn a typo into a pattern.

**A document's language comes off its file name**, on both sides, so a
case cannot pin an answer neither frontend would produce.

## Who checks what

- `bun ../../scripts/check-extraction-parity.ts` runs the **extension's**
  exported functions over these files.
- `cargo test` runs the **crate's** implementation over the same files.

Neither side may be the sole author of a case.
