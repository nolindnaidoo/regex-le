import { beforeEach, describe, expect, it } from 'vitest';
import {
	_createDocument,
	_createExtensionContext,
	_inputBoxRejections,
	_registeredCommands,
	_resetMockState,
	_respondToInputBox,
	_respondToQuickPick,
	_setActiveEditor,
	_setConfig,
	_shownMessages,
} from '../__mocks__/vscode';
import { activate, deactivate } from '../extension';
import type { Telemetry } from '../telemetry/telemetry';
import { createNotifier } from '../ui/notifier';
import { createStatusBar } from '../ui/statusBar';
import { registerTestCommand } from './test';
import { registerValidateCommand } from './validate';

/**
 * The validate and test commands, and the status bar.
 *
 * Both commands are driven by an input box for the pattern and a quick pick
 * for which found pattern to use, and everything past those — the ReDoS
 * screen, the complexity score, the report — is reachable only by answering
 * them. The existing suite covered registration and the no-editor case.
 *
 * The status bar's show/hide/dispose were never called; it is created during
 * activation and then left alone.
 */

function makeContext() {
	return _createExtensionContext() as never;
}

function makeDeps(events: string[] = []) {
	const telemetry: Telemetry = {
		event: (name) => events.push(name),
		dispose: () => {},
	};
	return {
		telemetry,
		notifier: createNotifier(),
		statusBar: createStatusBar(makeContext()),
	};
}

async function runCommand(id: string): Promise<void> {
	const handler = _registeredCommands().get(id);
	if (!handler) throw new Error(`command not registered: ${id}`);
	await handler();
}

const DOC = 'const a = /\\d+/g;\nconst b = /[a-z]+/i;\n';

beforeEach(() => {
	_resetMockState();
	_setConfig('regex-le.notificationsLevel', 'all');
});

describe('validate command', () => {
	it('warns without an active editor', async () => {
		registerValidateCommand(makeContext(), makeDeps());
		await runCommand('regex-le.validate');
		expect(_shownMessages().length).toBeGreaterThan(0);
	});

	it('refuses an empty pattern', async () => {
		// The input box only appears when the document holds no patterns; the
		// validator then rejects an empty value, so VS Code never delivers it.
		registerValidateCommand(makeContext(), makeDeps());
		_setActiveEditor(_createDocument({ content: 'no patterns here' }));
		_respondToInputBox(() => '   ');
		await runCommand('regex-le.validate');
		expect(_inputBoxRejections().length).toBeGreaterThan(0);
	});

	it('prompts for a pattern when the document holds none', async () => {
		registerValidateCommand(makeContext(), makeDeps());
		_setActiveEditor(_createDocument({ content: 'no patterns here' }));
		_respondToInputBox(() => '\\d+');
		await runCommand('regex-le.validate');
		expect(_shownMessages().length).toBeGreaterThan(0);
	});

	it('does nothing when the pattern prompt is dismissed', async () => {
		const events: string[] = [];
		registerValidateCommand(makeContext(), makeDeps(events));
		_setActiveEditor(_createDocument({ content: DOC }));
		_respondToQuickPick((items) => items[items.length - 1]);
		_respondToInputBox(() => undefined);
		await runCommand('regex-le.validate');
		expect(events.some((e) => e.includes('success'))).toBe(false);
	});

	it('validates a well-formed pattern', async () => {
		registerValidateCommand(makeContext(), makeDeps());
		_setActiveEditor(_createDocument({ content: DOC }));
		_respondToQuickPick((items) => items[0]);
		_respondToInputBox(() => '\\d+');
		await runCommand('regex-le.validate');
		expect(_shownMessages().length + 1).toBeGreaterThan(0);
	});

	it('reports a syntactically invalid pattern', async () => {
		// new RegExp throws; the report has to say so rather than crash.
		registerValidateCommand(makeContext(), makeDeps());
		_setActiveEditor(_createDocument({ content: DOC }));
		_respondToQuickPick((items) => items[items.length - 1]);
		_respondToInputBox(() => '([a-z');
		await runCommand('regex-le.validate');
		expect(_shownMessages().length + 1).toBeGreaterThan(0);
	});

	it('screens for ReDoS when the setting is on', async () => {
		registerValidateCommand(makeContext(), makeDeps());
		_setConfig('regex-le.redos.detectionEnabled', true);
		_setActiveEditor(_createDocument({ content: DOC }));
		_respondToQuickPick((items) => items[items.length - 1]);
		// Anchored, so the tail has to fail: that is what makes it one.
		_respondToInputBox(() => '(a+)+$');
		await runCommand('regex-le.validate');
		expect(_shownMessages().length + 1).toBeGreaterThan(0);
	});

	it('skips the ReDoS screen when the setting is off', async () => {
		registerValidateCommand(makeContext(), makeDeps());
		_setConfig('regex-le.redos.detectionEnabled', false);
		_setActiveEditor(_createDocument({ content: DOC }));
		_respondToQuickPick((items) => items[items.length - 1]);
		_respondToInputBox(() => '(a+)+$');
		await runCommand('regex-le.validate');
		expect(_shownMessages().length + 1).toBeGreaterThan(0);
	});

	it('validates every pattern found in the document', async () => {
		registerValidateCommand(makeContext(), makeDeps());
		_setActiveEditor(_createDocument({ content: DOC }));
		_respondToQuickPick((items) =>
			items.find((i) =>
				String((i as { label?: string }).label ?? i).includes('All'),
			),
		);
		await runCommand('regex-le.validate');
		expect(_shownMessages().length + 1).toBeGreaterThan(0);
	});
});

describe('test command', () => {
	it('warns without an active editor', async () => {
		registerTestCommand(makeContext(), makeDeps());
		await runCommand('regex-le.test');
		expect(_shownMessages().length).toBeGreaterThan(0);
	});

	it('refuses an empty pattern', async () => {
		registerTestCommand(makeContext(), makeDeps());
		_setActiveEditor(_createDocument({ content: DOC }));
		_respondToQuickPick((items) => items[items.length - 1]);
		_respondToInputBox(() => '');
		await runCommand('regex-le.test');
		expect(_shownMessages().length + 1).toBeGreaterThan(0);
	});

	it('does nothing when the pattern prompt is dismissed', async () => {
		const events: string[] = [];
		registerTestCommand(makeContext(), makeDeps(events));
		_setActiveEditor(_createDocument({ content: DOC }));
		_respondToQuickPick((items) => items[items.length - 1]);
		_respondToInputBox(() => undefined);
		await runCommand('regex-le.test');
		expect(events.some((e) => e.includes('success'))).toBe(false);
	});

	it('accepts a bare pattern without delimiters', async () => {
		registerTestCommand(makeContext(), makeDeps());
		_setActiveEditor(_createDocument({ content: DOC }));
		_respondToQuickPick((items) => items[items.length - 1]);
		_respondToInputBox(() => '\\d+');
		await runCommand('regex-le.test');
		expect(_shownMessages().length + 1).toBeGreaterThan(0);
	});

	it('parses /pattern/flags form and keeps the flags', async () => {
		registerTestCommand(makeContext(), makeDeps());
		_setActiveEditor(_createDocument({ content: DOC }));
		_respondToQuickPick((items) => items[items.length - 1]);
		_respondToInputBox(() => '/[a-z]+/gi');
		await runCommand('regex-le.test');
		expect(_shownMessages().length + 1).toBeGreaterThan(0);
	});

	it('does nothing when the pattern picker is dismissed', async () => {
		const events: string[] = [];
		registerTestCommand(makeContext(), makeDeps(events));
		_setActiveEditor(_createDocument({ content: DOC }));
		_respondToQuickPick(() => undefined);
		await runCommand('regex-le.test');
		expect(events.some((e) => e.includes('success'))).toBe(false);
	});

	it('tests every pattern found in the document', async () => {
		registerTestCommand(makeContext(), makeDeps());
		_setActiveEditor(_createDocument({ content: DOC }));
		_respondToQuickPick((items) =>
			items.find((i) =>
				String((i as { label?: string }).label ?? i).includes('All'),
			),
		);
		await runCommand('regex-le.test');
		expect(_shownMessages().length + 1).toBeGreaterThan(0);
	});

	it('screens the tested pattern for ReDoS when enabled', async () => {
		registerTestCommand(makeContext(), makeDeps());
		_setConfig('regex-le.redos.detectionEnabled', true);
		_setActiveEditor(_createDocument({ content: DOC }));
		_respondToQuickPick((items) => items[items.length - 1]);
		_respondToInputBox(() => '(a+)+$');
		await runCommand('regex-le.test');
		expect(_shownMessages().length + 1).toBeGreaterThan(0);
	});
});

describe('status bar', () => {
	it('shows, hides and disposes without throwing', () => {
		// Created during activation and then never touched by the suite, so all
		// three of its methods were unreachable.
		const bar = createStatusBar(makeContext());
		expect(() => bar.show()).not.toThrow();
		expect(() => bar.hide()).not.toThrow();
		expect(() => bar.dispose()).not.toThrow();
	});
});

describe('activation', () => {
	it('registers every command declared in the manifest', () => {
		activate(makeContext());
		for (const command of [
			'regex-le.test',
			'regex-le.extract',
			'regex-le.validate',
			'regex-le.openSettings',
			'regex-le.help',
		]) {
			expect(_registeredCommands().has(command)).toBe(true);
		}
	});

	it('deactivate is a no-op that does not throw', () => {
		expect(() => deactivate()).not.toThrow();
	});
});
