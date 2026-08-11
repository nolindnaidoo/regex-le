<h1 align="center">regex-le</h1>

<p align="center">
  <b>Find every regex in a codebase and report which can be driven into catastrophic backtracking</b><br/>
  <i>nothing is executed — the verdict comes from the shape of the pattern</i>
</p>

<p align="center">
  <a href="https://crates.io/crates/regex-le">
    <img src="https://img.shields.io/crates/v/regex-le.svg" alt="regex-le on crates.io" />
  </a>
  <a href="https://crates.io/crates/regex-le">
    <img src="https://img.shields.io/crates/d/regex-le.svg" alt="crates.io downloads" />
  </a>
  <a href="https://github.com/nolindnaidoo/regex-le/actions/workflows/ci-crate.yml">
    <img src="https://github.com/nolindnaidoo/regex-le/actions/workflows/ci-crate.yml/badge.svg" alt="Build Status" />
  </a>
  <img src="https://img.shields.io/badge/rustc-1.88+-93450a.svg" alt="MSRV: Rust 1.88+" />
  <a href="https://github.com/nolindnaidoo/regex-le/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" />
  </a>
  <a href="https://letools.dev/tools/regex-le">
    <img src="https://img.shields.io/badge/web-letools.dev-00A0FF.svg" alt="letools.dev" />
  </a>
</p>

> **Useful?** A star is how other developers find it —
> [★ GitHub](https://github.com/nolindnaidoo/regex-le) ·
> [letools.dev/tools/regex-le](https://letools.dev/tools/regex-le)

A regex that backtracks catastrophically is a denial of service with a
code review that approved it. `(\w+)+@` looks like an email check and
hangs a request thread on forty characters of input. regex-le finds
every pattern in a tree — literals and `RegExp` constructors, not the
division signs and URLs a grep would hand you — and tells you which ones
have that shape.

It never runs them. The verdict reads the pattern *text*, so scanning a
repository is a cheap deterministic CI step with no engine, no timeout
and nothing to sandbox.

It is the second frontend of
[Regex-LE](https://github.com/nolindnaidoo/regex-le#readme), the VS Code
extension — one product, two frontends, one repository, so the two can
never read a document differently. The corpus both build against lives
at
[`crate/fixtures/`](https://github.com/nolindnaidoo/regex-le/tree/main/crate/fixtures),
and CI fails on drift.

## Sixty seconds

```bash
regex-le .                        # every vulnerable pattern in the tree
regex-le --severity high src/     # only the exponential shapes
regex-le --all src/               # every pattern, vulnerable or not
cat src/validate.js | regex-le --stdin

# the point of the whole thing:
regex-le . || echo 'fix these before merging'
```

```
./src/validate.js:1:15  /(\w+)+@/g  [high] Nested unbounded quantifiers can cause exponential backtracking
./src/parse.ts:1:13  /(a|a)*/  [medium] Alternation with overlapping branches inside a quantifier
2 findings in 3 files
```

**Exit codes**: `0` nothing vulnerable, `1` at least one finding, `2` the
question was malformed. `--severity` sets where the line falls.

## Install

| Route | Command | Worth knowing |
|---|---|---|
| **cargo** | `cargo install regex-le` | Any platform, needs **Rust 1.88+**. |
| **From source** | `git clone https://github.com/nolindnaidoo/regex-le`<br>`cd regex-le/crate && cargo build --release` | The same build CI runs. |

No runtime, no network, nothing written.

## It flags shapes; it cannot prove a pattern safe

This is a scanner, not an automaton analysis. It recognises the two
shapes that cause almost all real ReDoS reports and says nothing about
the rest. **A pattern it does not flag may still backtrack badly on
adversarial input.**

That limit is worth stating plainly because the alternative reads the
same and isn't: a tool that implied clearance would be worse than one
that found less. Proving safety means building the automaton and
checking it for ambiguity — a different tool, and one that costs
seconds per pattern rather than microseconds.

| severity | shape | why |
|---|---|---|
| `high` | a quantified group whose body holds another unbounded quantifier — `(a+)+`, `([a-z]+)*`, `(\w*)+` | exponential backtracking |
| `medium` | a quantified group whose body is an alternation with overlapping branches — `(a\|a)*`, `(a\|ab)+` | heavy backtracking |
| `low` | everything else, **including patterns that do not compile** | no obvious vulnerability, or a syntax error |

`low` is not offered as a `--severity` threshold: every pattern has a
verdict, so it would fail on any file holding a regex at all, and a
check that always fires is a check nobody reads. `--all` is how you see
them.

## Half the extension, on purpose

The extension does two things. This ports one.

**Ported — the lint.** Find the patterns, judge their shape, over a tree
instead of a buffer.

**Not ported — the tester.** Running *your* pattern against *your* text
and showing the matches with capture-group positions is an interactive
activity: you type, you look, you adjust. It belongs in an editor, and
nobody runs it over a repository.

It is also the half that would be expensive to be honest about. Matching
with JavaScript semantics — backreferences, lookbehind, named groups,
`lastIndex`, the `d` flag's capture indices — needs a
JavaScript-compatible engine, and getting it *nearly* right would mean
this tool reporting different matches than the extension for the same
pattern. The lint half needs no such thing. Contract tests on both
surfaces assert that no flag and no tool schema offers text to match
against.

## What it reads

Every text file in the tree. A regex literal is a regex literal wherever
it appears, so there is no format filter and no language list.

A directory is walked the way ripgrep walks one: `.gitignore` honoured,
hidden files skipped, `--no-ignore` and `--hidden` to reach the rest. A
file named explicitly is always read.

### Ported as-is, including the awkward parts

- **A slash is only a regex when it can be one.** After an identifier, a
  number or a closing bracket it is division; after another slash it is
  a comment. The list of keywords that may be followed by a regex —
  `return`, `case`, `yield`, `throw` and the rest — is the extension's
  and is ported verbatim, because a second implementation guessing at it
  is how two frontends start disagreeing about what is even a pattern.
- **A pattern-and-flags pair is reported once**, at its first
  occurrence. The output is a pattern list, not an occurrence list,
  which is why a file using the same validation regex ten times reports
  one finding.
- **Constructors count**, including ones split across lines:
  `new RegExp('…', '…')` and `RegExp("…")`, with escaped quotes handled
  in both arguments.
- **An invalid pattern is a syntax error, not a vulnerability.** It
  comes back `low` with the reason `Pattern is invalid`.
- **Columns are UTF-16 code units**, 1-based, because that is what your
  editor shows you.

## Options

```
--severity <level>   fail at this verdict or worse: high or medium
                     (default medium)
--all                report every pattern, not only the vulnerable ones
--stdin              read one document from stdin
--hidden             walk hidden files and directories too
--no-ignore          walk files that .gitignore excludes
```

## As an MCP server

```bash
regex-le mcp
```

Two tools, both returning `{ ok, data, diagnostics, meta }`:

- **`extract_patterns`** — content in, patterns and verdicts out.
  Touches no filesystem. The npm server ships the same tool with
  byte-identical output; one corpus runs against both.
- **`regex_le_lint`** — files or directories in, the same reports the
  CLI writes.

`ok` means the scan ran, never that it found something. A file with no
vulnerable pattern is a result, not an error.

## The other four ways to run it

| Where | What you get | Install |
|---|---|---|
| **VS Code** | The lint *and* the tester, in your editor | [Marketplace](https://marketplace.visualstudio.com/items?itemName=nolindnaidoo.regex-le) |
| **Cursor, VSCodium, Windsurf** | The same extension | [Open VSX](https://open-vsx.org/extension/OffensiveEdge/regex-le) |
| **Any MCP agent, via Node** | `extract_patterns` over stdio | `npx regex-le-mcp` · [npm](https://www.npmjs.com/package/regex-le-mcp) |
| **Zed** | The MCP server as a context server | [add it by hand](https://zed.dev/docs/ai/mcp) *(no listing yet)* |

All ten LE tools are on **[letools.dev](https://letools.dev)**.

## Also by nolindnaidoo

**Rust** — pixelcoords and pixelactions are one loop: pixelcoords answers *where*, pixelactions *acts* there. The five LE crates are the terminal half of the extensions they sit in — the same detection, held to the extension's own corpus, and an exit code instead of a results editor.

- **[pixelcoords](https://github.com/nolindnaidoo/pixelcoords)** — Freeze your screen, mark regions, get pixel-exact coordinates and crops
  [pixelcoords.dev](https://pixelcoords.dev) · [crates.io](https://crates.io/crates/pixelcoords) · [docs.rs](https://docs.rs/pixelcoords)
- **[pixelactions](https://github.com/nolindnaidoo/pixelactions)** — Consume human-verified coordinates, perform the interaction, confirm it landed
  [pixelactions.dev](https://pixelactions.dev) · [crates.io](https://crates.io/crates/pixelactions) · [docs.rs](https://docs.rs/pixelactions)
- **[paths-le](https://github.com/nolindnaidoo/paths-le/tree/main/crate)** — Find every path in a codebase and report whether it still points at anything
  [crates.io](https://crates.io/crates/paths-le)
- **[secrets-le](https://github.com/nolindnaidoo/secrets-le/tree/main/crate)** — Find hardcoded credentials, and never print one
  [crates.io](https://crates.io/crates/secrets-le)
- **[urls-le](https://github.com/nolindnaidoo/urls-le/tree/main/crate)** — Extract every URL from a codebase, with its protocol and exact position
  [crates.io](https://crates.io/crates/urls-le)
- **[string-le](https://github.com/nolindnaidoo/string-le/tree/main/crate)** — Get every string in a codebase out where a person can read them
  [crates.io](https://crates.io/crates/string-le)
- **[numbers-le](https://github.com/nolindnaidoo/numbers-le/tree/main/crate)** — Find every hardcoded number in a codebase so a person can check them
  [crates.io](https://crates.io/crates/numbers-le)
- **[envsync-le](https://github.com/nolindnaidoo/envsync-le/tree/main/crate)** — Compare the dotenv files in a tree and say which keys are missing from which
  [crates.io](https://crates.io/crates/envsync-le)
- **[scrape-le](https://github.com/nolindnaidoo/scrape-le/tree/main/crate)** — Check whether a page is scrapeable before the scraper is written
  [crates.io](https://crates.io/crates/scrape-le)

**Contact Developer** — [nolindnaidoo.com](https://nolindnaidoo.com) · [GitHub](https://github.com/nolindnaidoo) · [LinkedIn](https://www.linkedin.com/in/nolindnaidoo/)

## License

MIT — see [LICENSE](https://github.com/nolindnaidoo/regex-le/blob/main/LICENSE).
