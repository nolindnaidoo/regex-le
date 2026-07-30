import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { CONFIG_DEFAULTS, getConfiguration } from './config';

vi.mock('vscode');

/**
 * CONFIG_DEFAULTS must stay identical to the defaults declared in
 * package.json contributes.configuration — v1.x shipped with code
 * fallbacks that could silently disagree with the manifest.
 */
describe('config defaults parity with package.json', () => {
	const manifest = JSON.parse(
		readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
	) as {
		contributes: {
			configuration: { properties: Record<string, { default: unknown }> };
		};
	};
	const props = manifest.contributes.configuration.properties;

	const KEY_MAP: Record<string, keyof typeof CONFIG_DEFAULTS> = {
		'regex-le.copyToClipboardEnabled': 'copyToClipboardEnabled',
		'regex-le.notificationsLevel': 'notificationsLevel',
		'regex-le.openResultsSideBySide': 'openResultsSideBySide',
		'regex-le.safety.enabled': 'safetyEnabled',
		'regex-le.safety.fileSizeWarnBytes': 'safetyFileSizeWarnBytes',
		'regex-le.safety.largeOutputLinesThreshold':
			'safetyLargeOutputLinesThreshold',
		'regex-le.statusBar.enabled': 'statusBarEnabled',
		'regex-le.telemetryEnabled': 'telemetryEnabled',
		'regex-le.regex.redosDetectionEnabled': 'regexRedosDetectionEnabled',
		'regex-le.regex.maxMatchLimit': 'regexMaxMatchLimit',
	};

	it('covers every declared setting', () => {
		expect(Object.keys(props).sort()).toEqual(Object.keys(KEY_MAP).sort());
	});

	for (const [manifestKey, defaultsKey] of Object.entries(KEY_MAP)) {
		it(`${manifestKey} default matches`, () => {
			expect(CONFIG_DEFAULTS[defaultsKey]).toBe(props[manifestKey]?.default);
		});
	}
});

describe('getConfiguration', () => {
	const mockConfig = {
		get: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(
			mockConfig as any,
		);
		mockConfig.get.mockImplementation(
			(_key: string, defaultValue: unknown) => defaultValue,
		);
	});

	it('returns a frozen configuration of exactly the declared settings', () => {
		const config = getConfiguration();
		expect(Object.isFrozen(config)).toBe(true);
		expect(Object.keys(config).sort()).toEqual(
			Object.keys(CONFIG_DEFAULTS).sort(),
		);
	});

	it('uses defaults when nothing is set', () => {
		const config = getConfiguration();
		expect(config).toEqual(CONFIG_DEFAULTS);
	});

	it('reads overrides', () => {
		mockConfig.get.mockImplementation((key: string, dflt: unknown) => {
			if (key === 'copyToClipboardEnabled') return true;
			if (key === 'regex.maxMatchLimit') return 500;
			if (key === 'notificationsLevel') return 'all';
			return dflt;
		});
		const config = getConfiguration();
		expect(config.copyToClipboardEnabled).toBe(true);
		expect(config.regexMaxMatchLimit).toBe(500);
		expect(config.notificationsLevel).toBe('all');
	});

	it('non-boolean overrides fall back to defaults', () => {
		mockConfig.get.mockImplementation((key: string, dflt: unknown) => {
			if (key === 'safety.enabled') return 'false';
			return dflt;
		});
		expect(getConfiguration().safetyEnabled).toBe(true);
	});

	it('non-numeric overrides fall back to defaults instead of NaN', () => {
		mockConfig.get.mockImplementation((key: string, dflt: unknown) => {
			if (key === 'safety.fileSizeWarnBytes') return 'a lot';
			return dflt;
		});
		expect(getConfiguration().safetyFileSizeWarnBytes).toBe(
			CONFIG_DEFAULTS.safetyFileSizeWarnBytes,
		);
	});

	it('clamps numbers to declared minimums', () => {
		mockConfig.get.mockImplementation((key: string, dflt: unknown) => {
			if (key === 'safety.fileSizeWarnBytes') return 1;
			if (key === 'safety.largeOutputLinesThreshold') return 1;
			if (key === 'regex.maxMatchLimit') return 1;
			return dflt;
		});
		const config = getConfiguration();
		expect(config.safetyFileSizeWarnBytes).toBe(1000);
		expect(config.safetyLargeOutputLinesThreshold).toBe(100);
		expect(config.regexMaxMatchLimit).toBe(10);
	});

	it('clamps maxMatchLimit to its declared maximum', () => {
		mockConfig.get.mockImplementation((key: string, dflt: unknown) => {
			if (key === 'regex.maxMatchLimit') return 20000;
			return dflt;
		});
		expect(getConfiguration().regexMaxMatchLimit).toBe(10000);
	});

	it('invalid notification level falls back to silent', () => {
		mockConfig.get.mockImplementation((key: string, dflt: unknown) => {
			if (key === 'notificationsLevel') return 'loud';
			return dflt;
		});
		expect(getConfiguration().notificationsLevel).toBe('silent');
	});

	it('accepts every valid notification level', () => {
		for (const level of ['all', 'important', 'silent'] as const) {
			mockConfig.get.mockImplementation((key: string, dflt: unknown) => {
				if (key === 'notificationsLevel') return level;
				return dflt;
			});
			expect(getConfiguration().notificationsLevel).toBe(level);
		}
	});
});
