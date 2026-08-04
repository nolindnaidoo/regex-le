# CLAUDE.md

[AGENTS.md](AGENTS.md) is the technical source of truth for this repo —
architecture, invariants, toolchain, security automation, release. README.md
is user-facing and partly generated.

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
- **Coverage thresholds are a floor**, never lowered to make CI pass.
