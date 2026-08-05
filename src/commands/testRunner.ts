import * as vscode from 'vscode';
import { NO_REDOS_FINDING } from '../analysis/noFinding';
import type { getConfiguration } from '../config/config';
import type { extractRegexPatterns } from '../extraction/regex/extractPatterns';
import { calculatePerformanceScore } from '../extraction/regex/performance';
import { detectReDoS } from '../extraction/regex/redos';
import { testRegexWithPerformance } from '../extraction/regex/regexTest';
import type { Telemetry } from '../telemetry/telemetry';
import type { Notifier } from '../ui/notifier';
import type { StatusBar } from '../ui/statusBar';

/**
 * Running regex tests and rendering their reports.
 *
 * Split from the command file, which held registration, prompting, the run
 * itself and the report in one place.
 */

export async function testSinglePattern(
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
	}
	redosResult ??= NO_REDOS_FINDING;

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
				if (!match) continue;
				reportLines.push(
					`${i + 1}. \`${match.match}\` at position ${match.index}`,
				);
				if (match.line !== undefined) {
					reportLines.push(
						`   Line ${match.line}, Column ${match.column || 0}`,
					);
				}
			}

			if (testResult.matches.length > maxMatchesToShow) {
				reportLines.push(
					`\n... and ${testResult.matches.length - maxMatchesToShow} more matches`,
				);
			}
		}
	}
	if (!testResult.success) {
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

	// Copy to clipboard if enabled. The copy runs before the results document
	// opens, so an unavailable clipboard — a remote or headless session — used
	// to abort the whole command and cost the user the results over an optional
	// convenience.
	if (config.copyToClipboardEnabled) {
		try {
			await vscode.env.clipboard.writeText(report);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			deps.notifier.showWarning(
				vscode.l10n.t(
					'Could not copy the test report to the clipboard: {0}',
					message,
				),
			);
		}
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

export async function testAllPatterns(
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
