# Changelog

All notable changes to Regex-LE will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file covers the **VS Code extension**. The Rust CLI in `crate/` is a
separate product on its own cadence and keeps its own
[CHANGELOG](crate/CHANGELOG.md).

## [Unreleased]

### Added

- **Seven more languages.** `extractRegexPatterns` now finds patterns at
  the call sites Python, Rust, Go, Java, Ruby, PHP and C# write them at,
  alongside the JavaScript and TypeScript literals and `RegExp`
  constructors it read before. A `.py`, `.rs` or `.go` file holding
  `(a+)+` came back with nothing; each is now a high-severity finding.
- `extractRegexPatterns(text, languageId?)` takes the document's
  language. The `Extract`, `Test` and `Validate` commands pass the
  editor's; `extract_patterns` over MCP takes an optional `format` or
  `filename`, and a name it does not recognise comes back as a warning
  diagnostic rather than being silently ignored.
- MCP `extract_patterns` now reports `redos.vulnerableGroups`, which the
  Rust server already did.

### Changed

- **The language selects which spellings are looked for**, and the
  slash-versus-division walk runs only where a bare `/…/` is legal —
  JavaScript, TypeScript, Ruby. A Python document no longer reports
  `#!/usr/bin/env python` as a pattern. A document whose language is
  absent or unrecognised is scanned exactly as before, for everything.
- **Another language's spelling is no longer a syntax error.**
  `re.compile(r'(?P<year>\d{4})')` is ordinary Python that JavaScript
  refuses; `detectReDoS` used to answer `Pattern is invalid` for it.
  Validity is now judged against a JavaScript rendering of the pattern,
  while the pattern reported and scanned stays the source as written.

- A **Rust CLI and MCP server**, in [`crate/`](crate/README.md), published
  to crates.io as [`regex-le`](https://crates.io/crates/regex-le). It runs
  the same pattern detection and ReDoS screen over a whole tree, with exit
  codes — 0 nothing vulnerable, 1 at least one finding, 2 malformed
  question — so it composes in a shell and gates a merge.

  It ports the **lint half only**: no matching, no timing, no capture
  groups. Testing a pattern against text is an editor activity and needs a
  JavaScript engine to be honest about; the lint needs none. The extension
  stays the reference implementation, `crate/fixtures/` is the contract,
  and `ci-crate.yml` watches `src/extraction/**` so neither side can drift
  green.

## [2.2.4] - 2026-08-07

### Changed

- Documentation only — no behaviour change.

  The cross-references now point at each tool's own page on letools.dev rather
  than its VS Code Marketplace listing. The Marketplace listing shows one of
  the four channels a tool ships through; the detail page shows all of them,
  which is what a reader following a link from another tool is looking for.
  Install instructions are untouched, and the rating links now lead with Open
  VSX — where the audience these READMEs reach actually installs from.

- `homepage` in the extension and MCP manifests, and `websiteUrl` in the
  registry entry, resolve to the same detail page.

## [2.2.3] - 2026-08-05

### Changed

- Documentation and packaging metadata only — no behaviour change.

  The MCP server's source now explains its decisions rather than restating its
  code: why MCP's stdio transport is line-delimited and what happens to a client
  if you copy LSP's framing, why a tool failure is a result carrying `isError`
  rather than a JSON-RPC error and what each does to a model's next move, why
  the result cap is measured in context windows rather than milliseconds, and
  why `truncated` matters more than the cap itself.

- The npm package declares `publishConfig.provenance`, so a release published
  from CI carries a Sigstore attestation binding the tarball to the commit and
  workflow that built it. A consumer can verify it with `npm audit signatures`.

- The registry entry names its registry (`registryBaseUrl`) and how to run the
  package (`runtimeHint`), rather than leaving a client to infer both.

- Package metadata points at the author's site, and the npm page links the rest
  of the family, the Rust tools and their crates.

## [2.2.2] - 2026-08-05

### Changed

- Documentation only — no behaviour change.

  The README described a keyboard shortcut and little else. 2.2.1 added an MCP
  server that VS Code registers with agent mode, published it to npm and to the
  official MCP registry, and submitted a Zed extension — and a reader could
  discover none of it from this page. There is now a section for calling the
  tool from an agent, including the JSON config for hosts that use one and a
  one-line check that the server answers before you wire it into anything.

  The privacy section previously spoke only for the extension. It covers the
  server too, which is the part an agent actually runs.

  The registry listing gains a display name, an icon and a link to letools.dev;
  the npm page gains the badges and links it was missing. Every surface now
  points at the others.

## [2.2.1] - 2026-08-05

### Changed

- **VS Code 1.101 is now the minimum.** `engines.vscode` moves from `^1.90.0`
  to `^1.101.0` and `@types/vscode` is pinned exactly to the new floor, per the
  rule that the declared floor and the type surface must match. 1.101 is the
  first stable release carrying `registerMcpServerDefinitionProvider`, which
  the MCP integration needs — declaring the contribution point against an older
  floor would be a claim the code could not honour. Cursor and VSCodium track
  well past this; Cursor 3.6.21 reports 1.105.1.

### Added

- An MCP server, shipped inside the VSIX as `dist/mcp-server.js`. It exposes
  `extract_patterns` over stdio, so an agent can pull every pattern out of a document
  with its 1-based position.

  It imports the extraction engine and nothing from `vscode` —
  `check:mcp-bundle` fails the build if that stops being true, because the
  server has to run in Zed, in Claude Code, and from `npx`.

- The extension now offers that server to VS Code's agent mode, so installing
  it adds `extract_patterns` to the agent's tools alongside the existing commands.
  Nothing is downloaded at runtime: the server is the copy inside the VSIX.
  The registration is skipped on editors that do not implement the API, which
  is not an error — an editor without agent mode is not a broken install.

- The server is on npm as [`regex-le-mcp`](https://www.npmjs.com/package/regex-le-mcp),
  so `npx regex-le-mcp` gives the same tool to Claude Code, Cursor, Windsurf or
  anything else that speaks MCP. It is the same build the VSIX carries, and its
  version is written from this manifest rather than maintained separately.

- A **Zed extension**, under `zed/`. Zed's extension API has no way to read the
  active buffer or register a command, so this extension could never be ported
  there in any language; a context server is the surface that fits. The crate
  is a launcher — it installs `regex-le-mcp` and starts it with Zed's Node — so
  there is no second implementation to keep in agreement with the goldens.

  There is one tool rather than two. Splitting extraction from ReDoS analysis
  would make the common request — "are any of the regexes in this file
  dangerous?" — two round trips with the patterns threaded back in, so the
  safety verdict travels with the pattern it belongs to.

  A pattern that defeats the analyser is still a real finding: it is returned
  without a verdict and a warning is attached, rather than being dropped or
  failing the whole scan and discarding every other finding.

### Fixed

- The coverage gate could pass against a stale summary. `coverage-readme.js`
  reads `coverage/coverage-summary.json` rather than running coverage, so when
  that file was older than the code both modes lied — the rewrite reproduced
  stale numbers and `--check` then compared the README against the same stale
  file and reported it current. Both modes now refuse a summary older than
  `src/`.

- The manifest placeholder gate only inspected `contributes.commands`, so a
  `%key%` on any other contribution point could ship as literal text. It now
  walks the whole `contributes` tree.

## [2.1.0] - 2026-08-05

### Added

- Runtime strings are localized, and this time they render. All 9 of them —
  notifications, status bar, quick-picks and prompts — go through
  `vscode.l10n` and ship as twelve translated bundles in `l10n/`. The v1.x
  line carried manifest catalogues that worked and runtime catalogues that
  never reached the screen: `vscode-nls` was configured without
  `__filename`, so every runtime string fell back to English while the VSIX
  looked correct.
- An integration test covering both localization mechanisms — manifest
  substitution, key parity across all thirteen catalogues, and placeholder
  integrity in every translation. A translation that silently drops `{0}`
  now fails the build instead of shipping a message with the value missing.

- Dependency review on pull requests, failing on a high-severity addition
  before Dependabot's auto-merge can act.

### Fixed

- A clipboard that could not be written cost the user the report. The copy
  runs before the results document opens, so an unavailable clipboard — a
  remote or headless session — aborted the command over an optional
  convenience and nothing was shown. Test and Validate now warn and still open
  the report.
- The validation report claimed "This pattern is safe to use and performs
  well" and "No vulnerabilities found" when nothing was detected. The ReDoS
  detector is a structural scanner that recognises known catastrophic shapes
  and explicitly cannot prove a pattern safe — as the README already said, and
  as its own module documentation says. A user could have shipped a
  catastrophically-backtracking pattern this heuristic does not recognise
  having been told it was safe. Both lines now state what was actually
  checked.
- Progress messages ("Validating pattern 3/12", "Testing pattern 3/12"), the
  input-box validation message ("Pattern cannot be empty") and three
  "no patterns found" notifications were never localized. Progress text is passed to `progress.report()` and validation text
  is returned from a callback, so neither was reached by the property-based
  localization pass.

### Changed

- Every `else` block is gone (15 real ones; a sixteenth was the string
  `'else'` in a keyword set). The four-arm recommendation chain in Validate,
  which repeated `isValid` in every condition, is now ordered guards in one
  function.
- The ReDoS "scan did not run" result was built inline in three `else` blocks.
  It is one frozen constant in `analysis/noFinding.ts`.
- Test and Validate each held registration, prompting, the run and the report
  in one file (397 and 369 lines). The runs and their reports moved to
  `commands/testRunner.ts` and `commands/validateRunner.ts`, leaving the
  command files at 151 and 97.

- Test coverage raised from 71.39% to 75.30% of branches (87.95% to 90.02% of
  statements, 92.22% to 98.88% of functions). Four files sat below one of the
  repo's own floors; none do now. The validate and test commands are driven by
  a pattern input box and a picker, and everything past those — the ReDoS
  screen, the complexity score, the report, the /pattern/flags parsing — is
  reachable only by answering them. The status bar's show, hide and dispose
  had never been called: it is created during activation and then left alone.


- CI gains fleet-wide checks that no single repo can perform: shared config is
  compared across all ten extensions, and every README link is verified —
  including Open VSX links, which are checked against the API because
  open-vsx.org answers HTTP 200 for extensions that do not exist.

## [2.0.1] - 2026-08-04

### Fixed

- A catastrophically backtracking pattern can no longer hang the extension
  host. The ReDoS pre-screen is a heuristic and can be declined or turned
  off; past that point nothing bounded the match, because the match-limit
  caps how many matches are collected, not how long a single `exec()`
  runs. Matching now happens on a worker thread with a 2s budget, which is
  the only mechanism that can interrupt an in-flight regex.

### Changed

- Marketplace categories re-targeted for discovery. `Other` is dropped
  (65,992 extensions, no discovery value); each extension now sits in
  categories matching how it is actually used.
- Search keywords widened to 30, targeting the terms users actually type
  rather than internal vocabulary.
- Toolchain moved to current: TypeScript 7, vitest 4, Biome 2.5.7,
  @types/node 26. `@types/vscode` is now pinned exactly to the
  `engines.vscode` floor — the caret had let the type surface drift 15
  minors ahead of the version actually supported.
- Runtime dependencies updated across majors where present: csv-parse 7,
  ini 7, js-yaml 5. Extraction output is unchanged, verified against the
  characterization goldens.
- Packaging no longer walks the npm tree (`vsce package --no-dependencies`).
  The bundle is self-contained, so the walk served no purpose and failed
  after any dependency change. Scrape-LE keeps it, since it genuinely
  ships `playwright-core`.
- Documentation claims corrected against the code. Removed: Numbers-LE
  "with statistics", EnvSync-LE "visual diffs", Regex-LE "live feedback",
  String-LE "and validation" — none of those features exist.

### Added

- Rating links in the in-extension help output, for both the VS Code
  Marketplace and Open VSX. Acquisitions exceed listing page views, so most
  users never see the listing's rating control; help is the surface they do
  reach.
- README now carries measured Performance and Testing sections, both
  generated rather than written — from `scripts/benchmark.ts` and from the
  coverage summary. CI fails if the coverage numbers drift from a real run.
- Coverage thresholds enforced at 75 lines / 80 functions / 60 branches /
  75 statements.
- CodeQL scanning, Dependabot with grouped weekly updates, and auto-merge
  limited to patch and minor devDependency bumps that pass CI.

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
