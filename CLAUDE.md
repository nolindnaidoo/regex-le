# CLAUDE.md

[AGENTS.md](AGENTS.md) is the technical source of truth for this repo —
architecture, invariants, toolchain, security automation, release. README.md
is user-facing and partly generated.

**[../AGENTS.md](../AGENTS.md) is the fleet-wide engineering standard** —
control flow, error handling, immutability, structure. It governs every change
here; this repo's AGENTS.md covers only what is specific to it. Read it before
writing code.

## Where to look

| Question | File |
|---|---|
| How should this code be written? | [../AGENTS.md](../AGENTS.md) — the fleet standard, applies to every change here |
| How does this extension work? | [AGENTS.md](AGENTS.md) — architecture, invariants, known limits |
| What does the user see? | [README.md](README.md) — Testing and Performance are generated |
| What changed? | [CHANGELOG.md](CHANGELOG.md) |
| How do the other nine do it? | [../CLAUDE.md](../CLAUDE.md) — fleet map |

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
  README, the manifest, or help text unless the code backs it.
- **This repo is one of ten identical ones.** Config files and workflows are
  byte-identical across the family; a change here needs copying to the other
  nine. See `../CLAUDE.md`.
- **Localization is two mechanisms, and they fail separately.** `src/i18n/package.nls.*.json`
  covers the manifest; `l10n/bundle.l10n.*.json` covers runtime strings through
  `vscode.l10n.t()`. Twelve locales each, held in exact key parity by the
  integration test. Never call `l10n.t()` at module scope, never compare a
  translated label against an English literal, and use positional `{0}`
  placeholders rather than template literals.
- **Coverage thresholds are a floor**, never lowered to make CI pass.
