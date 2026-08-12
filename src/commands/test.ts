import * as vscode from 'vscode';
import { getConfiguration } from '../config/config';
import { extractRegexPatterns } from '../extraction/regex/extractPatterns';
import type { Telemetry } from '../telemetry/telemetry';
import type { Notifier } from '../ui/notifier';
import type { StatusBar } from '../ui/statusBar';
import { sanitizeErrorMessage } from '../utils/errors';
import { handleSafetyChecks } from '../utils/safety';
import { testAllPatterns, testSinglePattern } from './testRunner';

/**
 * Register the regex test command
 * Tests regex patterns found in the active editor against the file content
 */
export function registerTestCommand(
	context: vscode.ExtensionContext,
	deps: Readonly<{
		telemetry: Telemetry;
		notifier: Notifier;
		statusBar: StatusBar;
	}>,
): void {
	const disposable = vscode.commands.registerCommand(
		'regex-le.test',
		async () => {
			deps.telemetry.event('command-test');

			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				deps.notifier.showWarning(
					vscode.l10n.t('No active editor. Please open a file first.'),
				);
				return;
			}

			const config = getConfiguration();
			const document = editor.document;

			// Perform safety checks
			const safetyResult = handleSafetyChecks(document, config);
			if (!safetyResult.proceed) {
				deps.notifier.showError(safetyResult.message);
				return;
			}

			const text = document.getText();

			// Extract regex patterns from the file
			const extractedPatterns = extractRegexPatterns(text, document.languageId);

			if (extractedPatterns.length === 0) {
				deps.notifier.showInfo(
					vscode.l10n.t(
						'No regex patterns found in the file. Select text or provide a pattern to test.',
					),
				);

				// Fallback: prompt for pattern if none found
				const patternInput = await vscode.window.showInputBox({
					prompt: vscode.l10n.t('Enter regex pattern to test'),
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

				// Test the single pattern
				await testSinglePattern(pattern, flags, text, config, deps);
				return;
			}

			// If patterns found, let user select which one(s) to test
			const patternChoices = extractedPatterns.map((p) => ({
				label: `/${p.pattern}/${p.flags}`,
				description: `Line ${p.line}`,
				pattern: p.pattern,
				flags: p.flags,
			}));

			patternChoices.push({
				label: vscode.l10n.t('Test All Patterns'),
				description: `Test all ${extractedPatterns.length} patterns`,
				pattern: '',
				flags: '',
			});

			const selected = await vscode.window.showQuickPick(patternChoices, {
				placeHolder: vscode.l10n.t('Select a pattern to test against the file'),
			});

			if (!selected) {
				return;
			}

			try {
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: vscode.l10n.t('Testing regex pattern...'),
						cancellable: false,
					},
					async (progress) => {
						if (selected.pattern !== '') {
							// Test the single selected pattern
							progress.report({ increment: 50 });
							await testSinglePattern(
								selected.pattern,
								selected.flags,
								text,
								config,
								deps,
							);
							progress.report({ increment: 100 });
							return;
						}

						// Test all patterns
						await testAllPatterns(
							extractedPatterns,
							text,
							config,
							deps,
							progress,
						);
					},
				);
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				deps.notifier.showError(
					sanitizeErrorMessage(`Testing failed: ${errorMessage}`),
				);
				deps.telemetry.event('test-failed', { error: errorMessage });
			}
		},
	);

	context.subscriptions.push(disposable);
}
