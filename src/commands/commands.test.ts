import { beforeEach, describe, expect, it } from 'vitest';
import {
	_clipboardText,
	_createDocument,
	_openedDocuments,
	_registeredCommands,
	_resetMockState,
	_respondToInputBox,
	_respondToQuickPick,
	_respondToWarning,
	_setActiveEditor,
	_setConfig,
	_shownMessages,
} from '../__mocks__/vscode';
import { createTelemetry } from '../telemetry/telemetry';
import { createNotifier } from '../ui/notifier';
import { createStatusBar } from '../ui/statusBar';
import { registerExtractCommand } from './extract';
import { registerHelpCommand } from './help';
import { registerTestCommand } from './test';
import { registerValidateCommand } from './validate';

function makeContext() {
	return { subscriptions: [] as Array<{ dispose(): void }> } as never;
}

function makeDeps() {
	return {
		telemetry: createTelemetry(),
		notifier: createNotifier(),
		statusBar: createStatusBar(makeContext()),
	};
}

async function runCommand(id: string): Promise<void> {
	const handler = _registeredCommands().get(id);
	if (!handler) throw new Error(`command not registered: ${id}`);
	await handler();
}

beforeEach(() => {
	_resetMockState();
});

describe('regex-le.extract', () => {
	it('warns when no editor is active', async () => {
		_setConfig('regex-le.notificationsLevel', 'important');
		registerExtractCommand(makeContext(), makeDeps());
		await runCommand('regex-le.extract');
		expect(_shownMessages()[0]?.kind).toBe('warning');
	});

	it('opens a document listing every extracted pattern', async () => {
		registerExtractCommand(makeContext(), makeDeps());
		_setActiveEditor(
			_createDocument({
				content: 'const a = /\\d+/g;\nconst b = new RegExp("x|y", "i");\n',
			}),
		);
		await runCommand('regex-le.extract');

		expect(_openedDocuments()).toHaveLength(1);
		expect(_openedDocuments()[0]?.getText()).toBe('/\\d+/g\n/x|y/i');
	});

	it('copies to clipboard when enabled', async () => {
		_setConfig('regex-le.copyToClipboardEnabled', true);
		registerExtractCommand(makeContext(), makeDeps());
		_setActiveEditor(_createDocument({ content: 'const a = /\\d+/g;' }));
		await runCommand('regex-le.extract');

		expect(_clipboardText()).toBe('/\\d+/g');
	});

	it('reports no patterns at the all level', async () => {
		_setConfig('regex-le.notificationsLevel', 'all');
		registerExtractCommand(makeContext(), makeDeps());
		_setActiveEditor(_createDocument({ content: 'plain text only' }));
		await runCommand('regex-le.extract');

		expect(_openedDocuments()).toHaveLength(0);
		expect(_shownMessages()[0]?.message).toContain('No regex patterns');
	});

	it('suppresses info toasts at the default silent level', async () => {
		registerExtractCommand(makeContext(), makeDeps());
		_setActiveEditor(_createDocument({ content: 'plain text only' }));
		await runCommand('regex-le.extract');
		expect(_shownMessages()).toHaveLength(0);
	});

	it('blocks oversized files with an error', async () => {
		_setConfig('regex-le.safety.fileSizeWarnBytes', 1000);
		registerExtractCommand(makeContext(), makeDeps());
		_setActiveEditor(_createDocument({ content: 'x'.repeat(2000) }));
		await runCommand('regex-le.extract');

		expect(_openedDocuments()).toHaveLength(0);
		expect(_shownMessages()[0]?.kind).toBe('error');
		expect(_shownMessages()[0]?.message).toContain('exceeds safety threshold');
	});

	it('blocks oversized outputs with an error', async () => {
		_setConfig('regex-le.safety.largeOutputLinesThreshold', 100);
		registerExtractCommand(makeContext(), makeDeps());
		// 150 distinct patterns -> 150 output lines over the 100 threshold
		const patterns = Array.from(
			{ length: 150 },
			(_, i) => `const p${i} = /x{${i + 1}}/;`,
		).join('\n');
		_setActiveEditor(_createDocument({ content: patterns }));
		await runCommand('regex-le.extract');

		expect(_openedDocuments()).toHaveLength(0);
		expect(_shownMessages()[0]?.kind).toBe('error');
		expect(_shownMessages()[0]?.message).toContain('Output size');
	});
});

describe('regex-le.test', () => {
	it('warns when no editor is active', async () => {
		_setConfig('regex-le.notificationsLevel', 'important');
		registerTestCommand(makeContext(), makeDeps());
		await runCommand('regex-le.test');
		expect(_shownMessages()[0]?.kind).toBe('warning');
	});

	it('tests the selected pattern and opens a report', async () => {
		registerTestCommand(makeContext(), makeDeps());
		_setActiveEditor(
			_createDocument({ content: 'const digits = /\\d+/g; // 42 and 7' }),
		);
		_respondToQuickPick(
			(items) =>
				(items as Array<{ pattern: string }>).find(
					(item) => item.pattern === '\\d+',
				) ?? undefined,
		);
		await runCommand('regex-le.test');

		expect(_openedDocuments()).toHaveLength(1);
		const report = _openedDocuments()[0]?.getText() ?? '';
		expect(report).toContain('# Regex Test Results');
		expect(report).toContain('**Matches Found:** 2');
	});

	it('tests all patterns when that choice is picked', async () => {
		registerTestCommand(makeContext(), makeDeps());
		_setActiveEditor(
			_createDocument({ content: 'const a = /\\d+/g;\nconst b = /[a-z]+/g;' }),
		);
		_respondToQuickPick(
			(items) =>
				(items as Array<{ pattern: string }>).find(
					(item) => item.pattern === '',
				) ?? undefined,
		);
		await runCommand('regex-le.test');

		const report = _openedDocuments()[0]?.getText() ?? '';
		expect(report).toContain('All Patterns');
		expect(report).toContain('Pattern 1');
		expect(report).toContain('Pattern 2');
	});

	it('falls back to an input box when the file has no patterns', async () => {
		registerTestCommand(makeContext(), makeDeps());
		_setActiveEditor(
			_createDocument({ content: 'numbers 12 and 34 but no patterns' }),
		);
		_respondToInputBox(() => '/\\d+/g');
		await runCommand('regex-le.test');

		const report = _openedDocuments()[0]?.getText() ?? '';
		expect(report).toContain('**Matches Found:** 2');
	});

	it('asks before testing a ReDoS-prone pattern and honors Cancel', async () => {
		registerTestCommand(makeContext(), makeDeps());
		_setActiveEditor(_createDocument({ content: 'aaaa' }));
		_respondToInputBox(() => '/(a+)+b/');
		_respondToWarning(() => 'Cancel');
		await runCommand('regex-le.test');

		expect(_openedDocuments()).toHaveLength(0);
		expect(_shownMessages()[0]?.message).toContain('ReDoS');
	});

	it('proceeds past the ReDoS warning when confirmed', async () => {
		registerTestCommand(makeContext(), makeDeps());
		_setActiveEditor(_createDocument({ content: 'aaab' }));
		_respondToInputBox(() => '/(a+)+b/');
		_respondToWarning(() => 'Proceed');
		await runCommand('regex-le.test');

		expect(_openedDocuments()).toHaveLength(1);
		const report = _openedDocuments()[0]?.getText() ?? '';
		expect(report).toContain('ReDoS Detection');
	});
});

describe('regex-le.validate', () => {
	it('validates every pattern in the file with a summary', async () => {
		registerValidateCommand(makeContext(), makeDeps());
		_setActiveEditor(
			_createDocument({
				content: 'const good = /\\d+/g;\nconst evil = new RegExp("(a+)+");',
			}),
		);
		await runCommand('regex-le.validate');

		const report = _openedDocuments()[0]?.getText() ?? '';
		expect(report).toContain('## Summary');
		expect(report).toContain('**Total Patterns:** 2');
		expect(report).toContain('ReDoS');
	});

	it('falls back to an input box when the file has no patterns', async () => {
		registerValidateCommand(makeContext(), makeDeps());
		_setActiveEditor(_createDocument({ content: 'no patterns here' }));
		_respondToInputBox(() => '[unclosed');
		await runCommand('regex-le.validate');

		const report = _openedDocuments()[0]?.getText() ?? '';
		expect(report).toContain('❌ Invalid');
	});
});

describe('regex-le.help', () => {
	it('opens a markdown help document describing real commands only', async () => {
		registerHelpCommand(makeContext(), createTelemetry());
		await runCommand('regex-le.help');

		const help = _openedDocuments()[0]?.getText() ?? '';
		expect(help).toContain('Regex-LE Help');
		expect(help).toContain('**Test**');
		expect(help).toContain('**Extract**');
		expect(help).toContain('**Validate**');
		expect(help).not.toContain('performance monitoring');
	});
});
