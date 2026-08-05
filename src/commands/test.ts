import * as vscode from 'vscode';
import { getConfiguration } from '../config/config';
import { extractRegexPatterns } from '../extraction/regex/extractPatterns';
import { calculatePerformanceScore } from '../extraction/regex/performance';
import { detectReDoS } from '../extraction/regex/redos';
import { testRegexWithPerformance } from '../extraction/regex/regexTest';
import type { Telemetry } from '../telemetry/telemetry';
import type { Notifier } from '../ui/notifier';
import type { StatusBar } from '../ui/statusBar';
import { sanitizeErrorMessage } from '../utils/errors';
import { handleSafetyChecks } from '../utils/safety';

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
			const extractedPatterns = extractRegexPatterns(text);

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
						if (selected.pattern === '') {
							// Test all patterns
							await testAllPatterns(
								extractedPatterns,
								text,
								config,
								deps,
								progress,
							);
						} else {
							// Test single selected pattern
							progress.report({ increment: 50 });
							await testSinglePattern(
								selected.pattern,
								selected.flags,
								text,
								config,
								deps,
							);
							progress.report({ increment: 100 });
						}
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

async function testSinglePattern(
	pattern: string,
	flags: string,
	text: string,
	config: ReturnType<typeof getConfiguration>,
	deps: {
		telemetry: Telemetry;
		notifier: Notifier;
		statusBar: StatusBar;
	},
): Promise<void> {
	const startTime = performance.now();

	// Check for ReDoS if enabled
	let redosResult;
	if (config.regexRedosDetectionEnabled) {
		redosResult = detectReDoS(pattern, flags);
		if (redosResult.detected && redosResult.severity === 'high') {
			const proceed = await vscode.window.showWarningMessage(
				`ReDoS vulnerability detected: ${redosResult.reason}. Continue?`,
				{ modal: true },
				'Proceed',
				'Cancel',
			);

			if (proceed !== 'Proceed') {
				return;
			}
		}
	} else {
		redosResult = {
			detected: false,
			severity: 'low' as const,
			reason: '',
		};
	}

	const testResult = await testRegexWithPerformance(
		pattern,
		flags,
		text,
		config.regexMaxMatchLimit,
		startTime,
	);

	let performanceScore;
	if (testResult.performance) {
		performanceScore = calculatePerformanceScore(
			testResult.performance,
			text.length,
		);
	}

	// Build result report
	const reportLines: string[] = [];
	reportLines.push('# Regex Test Results');
	reportLines.push('');
	reportLines.push(`**Pattern:** \`/${pattern}/${flags}\``);
	reportLines.push('');

	if (testResult.success) {
		reportLines.push(`**Status:** ✅ Success`);
		reportLines.push(`**Matches Found:** ${testResult.matches.length}`);
		reportLines.push('');

		if (testResult.matches.length > 0) {
			reportLines.push('## Matches');
			reportLines.push('');

			const maxMatchesToShow = Math.min(testResult.matches.length, 100);
			for (let i = 0; i < maxMatchesToShow; i++) {
				const match = testResult.matches[i];
				if (match) {
					reportLines.push(
						`${i + 1}. \`${match.match}\` at position ${match.index}`,
					);
					if (match.line !== undefined) {
						reportLines.push(
							`   Line ${match.line}, Column ${match.column || 0}`,
						);
					}
				}
			}

			if (testResult.matches.length > maxMatchesToShow) {
				reportLines.push(
					`\n... and ${testResult.matches.length - maxMatchesToShow} more matches`,
				);
			}
		}
	} else {
		reportLines.push(`**Status:** ❌ Failed`);
		if (testResult.errors.length > 0) {
			reportLines.push('');
			reportLines.push('## Errors');
			for (const error of testResult.errors) {
				reportLines.push(`- ${error.message}`);
			}
		}
	}

	if (redosResult.detected) {
		reportLines.push('');
		reportLines.push(`## ⚠️ ReDoS Detection`);
		reportLines.push(`**Severity:** ${redosResult.severity}`);
		reportLines.push(`**Reason:** ${redosResult.reason}`);
	}

	if (performanceScore) {
		reportLines.push('');
		reportLines.push('## Performance Score');
		reportLines.push(`**Overall:** ${performanceScore.overall.toFixed(1)}/100`);
		reportLines.push(
			`**Complexity:** ${performanceScore.complexity.toFixed(1)}/100`,
		);
		reportLines.push(
			`**Execution Time:** ${performanceScore.executionTime.toFixed(1)}/100`,
		);
		reportLines.push(
			`**Memory Usage:** ${performanceScore.memoryUsage.toFixed(1)}/100`,
		);
		reportLines.push(`**Description:** ${performanceScore.description}`);
	}

	if (testResult.performance) {
		reportLines.push('');
		reportLines.push('## Performance Metrics');
		reportLines.push(
			`**Duration:** ${testResult.performance.duration.toFixed(2)}ms`,
		);
		reportLines.push(
			`**Input Size:** ${testResult.performance.inputSize} characters`,
		);
		reportLines.push(`**Matches:** ${testResult.performance.itemCount}`);
	}

	const report = reportLines.join('\n');

	// Copy to clipboard if enabled
	if (config.copyToClipboardEnabled) {
		await vscode.env.clipboard.writeText(report);
	}

	// Open result document
	const doc = await vscode.workspace.openTextDocument({
		content: report,
		language: 'markdown',
	});

	const viewColumn = config.openResultsSideBySide
		? vscode.ViewColumn.Beside
		: vscode.ViewColumn.Active;

	await vscode.window.showTextDocument(doc, viewColumn);

	deps.telemetry.event('test-completed', {
		success: testResult.success,
		matchCount: testResult.matches.length,
		redosDetected: redosResult.detected,
	});
}

async function testAllPatterns(
	patterns: ReturnType<typeof extractRegexPatterns>,
	text: string,
	config: ReturnType<typeof getConfiguration>,
	deps: {
		telemetry: Telemetry;
		notifier: Notifier;
		statusBar: StatusBar;
	},
	progress: vscode.Progress<{ message?: string; increment?: number }>,
): Promise<void> {
	const reportLines: string[] = [];
	reportLines.push('# Regex Test Results - All Patterns');
	reportLines.push('');

	for (let i = 0; i < patterns.length; i++) {
		const p = patterns[i];
		if (!p) continue;

		progress.report({
			message: vscode.l10n.t(
				'Testing pattern {0}/{1}: {2}',
				i + 1,
				patterns.length,
				`/${p.pattern}/${p.flags}`,
			),
			increment: (100 / patterns.length) * i,
		});

		const startTime = performance.now();
		const testResult = await testRegexWithPerformance(
			p.pattern,
			p.flags,
			text,
			config.regexMaxMatchLimit,
			startTime,
		);

		reportLines.push(`## Pattern ${i + 1}: \`/${p.pattern}/${p.flags}\``);
		reportLines.push(`**Line:** ${p.line}`);
		reportLines.push(
			`**Status:** ${testResult.success ? '✅ Success' : '❌ Failed'}`,
		);
		reportLines.push(`**Matches:** ${testResult.matches.length}`);
		if (testResult.performance) {
			reportLines.push(
				`**Duration:** ${testResult.performance.duration.toFixed(2)}ms`,
			);
		}
		reportLines.push('');
	}

	const report = reportLines.join('\n');

	// Open result document
	const doc = await vscode.workspace.openTextDocument({
		content: report,
		language: 'markdown',
	});

	const viewColumn = config.openResultsSideBySide
		? vscode.ViewColumn.Beside
		: vscode.ViewColumn.Active;

	await vscode.window.showTextDocument(doc, viewColumn);

	deps.telemetry.event('test-all-completed', {
		patternCount: patterns.length,
	});
}
