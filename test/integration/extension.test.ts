import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'OffensiveEdge.regex-le';

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
		assert.deepStrictEqual(lines, ['/\\d+/g', '/[a-z]+/i']);
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
});
