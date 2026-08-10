# regex-le — Rust specification

A port of **half** of the [Regex-LE](https://github.com/nolindnaidoo/regex-le)
VS Code extension to a Rust CLI and MCP server: find every regular
expression in a codebase and report which of them can be driven into
catastrophic backtracking.

**Parity first.** For extraction and for the ReDoS verdict, the extension
is the reference implementation. Anything this produces for a given
document must match what the extension produces for that document. A
difference is a regression until proven otherwise.

## The one question

**Which regexes in this codebase can be made to hang it?**

Asked over a whole tree, answered without running a single pattern, with
an exit code a CI step can fail on.

## Half the extension, on purpose

The extension does two things. This ports one.

**Ported — the lint.** Find the patterns, judge their shape.
`extractPatterns`, `redos`, `heuristics`, `position`.

**Not ported — the tester.** `regexTest`, `guardedExec` and `performance`
run *your* pattern against *your* text and report matches with
capture-group positions. That is an interactive activity: you type, you
look, you adjust. It belongs in an editor and in regex101, not in a CI
step, and nobody runs it over a tree.

It is also the half that would be expensive to be honest about. Matching
with JavaScript semantics — backreferences, lookbehind, named groups,
`lastIndex`, the `d` flag's capture indices — needs a JavaScript-compatible
engine, and getting it *nearly* right would mean this tool reporting
different matches than the extension for the same pattern. **The lint
half needs no such thing**: the ReDoS detector is a structural scan over
the pattern *text*, and the only place a real engine is needed is
deciding whether a pattern is syntactically valid at all.

`guardedExec` is worth a note because it disappears rather than ports.
It exists to fight a JavaScript problem — a catastrophically backtracking
pattern blocks inside a single `regex.exec()` call, so no deadline
checked *between* matches can interrupt it, and killing a worker thread
is the only way out. That whole apparatus is JavaScript's, not the
problem's.

## Shape

**One crate.** Self-contained: no published `-core`, no shared crate with
the family, and nothing holding this code equal to the similar files
in the sibling repos. Where they agree it is because the same answer was
right twice; where they diverge that is the point.

```
crate/
├── src/
│   ├── detect/     pure: pattern extraction, the ReDoS scan, the
│   │               heuristics, positions. No filesystem, pub(crate).
│   ├── walk.rs     ignore-aware tree walking
│   ├── scan.rs     one file end to end — the only path either surface calls
│   ├── cli.rs      the terminal surface
│   └── mcp/        the agent surface
└── fixtures/       the shared corpus, read by both frontends
```

**`detect/` touches no filesystem** and carries the **90% line coverage
floor per module**.

## Extraction — parity scope

### What counts as a regex

Two shapes, matching the extension:

- **Literals** — `/pattern/flags`, where the pattern contains no
  unescaped slash or newline, and the flags are from `dgimsuvy`.
- **Constructors** — `new RegExp('…', '…')` and `RegExp("…")`, with
  escaped quotes handled in both arguments and whitespace allowed
  wherever a JavaScript parser allows it, so a constructor split across
  lines is found.

A slash is only a regex when it *can* be one. `isRegexContext` decides:
after an identifier, a number or a closing bracket, a slash is division.
The list of keywords that may be followed by a regex is the extension's
and is ported verbatim, because a second implementation guessing at that
list is how the two frontends start disagreeing about what is even a
pattern.

### Duplicates are collapsed

A pattern-and-flags pair is reported **once, at its first occurrence**.
The output is a pattern list, not an occurrence list — deliberate in the
extension, ported here, and the reason a file using the same validation
regex ten times reports one finding rather than ten.

### The ReDoS verdict

Three outcomes, in the extension's precedence order:

| severity | shape | reason |
|---|---|---|
| `high` | a quantified group whose body also contains an unbounded quantifier — `(a+)+`, `([a-z]+)*`, `(\w*)+` | exponential backtracking |
| `medium` | a quantified group whose body is an alternation with overlapping branches — `(a\|a)*`, `(a\|ab)+` | heavy backtracking |
| `low` | everything else | no obvious vulnerability |

**This is a scanner, not an automaton analysis, and the distinction is
in the output.** It cannot prove a pattern safe — only flag the common
dangerous shapes. A pattern it does not recognise may still backtrack
badly on adversarial input. That honest scope is the extension's wording
and it ports with the code; a tool that implied more would be worse than
one that found less.

**An invalid pattern is a syntax error, not a vulnerability**, and the
two stages treat it differently. Extraction **drops** it: a `/(/ ` or a
`new RegExp('(')` never reaches a report, matching the extension, which
is why no report ever carries this verdict. The ReDoS check itself, asked
directly about a pattern that does not compile, answers `low` with the
reason `Pattern is invalid` rather than guessing at its shape.

Either way something has to decide whether a pattern would compile in
JavaScript, and that is why this crate needs a JavaScript-compatible
parser at all: `regress`, used to *parse* and nothing else. It never
matches anything. That is the whole of the dependency, and it is the line
between the lint half and the tester half.

### Group scanning

`scanGroups` walks the pattern text tracking escapes and character
classes, so `[(]+` is a class and not a group, and `\(a+\)+` is escaped
literal parentheses. Nested groups are each reported with their full
body. It is a string scan with a stack — no engine involved.

### What is walked

Every text file, with no format filter — a regex literal is a regex
literal wherever it appears, and the extension's engine takes raw text
rather than a language id.

A directory is walked the way ripgrep walks one: `.gitignore` honoured,
hidden files skipped, `--no-ignore` and `--hidden` to reach the rest. A
file named explicitly is always read.

**What the ignore rules kept out is not counted.** On a checkout with
dependencies installed that number is around thirty thousand and all of
it is `node_modules`; reporting it reads as a shortfall when the walk did
exactly what it was asked, and a dangerous regex inside a dependency is
not a line you can go and fix.

## Output contract

**stdout is protocol, stderr is human.** One JSON report per line, one
line per file.

```json
{
  "file": "src/validate.ts",
  "patterns": [
    {
      "pattern": "(\\w+)+@",
      "flags": "g",
      "line": 12,
      "column": 18,
      "redos": {
        "detected": true,
        "severity": "high",
        "reason": "Nested unbounded quantifiers can cause exponential backtracking",
        "vulnerableGroups": ["(\\w+)+"]
      }
    }
  ],
  "diagnostics": [],
  "summary": { "patterns": 1, "findings": 1 }
}
```

### Exit codes are the API

- **0** — no vulnerable pattern found.
- **1** — at least one pattern with a ReDoS verdict at or above the
  threshold.
- **2** — the question was malformed: an unknown flag, an unreadable
  input, a path that does not exist.

**`--severity` sets the threshold**, defaulting to `medium`: `high` fails
only on the exponential shapes, `medium` adds the overlapping
alternations, and `low` would fail on everything and is therefore not
offered as a threshold — a check that always fires is a check nobody
reads.

## The CLI surface

```
usage: regex-le [options] <file|dir>...
       regex-le [options] --stdin
       regex-le mcp
       regex-le --version | --help

Options:
  --severity <level>   fail at this verdict or worse: high or medium
                       (default medium)
  --all                report every pattern, not only the vulnerable ones
  --stdin              read one document from stdin
  --hidden             walk hidden files and directories too
  --no-ignore          walk files that .gitignore excludes
```

## The MCP surface

- **`extract_patterns` belongs to both servers.** The npm server and this
  one offer the same tool: same schema, same envelope, byte-identical
  output. `fixtures/mcp-extract-patterns.json` runs against both.
- **`regex_le_lint` is this server's own**: files or directories in, the
  same reports the CLI writes.

**Refusals speak the caller's vocabulary.** No message here names a flag.

## Non-goals

- **It does not run your patterns.** No matching, no timing, no capture
  groups — see "Half the extension, on purpose".
- **It does not prove safety.** It flags shapes; silence is not a
  clearance, and the report says so rather than implying otherwise.
- **It does not rewrite patterns.** Suggesting an atomic group or a
  possessive quantifier is a rewrite of code this tool cannot test.
- **No network, ever.**

## Not in v1

- **The tester half** — matching with JavaScript semantics, which needs
  the engine this deliberately avoids.
- **Automaton-based analysis**, which would let it prove safety rather
  than flag shapes, and is a different tool.
- **A baseline file** for accepting known findings.
