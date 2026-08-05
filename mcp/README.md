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
carries this server and registers it for you.

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

## Licence

MIT
