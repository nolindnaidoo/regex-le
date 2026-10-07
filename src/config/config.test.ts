import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { _resetMockState, _setConfig } from '../__mocks__/vscode';
import {
	DEFAULT_EXCLUDED_FILES,
	DEFAULT_EXCLUDED_FOLDERS,
	DEFAULT_EXCLUDED_PATHS,
} from '../workspace/defaults';
import { CONFIG_DEFAULTS, getConfiguration } from './config';

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
		'regex-le.clipboardIncludesPositions': 'clipboardIncludesPositions',
		'regex-le.copyToClipboardEnabled': 'copyToClipboardEnabled',
		'regex-le.notificationsLevel': 'notificationsLevel',
		'regex-le.openResultsSideBySide': 'openResultsSideBySide',
		'regex-le.safety.enabled': 'safetyEnabled',
		'regex-le.safety.fileSizeWarnBytes': 'safetyFileSizeWarnBytes',
		'regex-le.safety.largeOutputLinesThreshold':
			'safetyLargeOutputLinesThreshold',
		'regex-le.showPositions': 'showPositions',
		'regex-le.statusBar.enabled': 'statusBarEnabled',
		'regex-le.telemetryEnabled': 'telemetryEnabled',
		'regex-le.regex.redosDetectionEnabled': 'regexRedosDetectionEnabled',
		'regex-le.regex.maxMatchLimit': 'regexMaxMatchLimit',
		'regex-le.workspace.scanAlwaysInclude': 'workspaceScanAlwaysInclude',
		'regex-le.workspace.scanExcludes': 'workspaceScanExcludes',
		'regex-le.workspace.scanIncludePassing': 'workspaceScanIncludePassing',
		'regex-le.workspace.scanMaxFiles': 'workspaceScanMaxFiles',
		'regex-le.workspace.scanMaxResults': 'workspaceScanMaxResults',
		'regex-le.workspace.scanPatterns': 'workspaceScanPatterns',
		'regex-le.workspace.scanProblemsEnabled': 'workspaceScanProblemsEnabled',
		'regex-le.workspace.scanRespectGitignore': 'workspaceScanRespectGitignore',
		'regex-le.workspace.scanSkipBinaryFiles': 'workspaceScanSkipBinaryFiles',
		'regex-le.workspace.scanUseDefaultExcludes':
			'workspaceScanUseDefaultExcludes',
	};

	it('covers every declared setting', () => {
		expect(Object.keys(props).sort()).toEqual(Object.keys(KEY_MAP).sort());
	});

	for (const [manifestKey, defaultsKey] of Object.entries(KEY_MAP)) {
		it(`${manifestKey} default matches`, () => {
			expect(CONFIG_DEFAULTS[defaultsKey]).toEqual(props[manifestKey]?.default);
		});
	}
});

describe('the README states the scan limits the code uses', () => {
	const readme = readFileSync(join(__dirname, '..', '..', 'README.md'), 'utf8');
	// Grouped by hand, not by Intl. The first Intl call in a process loads its
	// locale data, and on a Windows runner that once took sixteen seconds
	// inside a test that only compares two strings.
	const grouped = (n: number) =>
		String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

	it('in the settings table', () => {
		expect(readme).toContain(
			`| \`regex-le.workspace.scanMaxFiles\` | \`${CONFIG_DEFAULTS.workspaceScanMaxFiles}\` |`,
		);
		expect(readme).toContain(
			`| \`regex-le.workspace.scanMaxResults\` | \`${CONFIG_DEFAULTS.workspaceScanMaxResults}\` |`,
		);
	});

	it('in the prose', () => {
		expect(readme).toContain(
			`It stops at ${grouped(CONFIG_DEFAULTS.workspaceScanMaxFiles)} files or ${grouped(CONFIG_DEFAULTS.workspaceScanMaxResults)} listed patterns.`,
		);
	});
});

describe('the README lists the folders a scan skips', () => {
	it('exactly as the code has them', () => {
		const readme = readFileSync(
			join(__dirname, '..', '..', 'README.md'),
			'utf8',
		);
		const listed =
			/<!-- built-in-folders -->\n(.*)\n<!-- \/built-in-folders -->/
				.exec(readme)?.[1]
				?.split(', ')
				.map((entry) => entry.replace(/`/g, ''));
		expect(listed).toEqual([...DEFAULT_EXCLUDED_FOLDERS, '*.egg-info']);
	});

	it('and the files, exactly as the code has them', () => {
		const readme = readFileSync(
			join(__dirname, '..', '..', 'README.md'),
			'utf8',
		);
		const listed = /<!-- built-in-files -->\n(.*)\n<!-- \/built-in-files -->/
			.exec(readme)?.[1]
			?.split(', ')
			.map((entry) => entry.replace(/`/g, ''));
		expect(listed).toEqual([
			...DEFAULT_EXCLUDED_FILES,
			...DEFAULT_EXCLUDED_PATHS,
		]);
	});
});

describe('getConfiguration', () => {
	beforeEach(() => {
		_resetMockState();
	});

	it('returns a frozen configuration of exactly the declared settings', () => {
		const config = getConfiguration();
		expect(Object.isFrozen(config)).toBe(true);
		expect(Object.keys(config).sort()).toEqual(
			Object.keys(CONFIG_DEFAULTS).sort(),
		);
	});

	it('uses defaults when nothing is set', () => {
		expect(getConfiguration()).toEqual(CONFIG_DEFAULTS);
	});

	it('reads overrides', () => {
		_setConfig('regex-le.copyToClipboardEnabled', true);
		_setConfig('regex-le.regex.maxMatchLimit', 500);
		_setConfig('regex-le.notificationsLevel', 'all');
		const config = getConfiguration();
		expect(config.copyToClipboardEnabled).toBe(true);
		expect(config.regexMaxMatchLimit).toBe(500);
		expect(config.notificationsLevel).toBe('all');
	});

	it('non-boolean overrides fall back to defaults', () => {
		_setConfig('regex-le.safety.enabled', 'false');
		expect(getConfiguration().safetyEnabled).toBe(true);
	});

	it('non-numeric overrides fall back to defaults instead of NaN', () => {
		_setConfig('regex-le.safety.fileSizeWarnBytes', 'a lot');
		expect(getConfiguration().safetyFileSizeWarnBytes).toBe(
			CONFIG_DEFAULTS.safetyFileSizeWarnBytes,
		);
	});

	it('clamps numbers to declared minimums', () => {
		_setConfig('regex-le.safety.fileSizeWarnBytes', 1);
		_setConfig('regex-le.safety.largeOutputLinesThreshold', 1);
		_setConfig('regex-le.regex.maxMatchLimit', 1);
		const config = getConfiguration();
		expect(config.safetyFileSizeWarnBytes).toBe(1000);
		expect(config.safetyLargeOutputLinesThreshold).toBe(100);
		expect(config.regexMaxMatchLimit).toBe(10);
	});

	it('clamps maxMatchLimit to its declared maximum', () => {
		_setConfig('regex-le.regex.maxMatchLimit', 20000);
		expect(getConfiguration().regexMaxMatchLimit).toBe(10000);
	});

	it('invalid notification level falls back to silent', () => {
		_setConfig('regex-le.notificationsLevel', 'loud');
		expect(getConfiguration().notificationsLevel).toBe('silent');
	});

	it('accepts every valid notification level', () => {
		for (const level of ['all', 'important', 'silent'] as const) {
			_setConfig('regex-le.notificationsLevel', level);
			expect(getConfiguration().notificationsLevel).toBe(level);
		}
	});
});
