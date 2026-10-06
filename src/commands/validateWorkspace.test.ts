import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	_clipboardText,
	_diagnostics,
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
import { registerValidateWorkspaceCommands } from './validateWorkspace';

const TREE = {
	'/w/src/a.ts': 'const ok = /\\d+/g;\nconst slow = /(a+)+$/;\n',
	// A Python named group, which a JavaScript engine alone cannot compile,
	// and a backreference, which the hang search cannot decide either way.
	'/w/src/b.py':
		'import re\nyear = re.compile(r"(?P<year>\\d{4})")\nsame = re.compile(r"(a+)\\1")\n',
	'/w/src/c.ts': 'const fine = /^x$/;\n',
	'/w/README.md': 'See /not/a/pattern/ here.\n',
	'/w/node_modules/dep.js': 'const slow = /(a+)+$/;\n',
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
	registerValidateWorkspaceCommands(context, {
		telemetry: createTelemetry(),
		notifier: createNotifier(),
		statusBar: createStatusBar(context),
	});
});

describe('regex-le.validateWorkspace and regex-le.validateFolder', () => {
	it('warns when no workspace is open', async () => {
		_setConfig('regex-le.notificationsLevel', 'all');
		await runCommand('regex-le.validateWorkspace');
		expect(_shownMessages()[0]).toMatchObject({ kind: 'warning' });
		expect(_openedDocuments()).toHaveLength(0);
	});

	it('counts every pattern per file and lists the ones that can hang', async () => {
		_setConfig('regex-le.notificationsLevel', 'important');
		open();
		await runCommand('regex-le.validateWorkspace');

		const text = report();
		expect(text).toContain('# Regex-LE workspace report');
		expect(text).toContain(
			'3 file(s) read · 5 pattern(s), 1 can hang, 1 not checked',
		);
		expect(text).toContain('| File | Patterns | Can hang | Not checked |');
		expect(text).toContain('| `/w/src/a.ts` | 2 | 1 | 0 |');
		expect(text).toContain('| `/w/src/b.py` | 2 | 0 | 1 |');
		// A file whose patterns are all sound is counted, not tabled.
		expect(text).not.toContain('`/w/src/c.ts`');
		expect(text).toContain(
			'> 1 other file(s) hold only patterns with no finding.',
		);
		// Only the one that can hang gets a row.
		expect(text.match(/^## .*$/gm)).toEqual(['## `/w/src/a.ts` (1)']);
		expect(text).toMatch(
			/^- \*\*2:14\*\* · `\/\(a\+\)\+\$\/` · can hang \(high\): .* · complexity \d+\/100$/m,
		);
		expect(text).toContain('`regex-le.workspace.scanIncludePassing`');
		// A README is not source, and node_modules is on the built-in list.
		expect(text).not.toContain('README');
		expect(text).not.toContain('node_modules');
		expect(_shownMessages().at(-1)?.message).toBe(
			'1 pattern(s) that can hang in 1 file(s)',
		);
	});

	it('reads a pattern written for another engine, and says not checked only where the search cannot decide', async () => {
		open();
		_setConfig('regex-le.workspace.scanIncludePassing', true);
		await runCommand('regex-le.validateWorkspace');

		const text = report();
		// A Python named group is no syntax error: it is read and searched.
		expect(text).toContain(
			'- **2:8** · `/(?P<year>\\d{4})/` · no finding · complexity',
		);
		// A backreference is where the search has no answer, and says so.
		expect(text).toContain(
			'- **3:8** · `/(a+)\\1/` · not checked: a backreference is not a regular language · complexity',
		);
		expect(text.toLowerCase()).not.toContain('invalid');
		// Listing everything: the sound ones too, and no note about hiding them.
		expect(text.match(/^## .*$/gm)).toEqual([
			'## `/w/src/a.ts` (2)',
			'## `/w/src/b.py` (2)',
			'## `/w/src/c.ts` (1)',
		]);
		expect(text).not.toContain('scanIncludePassing');
	});

	it('leaves the Problems panel alone unless asked, then shows what can hang', async () => {
		open();
		await runCommand('regex-le.validateWorkspace');
		expect(_diagnostics().size).toBe(0);

		_setConfig('regex-le.workspace.scanProblemsEnabled', true);
		await runCommand('regex-le.validateWorkspace');
		expect([..._diagnostics().keys()]).toEqual(['/w/src/a.ts']);
		const [problem] = _diagnostics().get('/w/src/a.ts') ?? [];
		expect(problem?.severity).toBe(1);
		expect(problem?.source).toBe('regex-le');
		expect(problem?.range.start).toMatchObject({ line: 1, character: 13 });
		expect(problem?.message).toMatch(/^can hang \(high\): /);
	});

	it('scans only the folder it is handed, and names files relative to it', async () => {
		open({ ...TREE, '/w/lib/d.ts': 'const slow = /(b+)+$/;\n' });
		await runCommand('regex-le.validateFolder', Uri.file('/w/lib'));

		expect(report()).toContain('`/w/lib` · 1 file(s) read · 1 pattern(s)');
		expect(report().match(/^## .*$/gm)).toEqual(['## `d.ts` (1)']);
	});

	it('asks for a folder from the palette, and does nothing when none is picked', async () => {
		open();
		_respondToOpenDialog(() => undefined);
		await runCommand('regex-le.validateFolder');
		expect(_openedDocuments()).toHaveLength(0);

		_respondToOpenDialog(() => [Uri.file('/w/src')]);
		await runCommand('regex-le.validateFolder');
		expect(report()).toContain('`/w/src` · 3 file(s) read');
	});

	it('stops at the results limit and says the rest was not read', async () => {
		open();
		_setConfig('regex-le.workspace.scanIncludePassing', true);
		_setConfig('regex-le.workspace.scanMaxResults', 1);
		await runCommand('regex-le.validateWorkspace');

		expect(report().match(/^## .*$/gm)).toEqual(['## `/w/src/a.ts` (1)']);
		expect(report()).toContain(
			'> The results limit was reached. The rest of the files were not read.',
		);
	});

	it('honours the positions settings, on screen and in the copy separately', async () => {
		open();
		_setConfig('regex-le.copyToClipboardEnabled', true);
		_setConfig('regex-le.showPositions', false);
		await runCommand('regex-le.validateWorkspace');

		expect(report()).not.toMatch(/\*\*\d+:\d+\*\*/);
		expect(report()).toContain('- `/(a+)+$/` · can hang');
		// The clipboard has its own setting, and that one is still on.
		expect(_clipboardText()).toMatch(/\*\*2:14\*\*/);
	});

	it('says so when the search for hangs is off, and reports none', async () => {
		open();
		_setConfig('regex-le.regex.redosDetectionEnabled', false);
		await runCommand('regex-le.validateWorkspace');

		const text = report();
		// With the search off nothing was asked, so nothing went unanswered.
		expect(text).not.toContain('| `/w/src/');
		expect(text).toContain(
			'> 3 other file(s) hold only patterns with no finding.',
		);
		expect(text).toContain('`regex-le.regex.redosDetectionEnabled`');
		expect(text.match(/^## .*$/gm)).toBeNull();
	});

	it('reads another kind of file when the patterns setting names it', async () => {
		open({ '/w/notes.md': 'const slow = /(a+)+$/;\n' });
		await runCommand('regex-le.validateWorkspace');
		expect(report()).toContain('No patterns found.');

		_setConfig('regex-le.workspace.scanPatterns', ['**/*.md']);
		await runCommand('regex-le.validateWorkspace');
		expect(report()).toContain('| `/w/notes.md` | 1 | 1 | 0 |');
	});

	it('tables every file when every pattern is listed', async () => {
		open();
		_setConfig('regex-le.workspace.scanIncludePassing', true);
		await runCommand('regex-le.validateWorkspace');
		expect(report()).toContain('| `/w/src/c.ts` | 1 | 0 | 0 |');
		expect(report()).not.toContain('other file(s)');
	});
	it('prints the report the README shows as its sample', async () => {
		open();
		await runCommand('regex-le.validateFolder', Uri.file('/w'));

		const readme = readFileSync(
			join(__dirname, '..', '..', 'README.md'),
			'utf8',
		);
		const shown = report()
			.split('\n')
			.filter((line) => line.startsWith('- ') || line.startsWith('| `'));
		expect(shown).toHaveLength(3);
		for (const line of shown) expect(readme).toContain(line);
		expect(readme).toContain(
			'3 file(s) read · 5 pattern(s), 1 can hang, 1 not checked',
		);
	});
});
