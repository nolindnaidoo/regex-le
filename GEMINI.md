# Contributor and agent instructions

**Read [AGENTS.md](AGENTS.md) before writing any code.** It carries the
engineering standard this repository is held to — control flow, error handling,
immutability, structure — plus the architecture, the invariants and why each
one exists. [CLAUDE.md](CLAUDE.md) is the short version: gates and traps.

This file exists only to route you there. It is deliberately thin: the standard
lives in one place so it cannot drift between tools.

## Non-negotiables

- Guard clauses first. **No `else`, no `else if`** — two branches are an early
  return, many are a lookup table.
- Nesting stops at two levels inside a function.
- Immutable by default: `readonly`, `ReadonlyArray`, `Object.freeze`. Never
  mutate a parameter.
- Composition, never inheritance. Factory functions returning frozen objects,
  dependencies passed in as a typed bag.
- Logic never touches `vscode.window.*`; `ui/` renders and `commands/`
  orchestrates.
- **Never report success you did not achieve** — check what the API returned.
- Errors are descriptive and never swallowed.
- Comments explain **why**, never what.
- Commits are conventional (`fix:`, `feat:`, `docs:`…), imperative, and
  enforced by a hook and by CI.

## Before you commit

```bash
bun run typecheck && bun run lint && bun run test
```

Coverage thresholds are a floor and are never lowered to make a build pass.
Every claim in a README or manifest must be provable against the code.
