import * as vscode from 'vscode';
import { getConfiguration } from '../config/config';
import { decide } from '../extraction/regex/ambiguity';
import {
	type ExtractedRegexPattern,
	extractRegexPatterns,
} from '../extraction/regex/extractPatterns';
import { isWellFormed } from '../extraction/regex/heuristics';
import { estimatePatternComplexity } from '../extraction/regex/performance';
import { detectReDoS } from '../extraction/regex/redos';
import { resolveFormat } from '../mcp/fileType';
import {
	listFiles,
	type ScanLimits,
	type ScanSummary,
	scanFiles,
	unreadNotes,
} from '../workspace/scan';
import {
	askForFolder,
	code,
	deliver,
	hasSomethingToScan,
	limitsFrom,
	type WorkspaceDeps,
} from './workspaceShared';

/** One pattern and what validating it found. */
export interface Checked {
	readonly pattern: ExtractedRegexPattern;
	/**
	 * Why the search for a hang could not answer for this pattern: it uses a
	 * backreference or a lookaround, which the search cannot decide either
	 * way.
	 *
	 * **This is not a verdict on the pattern**, and it is not about which
	 * language wrote it. A Python named group or a possessive quantifier is
	 * read through `isWellFormed`, as the extractor and the search read it.
	 */
	readonly unchecked: string | undefined;
	/** Set when an input was found that drives the pattern into backtracking. */
	readonly hang:
		| { readonly severity: string; readonly reason: string }
		| undefined;
	readonly complexity: number;
}

export interface FileFindings {
	readonly file: string;
	/** The patterns this report lists for the file, which may be fewer than it holds. */
	readonly rows: readonly Checked[];
	readonly patterns: number;
	readonly hang: number;
	readonly unchecked: number;
}

type Scanned = FileFindings & {
	readonly uri: vscode.Uri;
	readonly findings: readonly Checked[];
};

function hasFinding(row: Checked): boolean {
	return row.hang !== undefined;
}

/** What Validate decides for one pattern, without the report around it. */
export function check(pattern: ExtractedRegexPattern, redos: boolean): Checked {
	// The same judge the extractor and the hang search use. `new RegExp`
	// alone would refuse a pattern written for another language's engine.
	const readable = isWellFormed(pattern.pattern, pattern.flags);
	const found =
		redos && readable ? detectReDoS(pattern.pattern, pattern.flags) : undefined;
	const decision =
		found !== undefined && !found.detected
			? decide(pattern.pattern)
			: undefined;
	const unchecked = !readable
		? 'not a pattern this can read'
		: decision?.kind === 'undecided'
			? decision.reason
			: undefined;
	return {
		pattern,
		unchecked,
		hang: found?.detected
			? { severity: found.severity, reason: found.reason }
			: undefined,
		complexity: estimatePatternComplexity(pattern.pattern).score,
	};
}

export function registerValidateWorkspaceCommands(
	context: vscode.ExtensionContext,
	deps: WorkspaceDeps,
): void {
	const diagnostics = vscode.languages.createDiagnosticCollection('regex-le');
	context.subscriptions.push(
		diagnostics,
		vscode.commands.registerCommand('regex-le.validateWorkspace', async () =>
			validateWorkspace(deps, diagnostics),
		),
		// The Explorer hands over the folder that was clicked. From the
		// palette there is none, and the command asks.
		vscode.commands.registerCommand(
			'regex-le.validateFolder',
			async (picked?: vscode.Uri) => {
				const folder = picked ?? (await askForFolder());
				if (folder !== undefined)
					await validateWorkspace(deps, diagnostics, folder);
			},
		),
	);
}

/**
 * Validate every pattern in every source file under a folder, or in the
 * whole workspace when no folder is given.
 *
 * Files are read from disk, so an unsaved edit is not seen: this reports what
 * the project holds, where Validate reports what the editor holds.
 */
async function validateWorkspace(
	deps: WorkspaceDeps,
	diagnostics: vscode.DiagnosticCollection,
	root?: vscode.Uri,
): Promise<void> {
	deps.telemetry.event(
		root === undefined
			? 'command-validate-workspace'
			: 'command-validate-folder',
	);
	if (!hasSomethingToScan(root, deps)) return;
	const config = getConfiguration();
	const limits = limitsFrom(config);

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: vscode.l10n.t('Scanning files...'),
			cancellable: true,
		},
		async (progress, token) => {
			const { files, fileLimitReached, ignored } = await listFiles(
				root,
				limits,
			);
			const found: Scanned[] = [];
			let total = 0;
			const scanned = await scanFiles(
				root,
				files,
				limits,
				token,
				(done, all) =>
					progress.report({
						message: vscode.l10n.t('{0} of {1} files', done, all),
					}),
				({ uri, file, text }) => {
					const all = extractRegexPatterns(
						text,
						resolveFormat(undefined, file),
					).map((pattern) => check(pattern, config.regexRedosDetectionEnabled));
					if (all.length === 0) return true;
					const findings = all.filter(hasFinding);
					// The limit is on what the report lists. A project's
					// sound patterns are counted either way.
					const rows = (
						config.workspaceScanIncludePassing ? all : findings
					).slice(0, config.workspaceScanMaxResults - total);
					found.push({
						uri,
						file,
						rows,
						findings,
						patterns: all.length,
						hang: findings.length,
						unchecked: all.filter((row) => row.unchecked !== undefined).length,
					});
					total += rows.length;
					return total < config.workspaceScanMaxResults;
				},
			);
			// A cancelled scan read part of the tree. Reporting that as the
			// project's patterns would understate it without saying so.
			if (scanned.cancelled) return;
			const summary: ScanSummary = { ...scanned, fileLimitReached, ignored };

			// Each scan replaces the last one's problems, and a scan that
			// publishes none still clears them.
			publish(diagnostics, config.workspaceScanProblemsEnabled ? found : []);
			const where =
				root === undefined
					? undefined
					: vscode.workspace.asRelativePath(root, false);
			const report = (positions: boolean): string =>
				formatValidateWorkspaceReport({
					where,
					files: found,
					summary,
					limits,
					passingListed: config.workspaceScanIncludePassing,
					redos: config.regexRedosDetectionEnabled,
					positions,
				});
			await deliver(report, config, deps);

			const count = (key: 'patterns' | 'hang' | 'unchecked') =>
				found.reduce((sum, entry) => sum + entry[key], 0);
			deps.telemetry.event('validate-workspace-completed', {
				files: summary.read,
				patterns: count('patterns'),
				hang: count('hang'),
				unchecked: count('unchecked'),
			});
			deps.statusBar.updateText(
				vscode.l10n.t(
					'{0} pattern(s), {1} can hang, {2} not checked',
					count('patterns'),
					count('hang'),
					count('unchecked'),
				),
			);
			if (count('hang') > 0) {
				deps.notifier.showWarning(
					vscode.l10n.t(
						'{0} pattern(s) that can hang in {1} file(s)',
						count('hang'),
						found.filter((entry) => entry.findings.length > 0).length,
					),
				);
			}
		},
	);
}

/** The patterns that can hang, in the Problems panel. */
function publish(
	diagnostics: vscode.DiagnosticCollection,
	found: readonly Scanned[],
): void {
	diagnostics.clear();
	for (const { uri, findings } of found) {
		if (findings.length === 0) continue;
		diagnostics.set(
			uri,
			findings.map((row) => {
				const start = new vscode.Position(
					row.pattern.line - 1,
					row.pattern.column - 1,
				);
				const diagnostic = new vscode.Diagnostic(
					new vscode.Range(start, start.translate(0, row.pattern.match.length)),
					verdict(row),
					vscode.DiagnosticSeverity.Warning,
				);
				diagnostic.source = 'regex-le';
				return diagnostic;
			}),
		);
	}
}

function verdict(row: Checked): string {
	if (row.hang !== undefined)
		return `${vscode.l10n.t('can hang')} (${row.hang.severity}): ${row.hang.reason}`;
	if (row.unchecked !== undefined)
		return `${vscode.l10n.t('not checked')}: ${row.unchecked}`;
	return vscode.l10n.t('no finding');
}

export interface ValidateWorkspaceReportInput {
	/** The folder that was scanned, or undefined for the whole workspace. */
	readonly where: string | undefined;
	readonly files: readonly FileFindings[];
	readonly summary: ScanSummary;
	readonly limits: ScanLimits;
	/** Whether patterns with no finding are listed, or only counted. */
	readonly passingListed: boolean;
	/** Whether the hang search ran. When it did not, its column says nothing. */
	readonly redos: boolean;
	readonly positions?: boolean;
}

/**
 * The report for a folder or a workspace.
 *
 * It opens with a table of the files that hold something to look at, because
 * a project has too many to find by scrolling. Then one section per file that
 * has something to list, in path order, and last whatever the scan left
 * unread.
 */
export function formatValidateWorkspaceReport({
	where,
	files,
	summary,
	limits,
	passingListed,
	redos,
	positions = true,
}: ValidateWorkspaceReportInput): string {
	const count = (key: 'patterns' | 'hang' | 'unchecked') =>
		files.reduce((sum, entry) => sum + entry[key], 0);
	const lines: string[] = [
		`# ${vscode.l10n.t('{0} workspace report', 'Regex-LE')}`,
		'',
	];
	const scope = where === undefined ? '' : `${code(where)} · `;
	lines.push(
		`${scope}${vscode.l10n.t('{0} file(s) read', summary.read)} · ${vscode.l10n.t('{0} pattern(s), {1} can hang, {2} not checked', count('patterns'), count('hang'), count('unchecked'))}`,
		'',
	);
	if (files.length === 0) lines.push(vscode.l10n.t('No patterns found.'), '');

	// A project's sound files would fill the table and hide the few that are
	// not. They are counted in one line unless every pattern is being listed.
	const tabled = passingListed
		? files
		: files.filter((entry) => entry.hang + entry.unchecked > 0);
	if (tabled.length > 0) {
		lines.push(
			`| ${vscode.l10n.t('File')} | ${vscode.l10n.t('Patterns')} | ${vscode.l10n.t('Can hang')} | ${vscode.l10n.t('Not checked')} |`,
			'|---|---|---|---|',
		);
		for (const entry of tabled)
			lines.push(
				`| ${code(entry.file).replace(/\|/g, '\\|')} | ${entry.patterns} | ${redos ? entry.hang : '—'} | ${entry.unchecked} |`,
			);
		lines.push('');
	}
	if (!redos)
		lines.push(
			`> ${vscode.l10n.t('The search for patterns that can hang is off. The {0} setting turns it on.', code('regex-le.regex.redosDetectionEnabled'))}`,
			'',
		);
	if (files.length > tabled.length)
		lines.push(
			`> ${vscode.l10n.t('{0} other file(s) hold only patterns with no finding.', files.length - tabled.length)}`,
			'',
		);
	if (count('patterns') > count('hang') && !passingListed)
		lines.push(
			`> ${vscode.l10n.t('Only patterns that can hang are listed. The rest are counted per file, and the {0} setting lists each one.', code('regex-le.workspace.scanIncludePassing'))}`,
			'',
		);

	for (const entry of files) {
		if (entry.rows.length === 0) continue;
		lines.push(`## ${code(entry.file)} (${entry.rows.length})`, '');
		for (const row of entry.rows) {
			const where = positions
				? `**${row.pattern.line}:${row.pattern.column}** · `
				: '';
			lines.push(
				`- ${where}${code(`/${row.pattern.pattern}/${row.pattern.flags}`)} · ${verdict(row)} · ${vscode.l10n.t('complexity {0}/100', row.complexity)}`,
			);
		}
		lines.push('');
	}

	const notes = unreadNotes(summary, limits, code('regex-le.workspace.*'));
	if (notes.length > 0) lines.push(...notes.map((note) => `> ${note}`), '');
	return lines.join('\n');
}
