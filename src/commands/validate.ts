import * as vscode from 'vscode';
import { extractRegexPatterns } from '../extraction/regex/extractPatterns';
import type { Telemetry } from '../telemetry/telemetry';
import type { Notifier } from '../ui/notifier';
import type { StatusBar } from '../ui/statusBar';
import { sanitizeErrorMessage } from '../utils/errors';
import { validateAllPatterns, validateSinglePattern } from './validateRunner';

/**
 * Register the regex validate command
 * Validates all regex patterns found in the active editor
 */
export function registerValidateCommand(
	context: vscode.ExtensionContext,
	deps: Readonly<{
		telemetry: Telemetry;
		notifier: Notifier;
		statusBar: StatusBar;
	}>,
): void {
	const disposable = vscode.commands.registerCommand(
		'regex-le.validate',
		async () => {
			deps.telemetry.event('command-validate');

			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				deps.notifier.showWarning(
					vscode.l10n.t('No active editor. Please open a file first.'),
				);
				return;
			}

			const document = editor.document;
			const text = document.getText();

			// Extract regex patterns from the file
			const extractedPatterns = extractRegexPatterns(text, document.languageId);

			if (extractedPatterns.length === 0) {
				deps.notifier.showInfo(
					vscode.l10n.t(
						'No regex patterns found in the file. Provide a pattern to validate.',
					),
				);

				// Fallback: prompt for pattern if none found
				const patternInput = await vscode.window.showInputBox({
					prompt: vscode.l10n.t('Enter regex pattern to validate'),
					placeHolder: vscode.l10n.t('e.g., /\\d+/'),
					validateInput: (value) => {
						if (!value || value.trim().length === 0) {
							return vscode.l10n.t('Pattern cannot be empty');
						}
						return null;
					},
				});

				if (!patternInput) {
					return;
				}

				// Parse the input pattern
				const patternMatch = patternInput.match(/^\/(.+)\/([gimsuvy]*)$/);
				const pattern = patternMatch?.[1] ?? patternInput.trim();
				const flags = patternMatch?.[2] ?? '';

				// Validate the single pattern
				await validateSinglePattern(pattern, flags, deps);
				return;
			}

			// Validate all patterns found in the file
			try {
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: vscode.l10n.t('Validating regex patterns...'),
						cancellable: false,
					},
					async (progress) => {
						await validateAllPatterns(extractedPatterns, deps, progress);
					},
				);
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				deps.notifier.showError(
					sanitizeErrorMessage(`Validation failed: ${errorMessage}`),
				);
				deps.telemetry.event('validate-failed', { error: errorMessage });
			}
		},
	);

	context.subscriptions.push(disposable);
}
