# AGENTS.md — Regex-LE

Technical source of truth for this repo. README.md is the user-facing doc; this file is for anyone (human or agent) changing the code.

## What this is

A VS Code extension that finds regex patterns in the active document (literals, `new RegExp(...)`, `RegExp(...)`), tests them against the file content, and screens them for ReDoS-prone shapes. No network access, no filesystem writes.

## Architecture

```
extension.ts             activate(): createServices() -> registerCommands()
services/serviceFactory  createServices(context) -> { telemetry, notifier, statusBar }
commands/                one file per command (test, extract, validate, help);
                         deps injected as a frozen bag; settings.ts registers openSettings
extraction/regex/
  heuristics.ts          THE single regex-vs-division context rule + flag/compile checks
  position.ts            offset -> {line, column} via newline index (1-based)
  extractPatterns.ts     whole-content extraction, both forms route through heuristics
  regexTest.ts           executes with the 'd' flag; group positions from match.indices
  redos.ts               structural ReDoS scanner (nested quantifiers, overlap)
  performance.ts         heuristic complexity/perf scoring for reports
ui/                      notifier (window messages, gated by notificationsLevel:
                         all -> everything, important -> warn+error, silent -> error only),
                         statusBar
utils/                   errors (sanitizeErrorMessage), safety (size/output guards)
config/config.ts         getConfiguration() snapshot; CONFIG_DEFAULTS table
types.ts                 shared types only — no logic
```

Conventions: factory functions + `Object.freeze` (no classes), early returns, dependency bags typed inline at the consumer. Runtime strings are plain English; `package.nls.json` (mirrored in `src/i18n/`) localizes **manifest** strings only (VS Code `%key%` substitution — do not add a runtime i18n layer without wiring real bundles).

## Invariants (things that were once broken — keep them true)

- **The bundle must be self-contained.** The VSIX ships `dist/extension.js` only; `scripts/check-bundle.js` (run in `vscode:prepublish` and CI) does a static require scan AND loads the bundle with `vscode` stubbed.
- **`CONFIG_DEFAULTS` must equal package.json defaults.** `config.test.ts` asserts parity over every declared setting; add new settings to both plus the KEY_MAP in the test.
- **Every declared setting must have a consumer.** v1 shipped 4 no-op settings; don't add a setting without wiring it.
- **Extractor/ReDoS behavior is pinned by golden snapshots** (`extraction/regex/characterization.test.ts` + `__fixtures__/`). Any output change must update goldens in the same commit and be listed in the CHANGELOG.
- **Regex-vs-division context lives in one place** (`extraction/regex/heuristics.ts`). Never re-implement it inside an extractor form.
- **The two nls catalogues stay in key parity** with each other and with exactly the `%key%` set the manifest uses.

## Toolchain

- **Build:** esbuild bundle (`bun run build`, `build:prod` minified). `tsc` is typecheck-only (`noEmit`) and covers test files.
- **Unit tests:** vitest; `vscode` aliased to `src/__mocks__/vscode.ts` (stateful mock with `_reset/_set` helpers). Coverage thresholds enforced: 80 lines / 80 funcs / 75 branches / 80 stmts.
- **Integration tests:** `bun run test:integration` — `@vscode/test-cli` launches a real VS Code (config in `.vscode-test.mjs`, tests compiled via `tsconfig.it.json` to `out-test/`). The extension id there is `publisher.name` from the manifest.
- **Lint/format:** Biome (tabs, single quotes). `__fixtures__`/`__snapshots__` are exempt (lint+format+assist) — formatting fixtures would corrupt goldens.
- **Packaging:** `bun run package` → `release/*.vsix`. `.vscodeignore` is an allow-list; the VSIX is ~9 files.

## Release

1. Bump `version` in package.json, add a CHANGELOG entry.
2. CI green on all 3 OSes (includes packaging + integration tests).
3. `Release` workflow (manual dispatch) publishes to the VS Code Marketplace (`VSCE_PAT`) and Open VSX (`OVSX_PAT`) — Open VSX is what Cursor/VSCodium users install from. Locally: `bun run package` then `vsce publish` / `ovsx publish`.

## Known limitations (documented, not bugs)

- Extraction is lexing by heuristic, not a JS parser: a slash inside a string or comment can false-positive when its context looks expression-like (`https://…` and division chains are specifically rejected).
- Constructor extraction only sees literal string arguments — variables and template literals are invisible.
- Duplicate pattern+flags pairs are reported once (the location shown is the first occurrence of that form).
- The ReDoS scanner flags shapes, it does not prove safety; unrecognized patterns can still backtrack badly.
- Performance scores are throughput heuristics; memory is not measured (always reported as unmeasured).
