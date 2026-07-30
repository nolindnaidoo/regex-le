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
