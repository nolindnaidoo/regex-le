import * as vscode from 'vscode';
import { NO_REDOS_FINDING } from '../analysis/noFinding';
import { getConfiguration } from '../config/config';
import type { extractRegexPatterns } from '../extraction/regex/extractPatterns';
import { estimatePatternComplexity } from '../extraction/regex/performance';
import { detectReDoS } from '../extraction/regex/redos';
import type { Telemetry } from '../telemetry/telemetry';
import type { Notifier } from '../ui/notifier';
import type { StatusBar } from '../ui/statusBar';

/**
 * The recommendation section, in priority order.
 *
 * Was a four-arm else-if chain whose conditions each repeated `isValid`;
 * ordered guards say the same thing without restating the predicate.
 */
function recommendation(
	isValid: boolean,
	redosDetected: boolean,
	performanceScore: number,
): readonly string[] {
	if (!isValid) {
		return [
			'## ❌ Recommendation',
			'This pattern has syntax errors and cannot be used.',
		];
	}
	if (redosDetected) {
		return [
			'## ⚠️ Recommendation',
			'This pattern is valid but may be vulnerable to ReDoS attacks. Consider refactoring.',
		];
	}
	if (performanceScore < 70) {
		return [
			'## ⚠️ Recommendation',
			'This pattern is valid but may have performance issues. Consider optimization.',
		];
	}
	return [
		'## ✅ Recommendation',
		'No known vulnerable shapes were detected and the pattern scores well ' +
			'on complexity. This scanner recognises common catastrophic-backtracking ' +
			'shapes; it cannot prove a pattern safe against adversarial input.',
	];
}

/**
 * Running regex validation and rendering its report.
 *
 * Split from the command file, which held registration, prompting, the run
 * itself and the report in one place.
 */

export async function validateSinglePattern(
	pattern: string,
	flags: string,
	deps: {
		telemetry: Telemetry;
		notifier: Notifier;
		statusBar: StatusBar;
	},
): Promise<void> {
	const config = getConfiguration();

	// Validate syntax
	let isValid = false;
	let syntaxError: string | undefined;
	try {
		new RegExp(pattern, flags);
		isValid = true;
	} catch (error) {
		syntaxError = error instanceof Error ? error.message : String(error);
	}

	// Check for ReDoS
	const redosResult = config.regexRedosDetectionEnabled
		? detectReDoS(pattern, flags)
		: NO_REDOS_FINDING;

	// Estimate complexity
	const complexity = estimatePatternComplexity(pattern);

	// Calculate performance score
	const performanceScore = isValid ? 100 - complexity.score : 0;

	// Build validation report
	const reportLines: string[] = [];
	reportLines.push('# Regex Validation Results');
	reportLines.push('');
	reportLines.push(`**Pattern:** \`/${pattern}/${flags}\``);
	reportLines.push('');

	if (isValid) {
		reportLines.push('**Status:** ✅ Valid');
	}
	if (!isValid) {
		reportLines.push('**Status:** ❌ Invalid');
		if (syntaxError) {
			reportLines.push(`**Error:** ${syntaxError}`);
		}
	}
	reportLines.push('');

	if (redosResult.detected) {
		reportLines.push('## ⚠️ ReDoS Detection');
		reportLines.push(`**Detected:** Yes`);
		reportLines.push(`**Severity:** ${redosResult.severity}`);
		reportLines.push(`**Reason:** ${redosResult.reason}`);
		reportLines.push('');
	}
	if (!redosResult.detected) {
		reportLines.push('## ✅ ReDoS Detection');
		// The detector is a structural scanner, not an automaton analysis — it
		// recognises known catastrophic shapes and cannot prove their absence.
		// Reporting "no vulnerabilities found" claimed more than it can support.
		reportLines.push('**Detected:** No known vulnerable shapes');
		reportLines.push('');
	}

	reportLines.push('## Performance Analysis');
	reportLines.push(`**Complexity Score:** ${complexity.score}/100`);
	reportLines.push(`**Performance Score:** ${performanceScore}/100`);
	if (complexity.factors.length > 0) {
		reportLines.push('');
		reportLines.push('**Complexity Factors:**');
		for (const factor of complexity.factors) {
			reportLines.push(`- ${factor}`);
		}
	}
	reportLines.push('');

	reportLines.push(
		...recommendation(isValid, redosResult.detected, performanceScore),
	);

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
					'Could not copy the validation report to the clipboard: {0}',
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

	deps.telemetry.event('validate-completed', {
		valid: isValid,
		redosDetected: redosResult.detected,
		performanceScore,
	});
}

export async function validateAllPatterns(
	patterns: ReturnType<typeof extractRegexPatterns>,
	deps: {
		telemetry: Telemetry;
		notifier: Notifier;
		statusBar: StatusBar;
	},
	progress: vscode.Progress<{ message?: string; increment?: number }>,
): Promise<void> {
	const config = getConfiguration();

	const reportLines: string[] = [];
	reportLines.push('# Regex Validation Results - All Patterns');
	reportLines.push('');
	reportLines.push(`Found ${patterns.length} pattern(s) to validate\n`);

	let validCount = 0;
	let invalidCount = 0;
	let redosCount = 0;

	for (let i = 0; i < patterns.length; i++) {
		const p = patterns[i];
		if (!p) continue;

		progress.report({
			message: vscode.l10n.t(
				'Validating pattern {0}/{1}',
				i + 1,
				patterns.length,
			),
			increment: (100 / patterns.length) * i,
		});

		// Validate syntax
		let isValid = false;
		let syntaxError: string | undefined;
		try {
			new RegExp(p.pattern, p.flags);
			isValid = true;
			validCount++;
		} catch (error) {
			syntaxError = error instanceof Error ? error.message : String(error);
			invalidCount++;
		}

		// Check for ReDoS
		let redosResult;
		if (config.regexRedosDetectionEnabled) {
			redosResult = detectReDoS(p.pattern, p.flags);
			if (redosResult.detected) {
				redosCount++;
			}
		}
		redosResult ??= NO_REDOS_FINDING;

		// Estimate complexity
		const complexity = estimatePatternComplexity(p.pattern);

		// Build report for this pattern
		reportLines.push(`## Pattern ${i + 1}: \`/${p.pattern}/${p.flags}\``);
		reportLines.push(`**Line:** ${p.line}`);
		reportLines.push(`**Status:** ${isValid ? '✅ Valid' : '❌ Invalid'}`);
		if (syntaxError) {
			reportLines.push(`**Error:** ${syntaxError}`);
		}
		if (redosResult.detected) {
			reportLines.push(
				`**⚠️ ReDoS:** ${redosResult.severity} - ${redosResult.reason}`,
			);
		}
		reportLines.push(`**Complexity:** ${complexity.score}/100`);
		reportLines.push('');
	}

	// Summary
	reportLines.push('---');
	reportLines.push('## Summary');
	reportLines.push(`**Total Patterns:** ${patterns.length}`);
	reportLines.push(`**✅ Valid:** ${validCount}`);
	reportLines.push(`**❌ Invalid:** ${invalidCount}`);
	if (config.regexRedosDetectionEnabled) {
		reportLines.push(`**⚠️ ReDoS Vulnerable:** ${redosCount}`);
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

	deps.telemetry.event('validate-all-completed', {
		totalPatterns: patterns.length,
		validCount,
		invalidCount,
		redosCount,
	});

	deps.notifier.showInfo(
		`Validated ${patterns.length} patterns: ${validCount} valid, ${invalidCount} invalid${redosCount > 0 ? `, ${redosCount} with ReDoS issues` : ''}`,
	);
}
