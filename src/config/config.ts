import * as vscode from 'vscode';
import type { Configuration } from '../types';

/**
 * The defaults, exported for the parity gate.
 *
 * Nothing else imports this: `config.test.ts` asserts it matches every
 * default declared in package.json, which is the invariant that stops the
 * two drifting apart. The export is the seam that test needs.
 */
export const CONFIG_DEFAULTS = Object.freeze({
	clipboardIncludesPositions: true,
	copyToClipboardEnabled: false,
	notificationsLevel: 'silent' as const,
	openResultsSideBySide: true,
	safetyEnabled: true,
	safetyFileSizeWarnBytes: 1_000_000,
	safetyLargeOutputLinesThreshold: 50_000,
	showPositions: true,
	statusBarEnabled: true,
	telemetryEnabled: false,
	regexRedosDetectionEnabled: true,
	regexMaxMatchLimit: 1000,
	workspaceScanAlwaysInclude: Object.freeze([]) as readonly string[],
	workspaceScanExcludes: Object.freeze([]) as readonly string[],
	workspaceScanIncludePassing: false,
	workspaceScanMaxFiles: 5000,
	workspaceScanMaxResults: 10000,
	// The languages the extractor has forms for. Any other file would be
	// scanned for every form, and a path in a README reads as a pattern.
	workspaceScanPatterns: Object.freeze([
		'**/*.js',
		'**/*.jsx',
		'**/*.mjs',
		'**/*.cjs',
		'**/*.ts',
		'**/*.tsx',
		'**/*.mts',
		'**/*.cts',
		'**/*.py',
		'**/*.rs',
		'**/*.go',
		'**/*.java',
		'**/*.rb',
		'**/*.php',
		'**/*.cs',
	]) as readonly string[],
	workspaceScanProblemsEnabled: false,
	workspaceScanRespectGitignore: true,
	workspaceScanSkipBinaryFiles: true,
	workspaceScanUseDefaultExcludes: true,
});

export function getConfiguration(): Configuration {
	const config = vscode.workspace.getConfiguration('regex-le');

	return Object.freeze({
		clipboardIncludesPositions: readBoolean(
			config,
			'clipboardIncludesPositions',
			CONFIG_DEFAULTS.clipboardIncludesPositions,
		),
		copyToClipboardEnabled: readBoolean(
			config,
			'copyToClipboardEnabled',
			CONFIG_DEFAULTS.copyToClipboardEnabled,
		),
		notificationsLevel: readNotificationLevel(config),
		openResultsSideBySide: readBoolean(
			config,
			'openResultsSideBySide',
			CONFIG_DEFAULTS.openResultsSideBySide,
		),
		safetyEnabled: readBoolean(
			config,
			'safety.enabled',
			CONFIG_DEFAULTS.safetyEnabled,
		),
		safetyFileSizeWarnBytes: readNumber(
			config,
			'safety.fileSizeWarnBytes',
			CONFIG_DEFAULTS.safetyFileSizeWarnBytes,
			1000,
		),
		safetyLargeOutputLinesThreshold: readNumber(
			config,
			'safety.largeOutputLinesThreshold',
			CONFIG_DEFAULTS.safetyLargeOutputLinesThreshold,
			100,
		),
		showPositions: readBoolean(
			config,
			'showPositions',
			CONFIG_DEFAULTS.showPositions,
		),
		statusBarEnabled: readBoolean(
			config,
			'statusBar.enabled',
			CONFIG_DEFAULTS.statusBarEnabled,
		),
		telemetryEnabled: readBoolean(
			config,
			'telemetryEnabled',
			CONFIG_DEFAULTS.telemetryEnabled,
		),
		regexRedosDetectionEnabled: readBoolean(
			config,
			'regex.redosDetectionEnabled',
			CONFIG_DEFAULTS.regexRedosDetectionEnabled,
		),
		regexMaxMatchLimit: readNumber(
			config,
			'regex.maxMatchLimit',
			CONFIG_DEFAULTS.regexMaxMatchLimit,
			10,
			10_000,
		),
		workspaceScanAlwaysInclude: readStrings(
			config,
			'workspace.scanAlwaysInclude',
			CONFIG_DEFAULTS.workspaceScanAlwaysInclude,
		),
		workspaceScanExcludes: readStrings(
			config,
			'workspace.scanExcludes',
			CONFIG_DEFAULTS.workspaceScanExcludes,
		),
		workspaceScanIncludePassing: readBoolean(
			config,
			'workspace.scanIncludePassing',
			CONFIG_DEFAULTS.workspaceScanIncludePassing,
		),
		workspaceScanMaxFiles: readNumber(
			config,
			'workspace.scanMaxFiles',
			CONFIG_DEFAULTS.workspaceScanMaxFiles,
			1,
		),
		workspaceScanMaxResults: readNumber(
			config,
			'workspace.scanMaxResults',
			CONFIG_DEFAULTS.workspaceScanMaxResults,
			1,
		),
		workspaceScanPatterns: readStrings(
			config,
			'workspace.scanPatterns',
			CONFIG_DEFAULTS.workspaceScanPatterns,
		),
		workspaceScanProblemsEnabled: readBoolean(
			config,
			'workspace.scanProblemsEnabled',
			CONFIG_DEFAULTS.workspaceScanProblemsEnabled,
		),
		workspaceScanRespectGitignore: readBoolean(
			config,
			'workspace.scanRespectGitignore',
			CONFIG_DEFAULTS.workspaceScanRespectGitignore,
		),
		workspaceScanSkipBinaryFiles: readBoolean(
			config,
			'workspace.scanSkipBinaryFiles',
			CONFIG_DEFAULTS.workspaceScanSkipBinaryFiles,
		),
		workspaceScanUseDefaultExcludes: readBoolean(
			config,
			'workspace.scanUseDefaultExcludes',
			CONFIG_DEFAULTS.workspaceScanUseDefaultExcludes,
		),
	});
}

function readStrings(
	config: vscode.WorkspaceConfiguration,
	key: string,
	defaultValue: readonly string[],
): readonly string[] {
	const value = config.get<unknown>(key, defaultValue);
	return Object.freeze(
		Array.isArray(value)
			? value.filter((item): item is string => typeof item === 'string')
			: [...defaultValue],
	);
}

function readBoolean(
	config: vscode.WorkspaceConfiguration,
	key: string,
	defaultValue: boolean,
): boolean {
	const value = config.get(key, defaultValue);
	return typeof value === 'boolean' ? value : defaultValue;
}

function readNumber(
	config: vscode.WorkspaceConfiguration,
	key: string,
	defaultValue: number,
	minValue: number,
	maxValue?: number,
): number {
	const value = Number(config.get(key, defaultValue));
	if (!Number.isFinite(value)) {
		return defaultValue;
	}
	const clamped = Math.max(minValue, value);
	return maxValue === undefined ? clamped : Math.min(maxValue, clamped);
}

export type NotificationLevel = 'all' | 'important' | 'silent';

export function isValidNotificationLevel(v: unknown): v is NotificationLevel {
	return v === 'all' || v === 'important' || v === 'silent';
}

function readNotificationLevel(
	config: vscode.WorkspaceConfiguration,
): NotificationLevel {
	const raw = config.get<string>(
		'notificationsLevel',
		CONFIG_DEFAULTS.notificationsLevel,
	);
	return isValidNotificationLevel(raw)
		? raw
		: CONFIG_DEFAULTS.notificationsLevel;
}
