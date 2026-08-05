#!/usr/bin/env node
/**
 * MCP bundle gate.
 *
 * The extension bundle has `check-bundle.js`; this is its counterpart for
 * `dist/mcp-server.js`, and it asserts three things nothing else can:
 *
 * 1. **Self-contained, and free of `vscode`.** The server runs outside the
 *    editor — in Zed, in Claude Code, from `npx`. A stray `vscode` import would
 *    only fail there, in a user's session.
 * 2. **It actually speaks MCP.** A real stdio handshake against the built file.
 *    A source-level test would have missed the jsonc-parser UMD bug that
 *    `check-bundle.js` exists for; the same class of bug applies here.
 * 3. **It stays small.** The SDK was rejected at 5.9 MB for a repo whose
 *    extension bundle is 66 KB. Without a ceiling that decision quietly rots.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const bundlePath = path.resolve('dist/mcp-server.js');
const SIZE_CEILING_BYTES = 600 * 1024;

function fail(message, detail) {
	console.error(`\n  ✗ ${message}`);
	if (detail) console.error(`    ${detail}`);
	process.exit(1);
}

if (!fs.existsSync(bundlePath)) {
	fail('dist/mcp-server.js is missing', 'run `bun run build:mcp` first');
}

const source = fs.readFileSync(bundlePath, 'utf8');

// --- 1. static scan -------------------------------------------------
const offenders = new Set();
for (const match of source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
	const specifier = match[1];
	if (Module.isBuiltin(specifier)) continue;
	offenders.add(specifier);
}
if (offenders.size > 0) {
	fail(
		'the MCP bundle is not self-contained',
		`requires: ${[...offenders].join(', ')}`,
	);
}
if (/\brequire\(\s*["']vscode["']\s*\)/.test(source)) {
	fail('the MCP bundle references `vscode`', 'it must run outside the editor');
}

// --- 2. size ---------------------------------------------------------
const size = fs.statSync(bundlePath).size;
if (size > SIZE_CEILING_BYTES) {
	fail(
		`the MCP bundle is ${Math.round(size / 1024)} KB, over the ${SIZE_CEILING_BYTES / 1024} KB ceiling`,
		'a dependency has grown; re-measure before raising this',
	);
}

// --- 3. protocol handshake ------------------------------------------
const proc = spawn(process.execPath, [bundlePath], { stdio: 'pipe' });
const replies = [];
let buffer = '';
let stderr = '';

proc.stderr.on('data', (d) => {
	stderr += d;
});
proc.stdout.on('data', (chunk) => {
	buffer += chunk;
	let newline = buffer.indexOf('\n');
	while (newline !== -1) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		newline = buffer.indexOf('\n');
		if (line) replies.push(JSON.parse(line));
	}
});

const send = (message) => proc.stdin.write(`${JSON.stringify(message)}\n`);
const byId = (id) => replies.find((r) => r.id === id);

send({
	jsonrpc: '2.0',
	id: 1,
	method: 'initialize',
	params: {
		protocolVersion: '2025-06-18',
		capabilities: {},
		clientInfo: { name: 'check-mcp-bundle', version: '1.0.0' },
	},
});
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
send({
	jsonrpc: '2.0',
	id: 3,
	method: 'tools/call',
	params: {
		name: 'extract_patterns',
		arguments: {
			content: 'const re = /^(a+)+$/gi; const ok = /\\d{3}-\\d{4}/;',
		},
	},
});

setTimeout(() => {
	proc.stdin.end();

	const init = byId(1)?.result;
	if (init?.serverInfo?.name !== 'regex-le') {
		fail('initialize did not identify the server', JSON.stringify(init));
	}
	if (!init?.serverInfo?.version || init.serverInfo.version === '0.0.0-dev') {
		fail(
			'the server version was not injected at build time',
			`got: ${init?.serverInfo?.version}`,
		);
	}
	if (!init?.capabilities?.tools) {
		fail('the server did not advertise tool support');
	}

	const names = byId(2)?.result?.tools?.map((t) => t.name) ?? [];
	if (names.length === 0) fail('tools/list returned nothing');

	const call = byId(3)?.result;
	if (call?.isError !== false) {
		fail('extract_patterns reported an error', JSON.stringify(call));
	}
	const found = call?.structuredContent?.data?.patterns?.map((item) => item.pattern) ?? [];
	// Asserting the actual values, not just "it responded" — a server that
	// answers with an empty list would otherwise pass.
	for (const expected of ['^(a+)+$', '\\d{3}-\\d{4}']) {
		if (!found.includes(expected)) {
			fail(
				`extract_patterns did not find ${expected}`,
				`got: ${found.join(', ')}`,
			);
		}
	}

	// The ReDoS verdict is the reason this tool exists rather than a plain
	// pattern list, so a response without one is a failure.
	const catastrophic = call?.structuredContent?.data?.patterns?.find(
		(p) => p.pattern === '^(a+)+$',
	);
	if (catastrophic?.redos?.detected !== true) {
		fail(
			'extract_patterns did not flag a known catastrophic pattern',
			JSON.stringify(catastrophic),
		);
	}

	if (stderr.trim()) {
		fail('the server wrote to stderr', stderr.trim().split('\n')[0]);
	}

	console.log(
		`OK: dist/mcp-server.js is self-contained, ${Math.round(size / 1024)} KB, and answered ${names.length} tool(s) over stdio.`,
	);
	process.exit(0);
}, 1500);
