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

- **Runtime targets:** `engines.vscode` is the supported floor and `@types/vscode` is pinned to it **exactly**. A caret there lets the type surface drift ahead of the version users actually run, so code compiles against APIs that are not there at runtime. Dependabot is configured to never bump it.
- **Build:** esbuild bundle (`bun run build`, `build:prod` minified). `tsc` is typecheck-only (`noEmit`) and covers test files. TypeScript 7.
- **Unit tests:** vitest 4; `vscode` aliased to `src/__mocks__/vscode.ts` (stateful mock with `_reset/_set` helpers). Coverage provider `v8`, thresholds enforced at **75 lines / 80 functions / 60 branches / 75 statements**. These are a floor to ratchet upward, never to lower so a build passes.
- **Integration tests:** `bun run test:integration` — `@vscode/test-cli` launches a real VS Code (config in `.vscode-test.mjs`, tests compiled via `tsconfig.it.json` to `out-test/`). That project targets `node16` module resolution; TypeScript 7 removed `node10`, which `"Node"` resolved to.
- **Installed-VSIX tests:** `bun run test:e2e-vsix` installs the built `.vsix` into a clean VS Code profile and drives it. This is the only test that exercises the artifact users receive, and it runs in CI.
- **Lint/format:** Biome (tabs, single quotes). `__fixtures__`/`__snapshots__` are exempt — formatting fixtures would corrupt goldens. `biome.json` is byte-identical across all ten repos; change it in one and copy it to the rest.
- **Packaging:** `bun run package` → `release/*.vsix`. `.vscodeignore` is an allow-list; the VSIX is ~9 files. Packaging uses `--no-dependencies`: the bundle is self-contained, so walking the npm tree served no purpose and broke after any dependency change.
- **Localization:** This extension is English-only — `src/i18n/` holds `package.nls.json` and nothing else. Adding a locale means adding the file **and** keeping it in key-parity with the base catalogue.

## Generated documentation

Two README sections are generated. Do not hand-edit the content between their markers.

- `bun run test:coverage && bun run coverage:readme` writes the Testing section from `coverage/coverage-summary.json`. CI runs `coverage:readme:check`, which fails when the committed numbers no longer match a real run — coverage is compared within 1 percentage point (it is not bit-identical across machines), while test counts are derived from source and must match exactly.
- `bun run benchmark && bun run perf:readme` writes the Performance section from a real run of the extraction entry point. This is **not** checked in CI: throughput is machine-specific, so a hosted runner would fail it for reasons that say nothing about the code. The host is printed with the numbers instead.

The pre-2.0 README carried hand-written test counts and throughput figures that drifted until they were false. Generating them is what stops that recurring.

## Security & automation

- **CodeQL** runs on push, PR and weekly (`javascript-typescript` + `actions`), configured in `.github/codeql-config.yml`. Test files and fixtures are excluded on purpose: they contain inputs that are supposed to look dangerous, and scanning them produces findings that can only ever be dismissed.
- **Dependabot** (`bun` ecosystem, not `npm` — the npm updater rewrites `package.json` without regenerating `bun.lock`, so its PRs can never pass the frozen-lockfile gate) opens grouped weekly PRs.
- **Auto-merge** is workflow-driven, not GitHub-native: `main` has no required status checks, so native auto-merge would land a PR before CI started. `dependabot-auto-merge.yml` waits for the CI run to conclude and merges only patch/minor **devDependency** updates. Runtime dependencies bundle into the shipped VSIX and always need a human.
- **Actions are pinned to commit SHAs.** A tag is mutable and this repo holds a publish token. The trailing `# vX.Y.Z` comment is what Dependabot reads and rewrites.
- **Branch safety:** a `main-safety` ruleset blocks deletion and force-push. Pushes to `main` are otherwise unrestricted by design.
- Secret scanning and push protection are enabled. `VSCE_PAT` and `OVSX_PAT` live in repo secrets and in Doppler (`extensions` / `prd`).

## Release

1. Bump `version` in package.json and write the CHANGELOG entry. The entry must describe what actually changed, including bug fixes — it ships inside the VSIX and renders on the listing page.
2. Regenerate the README sections (`coverage:readme`, and `perf:readme` if behaviour changed) and commit them.
3. CI green on all three OSes. That includes lint, typecheck, coverage, the bundle gate, packaging, integration tests, and the installed-VSIX e2e.
4. Tag the commit being released, so the tag is the artifact rather than an approximation of it.
5. Dispatch the `Release` workflow. It takes two independent opt-ins — `marketplace` (default **on**) and `openvsx` (default **off**) — because a version cannot be republished, so a run that publishes one registry and fails on the other is only recoverable by re-running with the failed target alone. It validates credentials before doing anything irreversible.

**Open VSX defaults off deliberately.** `ovsx publish` takes no namespace argument; it derives the namespace from `publisher` in the VSIX. Enabling it publishes to whatever `package.json` currently names, with no confirmation.

## Known limitations (documented, not bugs)

- Extraction is lexing by heuristic, not a JS parser: a slash inside a string or comment can false-positive when its context looks expression-like (`https://…` and division chains are specifically rejected).
- Constructor extraction only sees literal string arguments — variables and template literals are invisible.
- Duplicate pattern+flags pairs are reported once (the location shown is the first occurrence of that form).
- The ReDoS scanner flags shapes, it does not prove safety; unrecognized patterns can still backtrack badly.
- Performance scores are throughput heuristics; memory is not measured (always reported as unmeasured).
