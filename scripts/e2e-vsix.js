#!/usr/bin/env node
/**
 * Installed-VSIX end-to-end test: installs release/<name>-<version>.vsix
 * into a CLEAN VS Code profile (fresh extensions + user-data dirs) and
 * drives it as a real installed extension — the exact artifact users
 * get, not the dev folder.
 *
 * Usage: npm run package && node scripts/e2e-vsix.js
 *
 * Note: the profile dirs must be SHORT paths — macOS caps the
 * user-data-dir socket path (~103 chars); deep temp dirs fail with a
 * cryptic `claimInstance` error at startup.
 */
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
	downloadAndUnzipVSCode,
	resolveCliArgsFromVSCodeExecutablePath,
	runTests,
} = require('@vscode/test-electron');

const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const extensionId = `${manifest.publisher}.${manifest.name}`;
const vsixPath = path.resolve(
	'release',
	`${manifest.name}-${manifest.version}.vsix`,
);

if (!fs.existsSync(vsixPath)) {
	console.error(`FAIL: ${vsixPath} not found — run \`npm run package\` first`);
	process.exit(1);
}

const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vsix-e2e-'));
const extensionsDir = path.join(profileRoot, 'ext');
const userDataDir = path.join(profileRoot, 'usr');

// Probe extension: a no-op dev extension whose test suite exercises the
// INSTALLED extension under test.
const probeDir = path.join(profileRoot, 'probe');
fs.mkdirSync(probeDir, { recursive: true });
fs.writeFileSync(
	path.join(probeDir, 'package.json'),
	JSON.stringify({
		name: 'vsix-e2e-probe',
		publisher: 'local',
		version: '0.0.1',
		engines: { vscode: manifest.engines.vscode },
		main: './extension.js',
	}),
);
fs.writeFileSync(
	path.join(probeDir, 'extension.js'),
	'module.exports = { activate() {}, deactivate() {} };\n',
);
fs.writeFileSync(
	path.join(probeDir, 'suite.js'),
	`const vscode = require('vscode');
const assert = require('assert');
exports.run = async function run() {
	const ext = vscode.extensions.getExtension(${JSON.stringify(extensionId)});
	assert.ok(ext, 'installed ${extensionId} not found');
	await ext.activate();
	assert.strictEqual(ext.isActive, true, 'extension failed to activate');

	// Smoke the primary command end to end.
	const doc = await vscode.workspace.openTextDocument({
		content: [
			'const digits = /\\\\d+/g;',
			'const ctor = new RegExp(',
			"\\t'[a-z]+',",
			"\\t'i',",
			');',
			'const ratio = a / b / c;',
		].join('\\n'),
		language: 'javascript',
	});
	await vscode.window.showTextDocument(doc);
	await vscode.commands.executeCommand('regex-le.extract');
	const result = vscode.workspace.textDocuments.find(
		(d) => d.languageId === 'plaintext' && d.getText().includes('/\\\\d+/g'),
	);
	assert.ok(result, 'no results document produced');
	assert.deepStrictEqual(result.getText().split('\\n'), ['/\\\\d+/g', '/[a-z]+/i']);
	console.log('VSIX E2E OK:', JSON.stringify(result.getText().split('\\n')));
	// --- the MCP server, as it ships ------------------------------------
	// check:mcp-bundle proves dist/mcp-server.js works before packaging. This
	// proves the packaged VSIX still carries it and that it starts the exact
	// way provider.ts starts it — the two things .vscodeignore and
	// ELECTRON_RUN_AS_NODE can each break with no visible error.
	const fs = require('fs');
	const path = require('path');
	const cp = require('child_process');

	const serverPath = path.join(ext.extensionPath, 'dist', 'mcp-server.js');
	assert.ok(
		fs.existsSync(serverPath),
		'dist/mcp-server.js is missing from the installed VSIX — check .vscodeignore',
	);

	const declared = (
		ext.packageJSON.contributes.mcpServerDefinitionProviders || []
	).map((p) => p.id);
	assert.deepStrictEqual(
		declared,
		['regex-le'],
		'the manifest must declare the provider id the extension registers',
	);

	// process.execPath here is the editor binary, exactly as it is in the
	// extension host. Launching without ELECTRON_RUN_AS_NODE starts a second
	// editor window instead of a server, and the failure is silent.
	const server = cp.spawn(process.execPath, [serverPath], {
		env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
		stdio: 'pipe',
	});

	const tools = await new Promise((resolve, reject) => {
		let buffer = '';
		const timer = setTimeout(
			() => reject(new Error('the MCP server did not answer within 10s')),
			10000,
		);
		server.on('error', reject);
		server.stdout.on('data', (chunk) => {
			buffer += chunk;
			for (const line of buffer.split('\\n')) {
				if (!line.trim()) continue;
				let message;
				try {
					message = JSON.parse(line);
				} catch {
					continue; // a partial line; wait for the rest
				}
				if (message.id !== 2) continue;
				clearTimeout(timer);
				resolve((message.result.tools || []).map((t) => t.name));
			}
		});
		const send = (m) => server.stdin.write(JSON.stringify(m) + '\\n');
		send({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'vsix-e2e', version: '1.0.0' } },
		});
		send({ jsonrpc: '2.0', method: 'notifications/initialized' });
		send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
	}).finally(() => server.kill());

	assert.deepStrictEqual(
		tools,
		['extract_patterns'],
		'the installed MCP server did not advertise its tools',
	);
	console.log('VSIX MCP OK:', JSON.stringify(tools));

	assert.strictEqual(
		typeof vscode.lm.registerMcpServerDefinitionProvider,
		'function',
		'this VS Code build predates the MCP provider API — engines.vscode floor is wrong',
	);
};
`,
);

(async () => {
	const vscodeExecutablePath = await downloadAndUnzipVSCode('stable');
	const [cli, ...args] =
		resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);

	cp.execFileSync(
		cli,
		[
			...args,
			'--extensions-dir',
			extensionsDir,
			'--user-data-dir',
			userDataDir,
			'--install-extension',
			vsixPath,
		],
		{ stdio: 'inherit' },
	);

	await runTests({
		vscodeExecutablePath,
		extensionDevelopmentPath: probeDir,
		extensionTestsPath: path.join(probeDir, 'suite.js'),
		launchArgs: ['--extensions-dir', extensionsDir, '--user-data-dir', userDataDir],
	});
	console.log(`INSTALLED-VSIX TEST: PASS (${path.basename(vsixPath)})`);
})()
	.catch((error) => {
		console.error('INSTALLED-VSIX TEST: FAIL', error);
		process.exitCode = 1;
	})
	.finally(() => {
		fs.rmSync(profileRoot, { recursive: true, force: true });
	});
