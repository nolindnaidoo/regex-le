#!/usr/bin/env node
/**
 * npm package gate.
 *
 * Packs `mcp/`, installs the tarball into a clean throwaway project, and runs
 * the *installed* binary through a real MCP handshake. That is what
 * `npx regex-le-mcp` does, minus the registry — so it catches the failures a
 * source-level test cannot: a missing `files` entry, a bin path that does not
 * resolve, a lost shebang, or an executable bit npm never set.
 *
 * Runs before publishing, because an unpublish window is 72 hours and a broken
 * version number can never be reused.
 *
 *   node scripts/build-npm.js && node scripts/check-npm-package.js
 */
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const manifest = JSON.parse(fs.readFileSync('mcp/package.json', 'utf8'));
const binName = Object.keys(manifest.bin)[0];
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-check-'));

function fail(message, detail) {
	console.error(`\n  ✗ ${message}`);
	if (detail) console.error(`    ${detail}`);
	fs.rmSync(workspace, { recursive: true, force: true });
	process.exit(1);
}

const run = (args, cwd) =>
	cp.execFileSync('npm', args, { cwd, encoding: 'utf8', stdio: 'pipe' });

// --- pack -------------------------------------------------------------
const packed = JSON.parse(
	run(['pack', path.resolve('mcp'), '--json', '--pack-destination', workspace]),
)[0];

const shipped = packed.files.map((f) => f.path).sort();
const expected = ['LICENSE', 'README.md', 'package.json', 'server.js'];
if (JSON.stringify(shipped) !== JSON.stringify(expected)) {
	fail(
		'the tarball does not carry exactly the expected files',
		`got: ${shipped.join(', ')}`,
	);
}

// The registry reads mcpName out of the *published* package, so a missing one
// is only discovered after the version is spent and cannot be republished.
if (!manifest.mcpName) {
	fail(
		'mcp/package.json has no mcpName',
		'the MCP registry verifies ownership by reading it from the published package',
	);
}

// --- install into a clean project -------------------------------------
const project = path.join(workspace, 'project');
fs.mkdirSync(project);
fs.writeFileSync(
	path.join(project, 'package.json'),
	JSON.stringify({ name: 'npm-check', version: '1.0.0', private: true }),
);
run(
	['install', path.join(workspace, packed.filename), '--no-audit', '--no-fund'],
	project,
);

const binPath = path.join(project, 'node_modules', '.bin', binName);
if (!fs.existsSync(binPath)) {
	fail(`npm did not install a \`${binName}\` binary`, 'check the bin field');
}

// --- handshake against the installed binary ---------------------------
// Spawned through the shim itself, not `node server.js`, so the shebang and
// the executable bit are part of what is being tested.
const server = cp.spawn(binPath, [], { stdio: 'pipe' });
const replies = [];
let buffer = '';
let stderr = '';

server.on('error', (error) => fail('the installed binary would not start', error.message));
server.stderr.on('data', (d) => {
	stderr += d;
});
server.stdout.on('data', (chunk) => {
	buffer += chunk;
	let newline = buffer.indexOf('\n');
	while (newline !== -1) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		newline = buffer.indexOf('\n');
		if (line) replies.push(JSON.parse(line));
	}
});

const send = (message) => server.stdin.write(`${JSON.stringify(message)}\n`);
const byId = (id) => replies.find((r) => r.id === id);

send({
	jsonrpc: '2.0',
	id: 1,
	method: 'initialize',
	params: {
		protocolVersion: '2025-06-18',
		capabilities: {},
		clientInfo: { name: 'check-npm-package', version: '1.0.0' },
	},
});
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({
	jsonrpc: '2.0',
	id: 2,
	method: 'tools/call',
	params: {
		name: 'extract_patterns',
		arguments: {
			content: 'const re = /^(a+)+$/gi; const ok = /\\d{3}-\\d{4}/;',
		},
	},
});

setTimeout(() => {
	server.stdin.end();

	const info = byId(1)?.result?.serverInfo;
	if (info?.version !== manifest.version) {
		fail(
			'the installed server reports a different version than the package',
			`package ${manifest.version}, server ${info?.version}`,
		);
	}

	const call = byId(2)?.result;
	const found = call?.structuredContent?.data?.patterns?.map((item) => item.pattern) ?? [];
	if (!found.includes('^(a+)+$')) {
		fail(
			'the installed server did not extract a known pattern',
			`got: ${found.join(', ')}`,
		);
	}

	if (stderr.trim()) {
		fail('the server wrote to stderr', stderr.trim().split('\n')[0]);
	}

	fs.rmSync(workspace, { recursive: true, force: true });
	console.log(
		`OK: ${manifest.name}@${manifest.version} installs from a tarball and answers over stdio as \`${binName}\`.`,
	);
}, 2000);
