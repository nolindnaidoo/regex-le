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
| `extraction.json` → `heuristics` | Flag validation, compilability, and the slash-is-division context test. |
| `mcp-extract-patterns.json` | The `extract_patterns` MCP tool, which **both** servers offer and must answer identically. |

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

## Who checks what

- `bun ../../scripts/check-extraction-parity.ts` runs the **extension's**
  exported functions over these files.
- `cargo test` runs the **crate's** implementation over the same files.

Neither side may be the sole author of a case.
