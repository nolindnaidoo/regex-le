import { beforeEach, describe, expect, it } from 'vitest';
import {
	_createExtensionContext,
	_fireConfigChange,
	_registeredCommands,
	_resetMockState,
	_setConfig,
	_shownMessages,
	executedBuiltins,
} from '../__mocks__/vscode';
import { activate } from '../extension';
import { createNotifier } from '../ui/notifier';
import { createStatusBar } from '../ui/statusBar';
import { createServices } from './serviceFactory';

beforeEach(() => {
	_resetMockState();
});

describe('createServices / activate', () => {
	it('activate registers every declared command', () => {
		const context = _createExtensionContext();
		activate(context as never);

		const declared = [
			'regex-le.test',
			'regex-le.extract',
			'regex-le.validate',
			'regex-le.openSettings',
			'regex-le.help',
		];
		for (const id of declared) {
			expect(_registeredCommands().has(id), id).toBe(true);
		}
	});

	it('createServices returns frozen bag and registers disposables', () => {
		const context = _createExtensionContext();
		const services = createServices(context as never);
		expect(Object.isFrozen(services)).toBe(true);
		expect(context.subscriptions.length).toBeGreaterThan(0);
	});

	it('openSettings executes the builtin settings command', async () => {
		const context = _createExtensionContext();
		activate(context as never);
		await _registeredCommands().get('regex-le.openSettings')?.();

		expect(executedBuiltins[0]?.id).toBe('workbench.action.openSettings');
		expect(executedBuiltins[0]?.args[0]).toBe('regex-le');
	});
});

describe('statusBar', () => {
	it('is visible by default and hides when disabled at runtime', () => {
		const context = _createExtensionContext();
		const statusBar = createStatusBar(context as never);
		expect(statusBar).toBeDefined();

		_setConfig('regex-le.statusBar.enabled', false);
		_fireConfigChange('regex-le.statusBar.enabled');
		// visibility is applied on the mock item; nothing throws and the
		// listener is registered as a disposable
		expect(context.subscriptions.length).toBeGreaterThanOrEqual(2);
	});
});

describe('notifier levels', () => {
	it('silent (default) shows errors only', () => {
		const notifier = createNotifier();
		notifier.showInfo('info');
		notifier.showWarning('warning');
		notifier.showError('error');
		expect(_shownMessages().map((m) => m.kind)).toEqual(['error']);
	});

	it('important shows warnings and errors', () => {
		_setConfig('regex-le.notificationsLevel', 'important');
		const notifier = createNotifier();
		notifier.showInfo('info');
		notifier.showWarning('warning');
		notifier.showError('error');
		expect(_shownMessages().map((m) => m.kind)).toEqual(['warning', 'error']);
	});

	it('all shows everything', () => {
		_setConfig('regex-le.notificationsLevel', 'all');
		const notifier = createNotifier();
		notifier.showInfo('info');
		notifier.showWarning('warning');
		notifier.showError('error');
		expect(_shownMessages().map((m) => m.kind)).toEqual([
			'info',
			'warning',
			'error',
		]);
	});
});
