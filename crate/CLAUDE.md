# Instructions for AI coding assistants

Read [AGENTS.md](AGENTS.md) first — it is the engineering-standards
document for this crate and the source of truth for layout, control-flow
style, the settled decisions, testing requirements, and the definition
of done. [SPEC.md](SPEC.md) defines the product behavior. AGENTS.md wins
on any conflict. The extension at the repo root is a separate product
with its own `CLAUDE.md`.

- Before declaring any change complete, run exactly what CI runs:
  `cargo fmt --all --check`,
  `cargo clippy --all-targets -- -D warnings`,
  `cargo test --locked`. All three must pass — and
  `bun ../scripts/check-extraction-parity.ts` when detection changed.
- Never add inline `#[allow(...)]` — CI fails the build on it. Fix the
  lint, or add a commented relaxation to `[lints.clippy]` in
  `Cargo.toml`.
- New logic goes in `detect/` when it is pure (it must then be
  unit-tested, 90% module coverage floor), and in `walk.rs` / `scan.rs`
  only when it needs the filesystem. A `std::fs` call in `detect/`
  fails a CI job.
- **This ports the lint half, not the tester half.** No matching, no
  timing, no capture groups — see SPEC.md. Contract tests on both
  surfaces enforce it.
- **JavaScript's character classes are not Rust's.** `\w` is ASCII in a
  JavaScript regex and Unicode in `regex`; spell out what the extension
  means rather than borrowing what this language happens to give you.
  `regress` is here to *parse* a pattern and for nothing else.
- `fixtures/` is shared with the extension — changing it changes both
  frontends and needs a CHANGELOG entry. **What it holds equal is the
  shared `extract_patterns` MCP tool**, which must answer identically from
  either server; a difference there is a bug. The surfaces themselves
  are IDE-first and terminal-first and are meant to differ —
  the walk, `--severity`, `--strict`, the exit codes and JSON Lines have no
  editor equivalent and are not drift. SPEC.md's "Deliberate
  divergences" is the bar for a new one.
- Write regression tests for every bug you fix; keep unit tests free of
  clocks, randomness, and the filesystem outside `walk`/`scan`.
- **Run the binary, not only the tests.** 800 KB on one line spent the
  constructor pattern's backtracking budget and turned a whole minified
  bundle into a refusal. Every test passed: none of them was large
  enough to reach it.
