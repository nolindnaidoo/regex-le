# Changelog

All notable changes to Regex-LE will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.1] - 2026-08-03

### Added

- Rating links in the in-extension help output, for both the VS Code
  Marketplace and Open VSX. Acquisitions exceed listing page views, so most
  users never see the listing's rating control; help is the surface they do
  reach.

## [2.0.0] - 2026-07-29

Full rehabilitation release. The headline: **v1.x VSIXes built from this
repo could not activate** — the build had no bundler while the package
excluded `node_modules`, so the extension crashed on load with
`Cannot find module 'vscode-nls'`. 2.0.0 ships a self-contained esbuild
bundle, verified by a packaging gate and a real extension-host
integration suite on every CI run.

### Fixed

- **Packaging**: `dist/extension.js` is now a single self-contained
  bundle (VSIX: 37 files → 9). A bundle gate (static require scan +
  loading the bundle with `vscode` stubbed) blocks any regression.
- **Config**: non-numeric setting overrides no longer produce `NaN`
  thresholds; the string `"false"` no longer reads as `true`; code
  fallbacks now provably match manifest defaults (asserted by a test
  covering every declared setting).
- **Status bar**: reacts to `statusBar.enabled` changes without reload.
- **Telemetry**: follows `telemetryEnabled` at runtime instead of a
  one-time activation snapshot.
- **notificationsLevel is actually wired**: `all` shows everything,
  `important` shows warnings and errors, `silent` (the default) shows
  errors only. Previously only two ad-hoc guards consulted it.
- **safety.largeOutputLinesThreshold is actually wired**: extract now
  refuses oversized result documents; the setting previously gated
  nothing.

### Changed — extraction and analysis output

- **Multiline `new RegExp(...)` constructors are now found** (the
  per-line scanner missed them entirely), including trailing commas and
  escaped quotes in the arguments.
- **Division/date/path false positives are gone**: `a / b / c`,
  `10/29/2025`, and `/usr/local/bin` no longer extract as regexes; a
  slash after keywords like `return` still does.
- **Constructor patterns are unescaped to their runtime value**:
  `new RegExp('\\d+')` now reports the pattern `\d+`, not `\\d+`.
- **Real positions everywhere**: extraction results are sorted by
  position, constructor matches no longer swallow the preceding
  character, test-match columns are 1-based to match the reports, and
  capture-group start/end come from the engine's `d`-flag indices
  instead of `indexOf` guesses. Named capture groups are surfaced.
- **ReDoS detection is structural**: it scans for quantified groups
  with unbounded inner quantifiers (high severity) and overlapping
  quantified alternation (medium), reporting the offending groups. The
  old source-string comparison missed classics like `([a-z]+)*`.
- **Complexity scoring**: nesting depth no longer re-reads the first
  paren via `indexOf`; escaped parens and character classes are
  skipped.
- Every change above is pinned by characterization goldens
  (`src/extraction/regex/__fixtures__/`).

### Removed

- 4 settings that were never read by any code path
  (`performance.enabled`, `performance.maxDuration`,
  `performance.maxMemoryUsage`, `regex.realtimePreviewEnabled`).
  10 real settings remain, each with a consumer.
- The runtime "localization" layer: it never loaded a single
  translation (broken `vscode-nls` wiring; the per-module bundles it
  needed were never generated) — users always saw English. Manifest
  strings remain localizable via VS Code's `%key%` mechanism; only an
  English catalogue ships today.
- A settings-import validator with no importer, an unused output
  channel wrapper, a never-called performance monitor, and the
  enhanced-error framework whose severity/recovery machinery no caller
  consumed — roughly 1,900 lines of dead code, plus unused
  dependencies (`vscode-nls`, `tsx`, `@vitest/ui`).
- Stale docs (`docs/`, `.cursorrules`) replaced by an accurate README +
  AGENTS.md. Earlier README claims of "13 languages" and automatic
  performance monitoring did not hold and are gone.

### Infrastructure

- `engines.vscode ^1.90.0` — current VS Code and Cursor 2.x supported.
- Real quality gates: typecheck now covers tests (it previously
  excluded them — and there was no typecheck script at all), coverage
  thresholds actually enforce (the old config used an inert Jest-style
  key; now 89% lines, enforced at 80), integration tests run in a
  downloaded VS Code on all 3 OSes, CI packages the VSIX and uploads
  it.
- Release workflow publishes to both the VS Code Marketplace and Open
  VSX (Cursor's marketplace source).
- Publisher is `nolindnaidoo`; all repository links point there.

> Entries below this line predate 2.0.0 and have been condensed: the
> original release notes claimed features and quality (13 languages,
> automatic performance monitoring, enterprise-grade error handling)
> that the shipped code did not have — and the shipped VSIX could not
> activate at all.

## [1.7.1] - 2025-11-02 — README family-links update.

## [1.7.0] - 2025-11-02 — Initial public release: extract/test/validate
commands, ReDoS warnings, safety thresholds, local-only telemetry.
