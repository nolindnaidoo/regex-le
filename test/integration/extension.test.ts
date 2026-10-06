import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'nolindnaidoo.regex-le';

async function openEditor(
	content: string,
	language: string,
): Promise<vscode.TextEditor> {
	const document = await vscode.workspace.openTextDocument({
		content,
		language,
	});
	return vscode.window.showTextDocument(document);
}

describe('Regex-LE integration', function () {
	this.timeout(30_000);

	it('activates', async () => {
		const extension = vscode.extensions.getExtension(EXTENSION_ID);
		assert.ok(extension, `extension ${EXTENSION_ID} not found`);
		await extension.activate();
		assert.strictEqual(extension.isActive, true);
	});

	it('registers every declared command', async () => {
		const extension = vscode.extensions.getExtension(EXTENSION_ID);
		await extension?.activate();
		const commands = await vscode.commands.getCommands(true);
		for (const id of [
			'regex-le.test',
			'regex-le.extract',
			'regex-le.validate',
			'regex-le.validateWorkspace',
			'regex-le.validateFolder',
			'regex-le.openSettings',
			'regex-le.help',
		]) {
			assert.ok(commands.includes(id), `missing command: ${id}`);
		}
	});

	it('extracts regex patterns from a JavaScript document into a results document', async () => {
		await openEditor(
			[
				'const digits = /\\d+/g;',
				'const ctor = new RegExp(',
				"\t'[a-z]+',",
				"\t'i',",
				');',
				'const ratio = a / b / c;',
			].join('\n'),
			'javascript',
		);

		await vscode.commands.executeCommand('regex-le.extract');

		// Results open in a new plaintext document (side-by-side default).
		const resultDoc = vscode.workspace.textDocuments.find(
			(doc) =>
				doc.languageId === 'plaintext' && doc.getText().includes('/\\d+/g'),
		);
		assert.ok(resultDoc, 'no results document found');
		const lines = resultDoc.getText().split('\n');
		// Each pattern leads with where it is, a tab, then the pattern: the
		// default for this extension, as Test and Validate give the line.
		assert.strictEqual(lines[0], '1:16\t/\\d+/g');
		assert.match(lines[1] ?? '', /^[23]:\d+\t\/\[a-z\]\+\/i$/);
		assert.deepStrictEqual(
			lines.map((line) => line.replace(/^\d+:\d+\t/, '')),
			['/\\d+/g', '/[a-z]+/i'],
		);
	});

	it('offers its MCP server to agent mode', async () => {
		// The provider is registered against the id the manifest declares; a
		// mismatch leaves the tools invisible with nothing logged. Assert the
		// declaration and the API the floor was raised for, together — the
		// registration itself is only observable in a real host, which
		// scripts/e2e-vsix.js covers against the installed VSIX.
		const extension = vscode.extensions.getExtension(EXTENSION_ID);
		await extension?.activate();

		assert.strictEqual(
			typeof vscode.lm.registerMcpServerDefinitionProvider,
			'function',
			'this VS Code build predates the MCP provider API',
		);

		const providers = extension?.packageJSON.contributes
			.mcpServerDefinitionProviders as { id: string; label: string }[];
		assert.deepStrictEqual(
			providers.map((p) => p.id),
			['regex-le'],
		);
	});

	it('validate produces a markdown report for the patterns in the file', async () => {
		await openEditor('const evil = /(a+)+b/;', 'javascript');

		await vscode.commands.executeCommand('regex-le.validate');

		const report = vscode.workspace.textDocuments.find(
			(doc) =>
				doc.languageId === 'markdown' &&
				doc.getText().includes('# Regex Validation Results'),
		);
		assert.ok(report, 'no validation report found');
		assert.ok(
			report.getText().includes('ReDoS'),
			'report should mention ReDoS for (a+)+b',
		);
	});
	it('validates a folder from disk: counts per file, lists what can hang, skips what it should', async () => {
		const root = mkdtempSync(join(tmpdir(), 'regex-le-scan-'));
		for (const dir of ['src', 'node_modules', 'generated']) mkdirSync(join(root, dir));
		writeFileSync(join(root, '.gitignore'), 'generated/\n');
		writeFileSync(join(root, 'src', 'a.ts'), 'const ok = /\\d+/g;\nconst slow = /(a+)+$/;\n');
		writeFileSync(join(root, 'src', 'b.py'), 'import re\nyear = re.compile(r"(?P<year>\\d{4})")\nsame = re.compile(r"(a+)\\1")\n');
		writeFileSync(join(root, 'node_modules', 'dep.js'), 'const slow = /(a+)+$/;\n');
		writeFileSync(join(root, 'generated', 'g.ts'), 'const slow = /(a+)+$/;\n');
		writeFileSync(join(root, 'README.md'), 'See /not/a/pattern/ here.\n');
		const settings = vscode.workspace.getConfiguration('regex-le');
		await settings.update('workspace.scanProblemsEnabled', true, vscode.ConfigurationTarget.Global);

		// As the Explorer calls it: with the folder that was clicked.
		await vscode.commands.executeCommand('regex-le.validateFolder', vscode.Uri.file(root));
		await settings.update('workspace.scanProblemsEnabled', undefined, vscode.ConfigurationTarget.Global);

		const report = vscode.workspace.textDocuments.find(
			(doc) => doc.languageId === 'markdown' && doc.getText().includes('regex-le-scan-'),
		);
		assert.ok(report, 'no workspace report was opened');
		const text = report.getText();
		assert.match(text, /2 file\(s\) read · 4 pattern\(s\), 1 can hang, 1 not checked/);
		assert.match(text, /\| `src\/a\.ts` \| 2 \| 1 \| 0 \|/);
		assert.match(text, /\| `src\/b\.py` \| 2 \| 0 \| 1 \|/);
		assert.deepStrictEqual(text.match(/^## .*$/gm), ['## `src/a.ts` (1)']);
		assert.ok(!text.includes('node_modules') && !text.includes('generated/') && !text.includes('README'));
		assert.match(text, /1 file\(s\) ignored by \.gitignore/);

		const problems = vscode.languages
			.getDiagnostics()
			.filter(([, list]) => list.some((d) => d.source === 'regex-le'));
		assert.strictEqual(problems.length, 1);
		const [uri, list] = problems[0] as [vscode.Uri, vscode.Diagnostic[]];
		assert.ok(uri.path.endsWith('/src/a.ts'));
		assert.strictEqual(list[0]?.range.start.line, 1);
		assert.strictEqual(list[0]?.range.start.character, 13);
	});
});
