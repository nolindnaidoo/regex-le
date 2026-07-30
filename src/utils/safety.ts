import type * as vscode from 'vscode';
import type { Configuration } from '../types';

export interface SafetyResult {
	readonly proceed: boolean;
	readonly message: string;
	readonly warnings: readonly string[];
}

/**
 * Pre-processing guardrails: refuse files over the configured size
 * threshold and surface warnings for large line counts or binary
 * content. Pure string checks — no filesystem access.
 */
export function handleSafetyChecks(
	document: vscode.TextDocument,
	config: Configuration,
): SafetyResult {
	if (!config.safetyEnabled) {
		return Object.freeze({ proceed: true, message: '', warnings: [] });
	}

	const content = document.getText();

	if (content.length > config.safetyFileSizeWarnBytes) {
		return Object.freeze({
			proceed: false,
			message: `File size (${content.length} bytes) exceeds safety threshold (${config.safetyFileSizeWarnBytes} bytes). Consider splitting the file or increasing the threshold in settings.`,
			warnings: [],
		});
	}

	const warnings: string[] = [];
	const lineCount = content.split('\n').length;
	if (lineCount > 10_000) {
		warnings.push(`File has ${lineCount} lines`);
	}
	if (content.includes('\x00')) {
		warnings.push('File may contain binary content');
	}

	return Object.freeze({
		proceed: true,
		message: '',
		warnings: Object.freeze(warnings),
	});
}

/**
 * Refuse to open result documents over the configured line threshold.
 */
export function checkOutputSafety(
	outputLines: readonly string[],
	config: Configuration,
): SafetyResult {
	if (!config.safetyEnabled) {
		return Object.freeze({ proceed: true, message: '', warnings: [] });
	}

	if (outputLines.length > config.safetyLargeOutputLinesThreshold) {
		return Object.freeze({
			proceed: false,
			message: `Output size (${outputLines.length} lines) exceeds safety threshold (${config.safetyLargeOutputLinesThreshold} lines). Consider filtering results or increasing the threshold in settings.`,
			warnings: [],
		});
	}

	return Object.freeze({ proceed: true, message: '', warnings: [] });
}
