# CLAUDE.md

Read [AGENTS.md](AGENTS.md) — it is the technical source of truth for this repo (architecture, invariants, toolchain, release). README.md is user-facing.

Quick gates before any commit:

```bash
bun run typecheck && bun run lint && bun run test
```

Extractor/ReDoS output changes must update the characterization goldens in the same commit and get a CHANGELOG entry.
