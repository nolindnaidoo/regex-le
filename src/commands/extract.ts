import * as vscode from 'vscode';
import { getConfiguration } from '../config/config';
import { extractRegexPatterns } from '../extraction/regex/extractPatterns';
import type { Telemetry } from '../telemetry/telemetry';
import type { Notifier } from '../ui/notifier';
import type { StatusBar } from '../ui/statusBar';
import { handleSafetyChecks } from '../utils/safety';

/**
 * Register the regex extract command
 * Extracts all regex patterns from the active editor
 */
export function registerExtractCommand(
	context: vscode.ExtensionContext,
	deps: Readonly<{
		telemetry: Telemetry;
		notifier: Notifier;
		statusBar: StatusBar;
	}>,
): void {
	const disposable = vscode.commands.registerCommand(
		'regex-le.extract',
		async (): Promise<void> => {
			deps.telemetry.event('command-extract');

			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				deps.notifier.showWarning(
					'No active editor. Please open a file first.',
				);
				return;
			}

			const config = getConfiguration();
			const document = editor.document;

			// Perform safety checks
			const safetyResult = handleSafetyChecks(document, config);
			if (!safetyResult.proceed) {
				if (safetyResult.error) {
					await deps.notifier.showEnhancedError(safetyResult.error);
				} else {
					deps.notifier.showError(safetyResult.message);
				}
				return;
			}

			try {
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: 'Extracting regex patterns...',
						cancellable: false,
					},
					async (_progress, token): Promise<void> => {
						if (token.isCancellationRequested) return;

						const text = document.getText();

						// Extract regex patterns from the file
						const patterns = extractRegexPatterns(text);

						if (token.isCancellationRequested) return;

						if (patterns.length === 0) {
							deps.notifier.showInfo('No regex patterns found in the file.');
							return;
						}

						// Format results - one pattern per line
						const outputLines: string[] = [];
						for (const pattern of patterns) {
							// Format as /pattern/flags with line number
							const formatted = `/${pattern.pattern}/${pattern.flags}`;
							outputLines.push(formatted);
						}

						const output = outputLines.join('\n');

						// Open result document side-by-side
						const doc = await vscode.workspace.openTextDocument({
							content: output,
							language: 'plaintext',
						});

						const viewColumn = config.openResultsSideBySide
							? vscode.ViewColumn.Beside
							: vscode.ViewColumn.Active;

						await vscode.window.showTextDocument(doc, viewColumn);

						// Copy to clipboard if enabled
						if (config.copyToClipboardEnabled) {
							try {
								await vscode.env.clipboard.writeText(output);
								deps.statusBar.updateText(
									`Extracted ${patterns.length} patterns to clipboard`,
								);
							} catch {
								// Ignore clipboard errors
							}
						} else {
							deps.statusBar.updateText(
								`Extracted ${patterns.length} patterns`,
							);
						}

						deps.telemetry.event('extract-completed', {
							matchCount: patterns.length,
						});

						if (config.notificationsLevel === 'all') {
							deps.notifier.showInfo(
								`Extracted ${patterns.length} regex patterns`,
							);
						}
					},
				);
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				deps.notifier.showError(`Extraction failed: ${errorMessage}`);
				deps.telemetry.event('extract-failed', { error: errorMessage });
			}
		},
	);

	context.subscriptions.push(disposable);
}
