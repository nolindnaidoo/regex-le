import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	_clipboardText,
	_openedDocuments,
	_registeredCommands,
	_resetMockState,
	_respondToOpenDialog,
	_setConfig,
	_setWorkspaceFiles,
	_shownMessages,
	Uri,
	workspace,
} from '../__mocks__/vscode';
import { createTelemetry } from '../telemetry/telemetry';
import { createNotifier } from '../ui/notifier';
import { createStatusBar } from '../ui/statusBar';
import { registerExtractWorkspaceCommands } from './extractWorkspace';

const TREE = {
	'/w/src/a.ts': 'const d = /\\d+/g;\nconst e = /^x$/;\n',
	'/w/src/b.ts': 'const d = /\\d+/g;\n',
	// The same digits, and a different pattern: no flags.
	'/w/src/c.py': 'import re\nd = re.compile(r"\\d+")\n',
	'/w/README.md': 'See /not/a/pattern/ here.\n',
	'/w/node_modules/dep.js': 'const d = /\\d+/g;\n',
};

async function runCommand(id: string, ...args: unknown[]): Promise<void> {
	const handler = _registeredCommands().get(id);
	if (!handler) throw new Error(`command not registered: ${id}`);
	await handler(...args);
}

function report(): string {
	const last = _openedDocuments().at(-1);
	if (!last) throw new Error('no report was opened');
	return last.getText();
}

function open(files: Record<string, string> = TREE): void {
	_setWorkspaceFiles(files);
	workspace.workspaceFolders = [{ uri: Uri.file('/w'), name: 'w', index: 0 }];
}

beforeEach(() => {
	_resetMockState();
	const context = { subscriptions: [] as Array<{ dispose(): void }> } as never;
	registerExtractWorkspaceCommands(context, {
		telemetry: createTelemetry(),
		notifier: createNotifier(),
		statusBar: createStatusBar(context),
	});
});

describe('regex-le.extractWorkspace and regex-le.extractFolder', () => {
	it('warns when no workspace is open', async () => {
		_setConfig('regex-le.notificationsLevel', 'all');
		await runCommand('regex-le.extractWorkspace');
		expect(_shownMessages()[0]).toMatchObject({ kind: 'warning' });
		expect(_openedDocuments()).toHaveLength(0);
	});

	it('lists each distinct pattern once, the most widely used first, with every file that holds it', async () => {
		open();
		await runCommand('regex-le.extractWorkspace');

		const text = report();
		expect(text).toContain(
			'3 file(s) read · 3 distinct pattern(s) in 3 file(s)',
		);
		const table = text.split('\n').filter((line) => line.startsWith('| `'));
		expect(table).toEqual([
			'| `/\\d+/g` | 2 |',
			'| `/\\d+/` | 1 |',
			'| `/^x$/` | 1 |',
		]);
		expect(text.match(/^## .*$/gm)).toEqual([
			'## `/\\d+/g` (2)',
			'## `/\\d+/` (1)',
			'## `/^x$/` (1)',
		]);
		expect(text).toContain(
			'- `/w/src/a.ts` · **1:11**\n- `/w/src/b.ts` · **1:11**',
		);
		expect(text).toMatch(/^- `\/w\/src\/c\.py` · \*\*2:\d+\*\*$/m);
		// A README is not source, and node_modules is on the built-in list.
		expect(text).not.toContain('README');
		expect(text).not.toContain('node_modules');
	});

	it('scans only the folder it is handed, and names files relative to it', async () => {
		open({ ...TREE, '/w/lib/d.ts': 'const z = /z+/;\n' });
		await runCommand('regex-le.extractFolder', Uri.file('/w/lib'));

		expect(report()).toContain(
			'`/w/lib` · 1 file(s) read · 1 distinct pattern(s) in 1 file(s)',
		);
		expect(report()).toContain('- `d.ts` · **1:11**');
	});

	it('asks for a folder from the palette, and does nothing when none is picked', async () => {
		open();
		_respondToOpenDialog(() => undefined);
		await runCommand('regex-le.extractFolder');
		expect(_openedDocuments()).toHaveLength(0);

		_respondToOpenDialog(() => [Uri.file('/w/src')]);
		await runCommand('regex-le.extractFolder');
		expect(report()).toContain('`/w/src` · 3 file(s) read');
	});

	it('stops at the results limit and says the rest was not read', async () => {
		open();
		_setConfig('regex-le.workspace.scanMaxResults', 2);
		await runCommand('regex-le.extractWorkspace');

		// a.ts holds two, which is the limit: b.ts and c.py are never read.
		expect(report()).toContain(
			'1 file(s) read · 2 distinct pattern(s) in 1 file(s)',
		);
		expect(report()).toContain(
			'> The results limit was reached. The rest of the files were not read.',
		);
	});

	it('honours the positions settings, on screen and in the copy separately', async () => {
		open();
		_setConfig('regex-le.copyToClipboardEnabled', true);
		_setConfig('regex-le.showPositions', false);
		await runCommand('regex-le.extractWorkspace');

		expect(report()).not.toMatch(/\*\*\d+:\d+\*\*/);
		expect(report()).toContain('- `/w/src/a.ts`\n- `/w/src/b.ts`');
		// The clipboard has its own setting, and that one is still on.
		expect(_clipboardText()).toContain('- `/w/src/a.ts` · **1:11**');
	});

	it('says when a folder holds no patterns', async () => {
		open({ '/w/src/a.ts': 'const n = 1;\n' });
		await runCommand('regex-le.extractWorkspace');
		expect(report()).toContain('No patterns found.');
	});

	it('prints the report the README shows as its sample', async () => {
		open();
		await runCommand('regex-le.extractFolder', Uri.file('/w'));

		const readme = readFileSync(
			join(__dirname, '..', '..', 'README.md'),
			'utf8',
		);
		const shown = report()
			.split('\n')
			.filter(
				(line) =>
					line.startsWith('- ') ||
					line.startsWith('| `') ||
					line.startsWith('## '),
			);
		expect(shown).toHaveLength(10);
		for (const line of shown) expect(readme).toContain(line);
		expect(readme).toContain(
			'3 file(s) read · 3 distinct pattern(s) in 3 file(s)',
		);
	});
});
