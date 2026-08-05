# regex-le-mcp

An [MCP](https://modelcontextprotocol.io) server that extracts URLs from
documentation, configuration and code — the extraction engine behind the
[Regex-LE](https://marketplace.visualstudio.com/items?itemName=nolindnaidoo.regex-le)
editor extension, exposed as a tool an agent can call.

No dependencies, no network calls, no filesystem access. Content goes in,
structured results come out.

## Use it

Point any MCP host at `npx regex-le-mcp`.

**Claude Code**

```bash
claude mcp add regex-le -- npx -y regex-le-mcp
```

**Anything with a JSON config** — Cursor, Windsurf, Claude Desktop:

```json
{
  "mcpServers": {
    "regex-le": {
      "command": "npx",
      "args": ["-y", "regex-le-mcp"]
    }
  }
}
```

**VS Code and Zed** need nothing here. Install the extension instead — it
carries this server and registers it for you:
[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nolindnaidoo.regex-le)
· [Open VSX](https://open-vsx.org/extension/OffensiveEdge/regex-le)
· [Zed](https://github.com/zed-industries/extensions/pull/7083) *(pending review)*

Prefer a global install to `npx` on every launch:

```bash
npm install -g regex-le-mcp
```

```json
{
  "mcpServers": {
    "regex-le": { "command": "regex-le-mcp" }
  }
}
```

No environment variables, no API key, no configuration of its own. To check it
before wiring it into anything:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | npx -y regex-le-mcp
```

If that prints the tool name, the server works.

## The tool

### `extract_patterns`

| argument | type | |
|---|---|---|
| `content` | string | **required.** The text to scan. |
| `format` | string | The language: `markdown`, `yaml`, `json`, `typescript`… Required unless `filename` is given. |
| `filename` | string | Used to infer `format` when it is absent — `README.md` resolves to `markdown`. |
| `dedupe` | boolean | Collapse repeats. Default `false`. |
| `maxResults` | number | Default `500`, ceiling `5000`. |

Returns each URL with its protocol and 1-based line and column, plus
`meta.truncated` so a capped result is never mistaken for a complete one.

```json
{
  "ok": true,
  "data": {
    "patterns": [
      { "value": "https://example.com/guide", "protocol": "https", "line": 2, "column": 15 }
    ]
  },
  "meta": { "count": 1, "truncated": false }
}
```

Extraction is heuristic, and what it deliberately does **not** match is
documented as carefully as what it does — see the
[extension README](https://github.com/nolindnaidoo/regex-le#readme).

## Also in the MCP registry

`io.github.nolindnaidoo/regex-le` —
[registry.modelcontextprotocol.io](https://registry.modelcontextprotocol.io)

## Nine more like it

One tool each, same shape: content in, structured data out, no network and no
filesystem. Every one is on npm as `<name>-mcp` and in the MCP registry as
`io.github.nolindnaidoo/<name>`.

| Package | Tool | Extracts |
|---|---|---|
| [`urls-le-mcp`](https://www.npmjs.com/package/urls-le-mcp) | `extract_urls` | URLs, with protocol and position |
| [`colors-le-mcp`](https://www.npmjs.com/package/colors-le-mcp) | `extract_colors` | colors from stylesheets and code |
| [`dates-le-mcp`](https://www.npmjs.com/package/dates-le-mcp) | `extract_dates` | dates and timestamps |
| [`paths-le-mcp`](https://www.npmjs.com/package/paths-le-mcp) | `extract_paths` | file and directory paths |
| [`numbers-le-mcp`](https://www.npmjs.com/package/numbers-le-mcp) | `extract_numbers` | numeric values |
| [`string-le-mcp`](https://www.npmjs.com/package/string-le-mcp) | `extract_strings` | string values |
| [`secrets-le-mcp`](https://www.npmjs.com/package/secrets-le-mcp) | `detect_secrets` | credentials, masked — never the value |
| [`envsync-le-mcp`](https://www.npmjs.com/package/envsync-le-mcp) | `compare_env_files` | dotenv key drift, names only |
| [`scrape-le-mcp`](https://www.npmjs.com/package/scrape-le-mcp) | `analyze_robots_txt` | whether a path may be crawled |

Every tool in the family, one page: **[letools.dev](https://letools.dev)**

## Licence

MIT © [nolindnaidoo](https://github.com/nolindnaidoo)
