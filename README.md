<p align="center">
  <img src="src/assets/images/icon.png" alt="Regex-LE Logo" width="96" height="96"/>
</p>
<h1 align="center">Regex-LE: Zero Hassle Regex Extraction & Validation</h1>
<p align="center">
  <b>Find, test, and validate the regex patterns in the current file</b><br/>
  <i>Literal patterns, RegExp constructors, ReDoS screening</i>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=nolindnaidoo.regex-le">
    <img src="https://img.shields.io/badge/Install%20from-VS%20Code-blue?style=for-the-badge&logo=visualstudiocode" alt="Install from VS Code Marketplace" />
  </a>
  <a href="https://letools.dev">
    <img src="https://img.shields.io/badge/LE%20Tools-letools.dev-blue?style=for-the-badge" alt="LE Tools" />
  </a>
</p>

---

<p align="center">
  <img src="src/assets/images/demo.gif" alt="Regex-LE Demo" style="max-width: 100%; height: auto;" />
</p>

## What it does

Open any file and run one of three commands. **Extract** lists every regex pattern found in the document. **Test** (`Ctrl+Alt+R` / `Cmd+Alt+R`) runs a found — or manually entered — pattern against the file content and reports matches with real line/column positions and capture groups (named groups included). **Validate** checks every found pattern for syntax errors and screens it for ReDoS-prone shapes. Works in VS Code and VS Code–based editors like Cursor and VSCodium (installable from Open VSX).

## What gets extracted

Extraction scans the whole document (any file type), so constructors split across lines are found too:

| Form | Example |
|---|---|
| Literal | `/[a-z]+/gi` |
| Constructor | `new RegExp('\\d{4}-\\d{2}', 'g')` — including multiline |
| Bare constructor call | `RegExp("x\|y", "i")` |

What is deliberately **not** extracted:

- Division, dates, and filesystem paths (`a / b`, `10/29/2025`, `/usr/local/bin`): a `/` preceded by an identifier, number, `)`, `]`, `.`, or another `/` is not treated as a regex — after keywords like `return`, it is.
- Candidates that do not compile as JavaScript regexes, or with invalid/duplicate flags.
- Constructor calls whose pattern argument is a variable or template literal (only literal string arguments are visible to a text scanner).

Duplicate pattern+flags pairs are listed once. This is lexing by heuristic, not a full JS parser: a slash inside a string or comment can still be picked up when its context looks expression-like.

## ReDoS screening

`Validate` (and `Test`, before running a risky pattern) screens for the common catastrophic-backtracking shapes:

- **High severity** — nested unbounded quantifiers: `(a+)+`, `([a-z]+)*`
- **Medium severity** — quantified alternation with overlapping branches: `(a|ab)+`

This is a structural scanner, not an automaton analysis: it cannot prove a pattern safe, only flag the dangerous shapes it recognizes. The reports also include a rough performance score based on execution time relative to input size — treat it as a hint, not a benchmark (memory is not measured).

## Commands

| Command | Description |
|---|---|
| `Regex-LE: Test Regex` (`Ctrl+Alt+R` / `Cmd+Alt+R`) | Test a found or entered pattern against the file |
| `Regex-LE: Extract Patterns` | List every regex pattern found in the document |
| `Regex-LE: Validate Regex` | Syntax + ReDoS report for every found pattern |
| `Regex-LE: Open Settings` | Open Regex-LE settings |
| `Regex-LE: Help & Troubleshooting` | Built-in documentation |

## Settings

| Setting | Default | Description |
|---|---|---|
| `regex-le.openResultsSideBySide` | `true` | Open results beside the current editor |
| `regex-le.copyToClipboardEnabled` | `false` | Also copy results to the clipboard |
| `regex-le.notificationsLevel` | `silent` | `all` = every notification, `important` = warnings + errors, `silent` = errors only |
| `regex-le.safety.enabled` | `true` | Guardrails for very large files and outputs |
| `regex-le.safety.fileSizeWarnBytes` | `1000000` | Refuse processing above this file size |
| `regex-le.safety.largeOutputLinesThreshold` | `50000` | Refuse result documents above this line count |
| `regex-le.statusBar.enabled` | `true` | Show the status bar item |
| `regex-le.telemetryEnabled` | `false` | Local-only event log (see Privacy) |
| `regex-le.regex.redosDetectionEnabled` | `true` | ReDoS screening in Test/Validate |
| `regex-le.regex.maxMatchLimit` | `1000` | Cap on matches collected per test (10–10000) |

## Privacy & security

- **No network access.** The extension never sends data anywhere. The `telemetryEnabled` setting only writes events to a local Output Channel you can inspect (`Regex-LE Telemetry`).
- Testing a pattern the ReDoS screen rates high-severity asks for confirmation first.
- Error notifications redact home directories and credential-shaped fragments.

## Development

```bash
bun install
bun run build            # esbuild bundle -> dist/extension.js
bun run typecheck        # tsc --noEmit (includes tests)
bun run test             # vitest unit suite
bun run test:integration # real VS Code extension host
bun run lint             # biome
bun run package          # VSIX into release/
```

Architecture and conventions live in [AGENTS.md](AGENTS.md). Changes are tracked in [CHANGELOG.md](CHANGELOG.md).

## Performance

<!-- performance:start -->
| Input | Size | Found | Time | Rate | Scan speed |
| --- | --- | --- | --- | --- | --- |
| JS with literals | 1.12 MB | 25,000 | 44.19 ms | 565,679/sec | 25.4 MB/s |
| JS with constructors | 1.27 MB | 25,000 | 41.86 ms | 597,268/sec | 30.3 MB/s |
| Source without regexes | 1.24 MB | 0 | 18.75 ms | — | 66 MB/s |

Median of 7 runs after warmup, on Apple M5 Pro, 24 GB RAM, Node 24.3.0. Inputs are generated
by `scripts/benchmark.ts` rather than checked in, so the sizes above are
exactly what was measured. Reproduce with `bun run benchmark`.

These are machine-specific and are not asserted in CI — a benchmark that gates
a build only tells you how busy the runner was.
<!-- performance:end -->

## Testing

<!-- coverage:start -->
| Metric | Coverage |
| --- | --- |
| Statements | 87.95% |
| Branches | 71.39% |
| Functions | 92.22% |
| Lines | 88.19% |

83 test cases across 10 files, plus an integration suite that runs
in a real VS Code extension host and an end-to-end test that installs the
built `.vsix` into a clean profile.

Generated from `coverage/coverage-summary.json` by
`scripts/coverage-readme.js`; CI fails if this section drifts from a fresh
run. Reproduce with `bun run test:coverage`.
<!-- coverage:end -->

## More from the LE Family

Every tool in the family, one page: **[letools.dev](https://letools.dev)**

- **[String-LE](https://marketplace.visualstudio.com/items?itemName=nolindnaidoo.string-le)** - Extract string values for i18n from JSON, YAML, CSV, TOML, INI, and .env
- **[Numbers-LE](https://marketplace.visualstudio.com/items?itemName=nolindnaidoo.numbers-le)** - Extract numeric values from JSON, YAML, CSV, TOML, INI, and .env
- **[EnvSync-LE](https://marketplace.visualstudio.com/items?itemName=nolindnaidoo.envsync-le)** - Spot missing keys across your .env files, with a markdown report
- **[Paths-LE](https://marketplace.visualstudio.com/items?itemName=nolindnaidoo.paths-le)** - Extract file paths from JS/TS imports, JSON, HTML, CSS, TOML, CSV, and .env
- **[Secrets-LE](https://marketplace.visualstudio.com/items?itemName=nolindnaidoo.secrets-le)** - Detect and sanitize credentials locally, before you commit
- **[Scrape-LE](https://marketplace.visualstudio.com/items?itemName=nolindnaidoo.scrape-le)** - Check whether a page is scrapeable before you write the scraper
- **[Colors-LE](https://marketplace.visualstudio.com/items?itemName=nolindnaidoo.colors-le)** - Extract and analyze colors from CSS, SCSS, LESS, Stylus, HTML, JS/TS, and SVG
- **[URLs-LE](https://marketplace.visualstudio.com/items?itemName=nolindnaidoo.urls-le)** - Extract URLs from documentation, configs, and code
- **[Dates-LE](https://marketplace.visualstudio.com/items?itemName=nolindnaidoo.dates-le)** - Extract and analyze dates from logs, configs, and code

## License

MIT © [nolindnaidoo](https://github.com/nolindnaidoo)
