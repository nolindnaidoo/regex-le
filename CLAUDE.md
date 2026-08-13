# CLAUDE.md

[AGENTS.md](AGENTS.md) is the technical source of truth for this repo: the
engineering standard the code is held to — control flow, error handling,
immutability, structure — plus this repo's architecture, invariants, toolchain
and release. Read it before writing code. README.md is user-facing and partly
generated.

The repo also hosts the Rust CLI in `crate/` — read `crate/CLAUDE.md` and
`crate/AGENTS.md` for that side; the shared corpus is `crate/fixtures/`.

## Where to look

| Question | File |
|---|---|
| How should this code be written? | [AGENTS.md](AGENTS.md) — the standard, plus this repo's architecture and invariants |
| What does the user see? | [README.md](README.md) — Testing and Performance are generated |
| What changed? | [CHANGELOG.md](CHANGELOG.md) |

## Gates

```bash
bun run typecheck && bun run lint && bun run test
```

Before a release, also `bun run test:integration`, `bun run package`, and
`bun run test:e2e-vsix` — the last is the only test that exercises the
artifact users actually install.

## Things that will bite you

- **Two README sections are generated.** Testing and Performance sit between
  `<!-- coverage:start -->` / `<!-- performance:start -->` markers and come
  from `scripts/coverage-readme.js` and `scripts/perf-readme.js`. Edit the
  code and regenerate; do not type numbers in by hand. CI fails if the coverage
  figures no longer match a real run.
- **Output changes must update the characterization goldens** in the same
  commit, with a CHANGELOG entry describing the behaviour change.
- **Every claim must be provable.** No feature, metric or format goes in a
  README, the manifest, or help text unless the code backs it. That governs
  **behaviour and numbers** — not **availability**. Whether something is
  published, listed or installable is a fact about a registry at a moment in
  time, and it is false right up until you make it true. Copy for a release you
  are about to make is **staged, never forbidden**: write it, and let the
  release commit be what makes it true.
- **This repo is one of ten identical ones.** The shared config files, scripts
  and workflows are byte-identical across the family, and
  `letools-site/scripts/check-fleet.ts` is what holds them there rather than
  memory: run `bun run check:fleet ../` from a checkout of the site with the
  ten beside it, or dispatch its **Fleet** workflow. It names the file and the
  repos that drifted, so a missed copy is a report rather than something you
  find months later. Anything under `crate/` is outside the check on purpose —
  the crates stand on their own.
- **Detection is shared with the Rust CLI**, and the corpus under `crate/` is
  the contract. Changing detection behaviour means running
  `bun scripts/check-extraction-parity.ts` and updating the corpus — on both
  sides, in the same commit. CI fails when either drifts.
- **What the contract holds equal is the shared `extract_patterns` MCP tool**,
  which both servers offer and must answer identically; a difference there
  is a bug. **The surfaces are meant to differ.** This one is IDE-first —
  the active buffer, read by a person. The CLI is terminal-first: a tree walk,
  exit codes and JSON Lines, none of which has an editor equivalent. That
  is not drift, and nothing holds them equal — see `crate/SPEC.md`.
- **The crate ports the lint half only.** No matching, no timing, no capture
  groups. See `crate/SPEC.md`; contract tests on both surfaces enforce it.
- **Localization is two mechanisms, and they fail separately.** `src/i18n/package.nls.*.json`
  covers the manifest; `l10n/bundle.l10n.*.json` covers runtime strings through
  `vscode.l10n.t()`. Twelve locales each, held in exact key parity by the
  integration test. Never call `l10n.t()` at module scope, never compare a
  translated label against an English literal, and use positional `{0}`
  placeholders rather than template literals.
- **CI narrows itself on a docs-only push.** A change touching only `*.md` and
  `LICENSE` runs the Linux leg alone and skips the Zed build; `ci-crate.yml`
  runs its `policy` gate with every Rust job skipped. Nothing that covers the
  change is skipped — the README coverage gate, the integration suite and the
  installed-VSIX end-to-end are Linux-only anyway. Anything unrecognised, and an
  unreadable diff, counts as code and runs everything. A release commit always
  touches `package.json`, so a release still sees the full three-OS matrix.
- **Coverage floors are a backstop, not a target.** They sit well below where
  the code actually is, and they are not raised to track it — a floor that
  follows real coverage becomes a tax on writing the next module.
