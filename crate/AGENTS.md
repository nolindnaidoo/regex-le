# regex-le (CLI) — engineering standards

This is the source of truth for how code in `crate/` is written, tested,
and reviewed. It applies to every contributor, human or AI-assisted. CI
(`.github/workflows/ci-crate.yml`) enforces the mechanical parts;
reviewers enforce the rest. [SPEC.md](SPEC.md) defines the product
behavior — verdicts, exit codes, the parity scope; this file is how the
code gets there. The extension at the repo root is a separate TypeScript
product with its own `AGENTS.md`.

## What this project is

The command-line and MCP frontend of Regex-LE: find every regular
expression in a tree and report which of them can be driven into
catastrophic backtracking. Nothing is executed — see SPEC.md, "Half the
extension, on purpose". One product, two frontends, one repository: the
corpus (`fixtures/`) is shared with the VS Code extension, and CI fails
when either side drifts from it.

**Status: released.** Both surfaces, the detection layer and the test
tiers below are built and green. Releases go out through
`release-crate.yml`, which is dispatch-only and refuses a version that
crates.io already carries, has no changelog entry, would ship a tarball
missing its own corpus, or whose corpus the extension no longer
reproduces.

## Layout

```
crate/src/
├── detect/      pure: pattern extraction, the ReDoS scan, the
│                heuristics, positions. No filesystem, pub(crate).
├── walk.rs      ignore-aware tree walking
├── scan.rs      one file end to end — the only path either surface calls
├── cli.rs       the terminal surface
└── mcp/         the agent surface
```

- **`detect/` touches no filesystem.** It takes document text and
  returns patterns and verdicts, so the entire detection layer tests
  from a fixture file — no temp directories, no flake. It carries the
  **90% line coverage floor per module**, enforced by the `coverage`
  job. A `std::fs` call appearing there is a bug, and the `policy` job
  greps for one.
- **`scan.rs` is the only path either surface calls.** `cli.rs` and
  `mcp/` are projections of one implementation; a surface that grows its
  own copy of a rule is a bug, and a contract test asserts the two
  return identical reports for the same tree.
- **`walk.rs` selects, it does not decide.** Its one rule — a file named
  explicitly is read whatever the ignore rules say — is why intent beats
  configuration.
- Keep modules flat. No layers, registries, managers, or services. No
  trait with a single implementation.

## Decisions already made (do not relitigate)

- **This ports the lint half, not the tester half.** Running a pattern
  against text with JavaScript semantics needs a JavaScript engine, and
  getting it nearly right would mean two frontends reporting different
  matches for the same pattern. The lint needs no engine: the ReDoS scan
  reads the pattern *text*. Contract tests on both surfaces assert no
  flag and no tool schema offers text to match against.
- **It flags shapes and cannot prove a pattern safe.** That scope is the
  extension's wording and it ports with the code. Silence is not a
  clearance, and the help text and README say so. A tool that implied
  more would be worse than one that found less.
- **Exit codes**: 0 nothing vulnerable, 1 at least one finding, 2 could
  not answer. `--severity` moves the line; `low` is refused because a
  check that fires on every pattern is a check nobody reads.
- **One crate, self-contained.** No published `-core`, no shared crate,
  and nothing holding this code equal to the similar files in the
  sibling repos. Where they agree it is because the same answer was
  right twice; where they diverge that is the point.
- **Three regex engines, each for one job.** `regex` for the patterns
  that need no backtracking. `fancy-regex` for the constructor pattern,
  whose lookbehind `regex` cannot express. `regress` to answer whether a
  pattern would compile in JavaScript — it **parses and never matches**,
  and that is the line between this half and the tester half. Any fourth
  needs a better reason than these three had.
- **JavaScript's character classes are not Rust's.** `\w` is ASCII in a
  JavaScript regex and Unicode in `regex`, so `is_regex_context` spells
  the rule out rather than borrowing `\w`. Borrowing it makes
  `café /x/` division here and a regex in the extension.
- **A pattern-and-flags pair is reported once**, at its first
  occurrence — the extension's design, and the reason a file using one
  validation regex ten times reports one finding.
- **The keyword list is ported verbatim.** A second implementation
  guessing at which keywords may precede a regex is how two frontends
  start disagreeing about what is even a pattern.
- **The language selects the forms and nothing else.** Nine languages
  are read; a name nothing recognises means every form is scanned for,
  which is what this did before it knew languages existed. The
  slash-versus-division walk runs **only** where a bare `/…/` is legal —
  JavaScript, TypeScript, Ruby — because everywhere else it is a guess
  with no finding behind it and a Python file of paths behind it.
- **Validity is asked of a JavaScript rendering, not the source.**
  `heuristics::is_well_formed` translates the handful of spellings
  `regress` refuses and other languages use daily — `(?P<n>…)`, `(?>…)`,
  `(?i)`, a possessive quantifier — before asking. Nothing translated
  reaches a report: the pattern reported and scanned is the source as
  written. `compiles` keeps its strict JavaScript meaning and is what
  the literal and constructor forms gate on.
- **stdout is protocol, stderr is human. There is no `--json` flag.**
- **Parity scope is detection only** — `src/extraction/**` on the
  extension side.

## Control-flow style

Flat over nested, guards over branches — the same rules as pixelcoords,
pixelactions and scrape-le:

- **No statement-position `else`.** Guard clauses and early `return`
  (`if !ok { return ... }` / `let Some(x) = ... else { return }`), then
  fall through to the happy path.
- **Value-position `if/else` is fine** — `let x = if cond { a } else
  { b }` is Rust's ternary.
- **`match` is fine and preferred** over any chain of condition tests on
  the same value; use match guards instead of `if/else` inside arms.
- Prefer combinators where they read cleanly: `bool::then_some`,
  `Option::map/filter/is_some_and`, `?`.
- No nesting deeper than two levels inside a function; extract a named
  helper instead.

## Hard rules

- **No inline `#[allow(...)]`** — CI greps and fails the build. Either
  fix the lint or add a visible, commented relaxation to
  `[lints.clippy]` in `Cargo.toml`.
- **Clippy pedantic, deny warnings.** `cargo clippy --all-targets --
  -D warnings` must pass exactly as CI runs it.
- **No async runtime.** This tool reads files and scans text. There is
  nothing to await.
- **`unsafe` is forbidden crate-wide** (`[lints.rust]`).
- **Dependencies are a cost.** Every one is justified by a comment in
  `Cargo.toml`. Justify any addition; prefer the standard library;
  prefer what is already in the tree.
- **No network, ever.**
- **Nothing writes, and nothing runs.** No `--fix`, no rewritten
  patterns, no matching. Suggesting an atomic group would be a rewrite
  of code this tool cannot test.
- **Strict parsing, never silent defaults.** An unrecognised flag, a
  severity that does not resolve, an input that does not exist: all are
  errors with actionable messages. A typo'd `--sever` that silently did
  nothing would report a clean lint that never ran the check asked for.
- **Refuse rather than guess.** A *text* file that cannot be read is
  reported as unexamined and `--strict` exits 2 — never a clean result
  that quietly skipped it. A scan that exhausts its backtracking budget
  says so rather than reporting no patterns. A **binary** file is a
  different thing: a NUL byte in the first 8 KB means it was never a
  text candidate, so it gets no report line and no say in the exit code,
  and is counted on stderr instead. Calling a PNG an unexamined file
  exits 2 on every repository with an icon in it.
- **Refusals speak the caller's vocabulary.** An MCP caller has no
  command line; no message aimed at one mentions `--severity` or any
  other flag. A test asserts no MCP output contains `--`.
- **`extract_patterns` belongs to both servers.** The npm server
  (`src/mcp/tools.ts`) and this one offer the same tool: same schema,
  same envelope, byte-identical output.
  `fixtures/mcp-extract-patterns.json` runs against both, so changing
  one without the other fails a build. Every tool here returns that
  envelope — `{ ok, data, diagnostics, meta }` — where `ok` means the
  check ran, never that the answer was yes.

## The corpus contract

`fixtures/` lives inside this crate so the published package is
self-contained — `cargo package` cannot reach above its own directory.
The corpus is **not** needed to build the binary; that was checked
rather than assumed, by deleting it from an unpacked tarball and
building. It is needed to *verify*: `cargo test` on the published crate
runs every corpus case, so a consumer can check the parity claims
instead of trusting them. That is why it ships, and the release workflow
asserts it is in the tarball. It is still shared ground: the extension
reads the same files.
`../scripts/check-extraction-parity.ts` (the `parity` job in
`ci-crate.yml`) fails when the extension drifts. Changing a document or
an expectation is a behavior change for **both** frontends and needs a
CHANGELOG entry.

Where the two must disagree, the disagreement is written down in
SPEC.md and a test asserts what each side actually answers. There is no
other sanctioned way to differ.

## Testing

The bar, enforced by review:

- **`detect/`: 90% line coverage floor per module.** Everything in it is
  pure; if something is hard to test there, the design is wrong. Per
  module rather than the crate total, because a total lets one module
  slide while the others carry it.
- **The parity corpus is embedded.** Every `fixtures/` case runs as a
  unit test; the expected values are the extension's answers.
- **Exit codes belong in `tests/contracts.rs`.** They are the API —
  callers branch on them — so they are pinned by tests that drive the
  built binary against a temporary tree: no network, no privileged
  operation, so they run everywhere on every push. A new refusal adds
  its case there.
- **Anything needing a document larger than an editor opens is
  `tests/scenarios.rs`** — gated behind `REGEX_LE_SCENARIOS` and run by
  CI on all three OSes. A skipped scenario is never reported as a pass;
  each one says plainly that it did not run.
- **Every bug fix ships with a regression test** that fails before the
  fix. The backtracking-budget bug is the cautionary one: 800 KB on one
  line turned a whole minified bundle into a refusal, every test passed,
  and none of them was large enough to reach it. Run the binary, not
  only the tests.
- Tests are deterministic: no clocks, no randomness, and **no filesystem
  in `detect/` tests** — everything there runs from the corpus.

## Verification — the definition of done

All of it, exactly as CI runs it, before every push:

```bash
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test --locked
bun ../scripts/check-extraction-parity.ts   # when detection changed
```

CI additionally builds on macOS, Windows and Linux, checks the Rust 1.88
minimum version, runs `cargo audit`, the no-inline-`#[allow]` and
no-filesystem-in-`detect/` policy jobs, the per-module coverage floor,
the gated scenarios, and parity — including on extension-side edits to
`src/extraction/**`, so neither frontend can drift green. A change is
not done because it compiles; it is done when it is tested, linted,
documented where behavior changed (README / CHANGELOG / SPEC / this
file), and honest — claims in docs must match the code.

## Commits and pull requests

The repo root's convention applies unchanged (root `AGENTS.md`):
conventional prefix, imperative subject under 72 characters, body
carrying the *why* — enforced by the `commit-msg` hook and the
`Commit messages` CI job. One concern per change; if docs describe the
thing you changed, update them in the same commit. Release tags are
`crate-v*`, and a release goes out by dispatching `release-crate.yml`
with its publish opt-in — never by pushing a tag, because a crates.io
version can never be reused.
