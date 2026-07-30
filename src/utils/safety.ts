import * as vscode from 'vscode';
import type { Configuration } from '../types';
import { createEnhancedError, type EnhancedError } from './errorHandling';

export interface SafetyResult {
	readonly proceed: boolean;
	readonly message: string;
	readonly error?: EnhancedError;
	readonly warnings: readonly string[];
}

export interface SafetyCheckOptions {
	readonly showProgress?: boolean;
	readonly allowOverride?: boolean;
	readonly customThresholds?: {
		readonly fileSizeBytes?: number;
		readonly lineCount?: number;
		readonly itemCount?: number;
	};
}

/**
 * Perform safety checks on a document before processing
 */
export function handleSafetyChecks(
	document: vscode.TextDocument,
	config: Configuration,
	options: SafetyCheckOptions = {},
): SafetyResult {
	// Skip safety checks if disabled
	if (!config.safetyEnabled) {
		return Object.freeze({
			proceed: true,
			message: '',
			warnings: Object.freeze([]),
		});
	}

	const content = document.getText();
	const fileSizeThreshold =
		options.customThresholds?.fileSizeBytes ?? config.safetyFileSizeWarnBytes;

	// Check file size
	const exceedsFileSize = content.length > fileSizeThreshold;
	if (exceedsFileSize) {
		const error = createEnhancedError(
			new Error(
				`File size (${content.length} bytes) exceeds safety threshold (${fileSizeThreshold} bytes)`,
			),
			'safety',
			{
				fileSize: content.length,
				threshold: fileSizeThreshold,
				fileName: document.fileName,
			},
			{
				recoverable: false,
				severity: 'high',
				suggestion:
					'Consider splitting the file or increasing the safety threshold in settings',
			},
		);

		return Object.freeze({
			proceed: false,
			message: error.userMessage,
			error,
			warnings: Object.freeze([]),
		});
	}

	// Collect warnings
	const warnings = collectSafetyWarnings(content, config, options);
	const hasWarnings = warnings.length > 0;
	const message = hasWarnings
		? `Safety checks passed with ${warnings.length} warnings`
		: 'Safety checks passed';

	return Object.freeze({
		proceed: true,
		message,
		warnings: Object.freeze(warnings),
	});
}

/**
 * Collect safety warnings without blocking
 */
function collectSafetyWarnings(
	content: string,
	_config: Configuration,
	options: SafetyCheckOptions,
): string[] {
	const warnings: string[] = [];
	const lines = content.split('\n');
	const lineCount = lines.length;

	// Warn about large line count
	const lineThreshold = options.customThresholds?.lineCount ?? 10000;
	if (lineCount > lineThreshold) {
		warnings.push(`File has ${lineCount} lines (threshold: ${lineThreshold})`);
	}

	// Warn if file appears to be binary or malformed
	const hasBinaryContent = content.includes('\x00');
	if (hasBinaryContent) {
		warnings.push('File may contain binary content');
	}

	return warnings;
}

/**
 * Check output safety before presenting to user
 */
export function checkOutputSafety(
	outputLines: readonly string[],
	config: Configuration,
): SafetyResult {
	if (!config.safetyEnabled) {
		return Object.freeze({
			proceed: true,
			message: '',
			warnings: Object.freeze([]),
		});
	}

	const lineCount = outputLines.length;
	const threshold = config.safetyLargeOutputLinesThreshold;

	// Block extremely large outputs
	const exceedsThreshold = lineCount > threshold;
	if (exceedsThreshold) {
		const error = createEnhancedError(
			new Error(
				`Output size (${lineCount} lines) exceeds safety threshold (${threshold} lines)`,
			),
			'safety',
			{
				outputLines: lineCount,
				threshold,
			},
			{
				recoverable: true,
				severity: 'medium',
				suggestion: 'Consider filtering results or increasing the threshold',
			},
		);

		return Object.freeze({
			proceed: false,
			message: error.userMessage,
			error,
			warnings: Object.freeze([]),
		});
	}

	return Object.freeze({
		proceed: true,
		message: 'Output safety check passed',
		warnings: Object.freeze([]),
	});
}

/**
 * Ask user for confirmation when processing risky operations
 */
export async function confirmRiskyOperation(
	message: string,
	detail?: string,
): Promise<boolean> {
	const proceed = 'Proceed';
	const cancel = 'Cancel';

	const options =
		detail !== undefined ? { modal: true, detail } : { modal: true };
	const result = await vscode.window.showWarningMessage(
		message,
		options,
		proceed,
		cancel,
	);

	return result === proceed;
}
