import * as vscode from 'vscode';
import { getConfiguration } from '../config/config';
import { extractRegexPatterns } from '../extraction/regex/extractPatterns';
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

/** One place a pattern is written. */
export interface Occurrence {
	readonly file: string;
	readonly line: number;
	readonly column: number;
}

/** A pattern, and every file it was found in. */
export interface DistinctPattern {
	/** As Extract prints it: `/pattern/flags`. */
	readonly text: string;
	readonly occurrences: readonly Occurrence[];
}

export function registerExtractWorkspaceCommands(
	context: vscode.ExtensionContext,
	deps: WorkspaceDeps,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('regex-le.extractWorkspace', async () =>
			extractWorkspace(deps),
		),
		// The Explorer hands over the folder that was clicked. From the
		// palette there is none, and the command asks.
		vscode.commands.registerCommand(
			'regex-le.extractFolder',
			async (picked?: vscode.Uri) => {
				const folder = picked ?? (await askForFolder());
				if (folder !== undefined) await extractWorkspace(deps, folder);
			},
		),
	);
}

/**
 * Extract every pattern in every source file under a folder, or in the whole
 * workspace when no folder is given.
 *
 * A project writes the same pattern in many places, so the answer is the
 * distinct patterns and where each one is, not one long list. Files are read
 * from disk, so an unsaved edit is not seen.
 */
async function extractWorkspace(
	deps: WorkspaceDeps,
	root?: vscode.Uri,
): Promise<void> {
	deps.telemetry.event(
		root === undefined ? 'command-extract-workspace' : 'command-extract-folder',
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
			const found = new Map<string, Occurrence[]>();
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
				({ file, text }) => {
					// The extractor reports a pattern once per file, at the first
					// place it is written there.
					for (const pattern of extractRegexPatterns(
						text,
						resolveFormat(undefined, file),
					)) {
						if (total >= config.workspaceScanMaxResults) return false;
						const key = `/${pattern.pattern}/${pattern.flags}`;
						const where = found.get(key);
						const occurrence = {
							file,
							line: pattern.line,
							column: pattern.column,
						};
						if (where === undefined) found.set(key, [occurrence]);
						else where.push(occurrence);
						total++;
					}
					return total < config.workspaceScanMaxResults;
				},
			);
			// A cancelled scan read part of the tree. Reporting that as the
			// project's patterns would understate it without saying so.
			if (scanned.cancelled) return;
			const summary: ScanSummary = { ...scanned, fileLimitReached, ignored };

			const patterns = distinct(found);
			const where =
				root === undefined
					? undefined
					: vscode.workspace.asRelativePath(root, false);
			await deliver(
				(positions) =>
					formatExtractWorkspaceReport({
						where,
						patterns,
						summary,
						limits,
						positions,
					}),
				config,
				deps,
			);

			deps.telemetry.event('extract-workspace-completed', {
				files: summary.read,
				patterns: patterns.length,
				occurrences: total,
			});
			deps.statusBar.updateText(
				vscode.l10n.t(
					'{0} distinct pattern(s) in {1} file(s)',
					patterns.length,
					filesHolding(patterns),
				),
			);
		},
	);
}

/**
 * The most widely used first, then by the pattern's own text.
 *
 * A plain comparison rather than `localeCompare`: the order must not change
 * with the editor's display language.
 */
function distinct(found: ReadonlyMap<string, Occurrence[]>): DistinctPattern[] {
	return [...found]
		.map(([text, occurrences]) => ({ text, occurrences }))
		.sort(
			(a, b) =>
				b.occurrences.length - a.occurrences.length ||
				(a.text < b.text ? -1 : Number(a.text > b.text)),
		);
}

function filesHolding(patterns: readonly DistinctPattern[]): number {
	return new Set(
		patterns.flatMap((pattern) => pattern.occurrences.map((o) => o.file)),
	).size;
}

export interface ExtractWorkspaceReportInput {
	/** The folder that was scanned, or undefined for the whole workspace. */
	readonly where: string | undefined;
	readonly patterns: readonly DistinctPattern[];
	readonly summary: ScanSummary;
	readonly limits: ScanLimits;
	readonly positions?: boolean;
}

/**
 * The report for a folder or a workspace: a table of the distinct patterns
 * with how many files hold each, then where each one is, and last whatever
 * the scan left unread.
 */
export function formatExtractWorkspaceReport({
	where,
	patterns,
	summary,
	limits,
	positions = true,
}: ExtractWorkspaceReportInput): string {
	const lines: string[] = [
		`# ${vscode.l10n.t('{0} workspace report', 'Regex-LE')}`,
		'',
	];
	const scope = where === undefined ? '' : `${code(where)} · `;
	lines.push(
		`${scope}${vscode.l10n.t('{0} file(s) read', summary.read)} · ${vscode.l10n.t('{0} distinct pattern(s) in {1} file(s)', patterns.length, filesHolding(patterns))}`,
		'',
	);
	if (patterns.length === 0)
		lines.push(vscode.l10n.t('No patterns found.'), '');

	if (patterns.length > 0) {
		lines.push(
			`| ${vscode.l10n.t('Pattern')} | ${vscode.l10n.t('Files')} |`,
			'|---|---|',
		);
		for (const pattern of patterns)
			lines.push(
				`| ${code(pattern.text).replace(/\|/g, '\\|')} | ${pattern.occurrences.length} |`,
			);
		lines.push('');
	}

	for (const pattern of patterns) {
		lines.push(`## ${code(pattern.text)} (${pattern.occurrences.length})`, '');
		for (const occurrence of pattern.occurrences)
			lines.push(
				positions
					? `- ${code(occurrence.file)} · **${occurrence.line}:${occurrence.column}**`
					: `- ${code(occurrence.file)}`,
			);
		lines.push('');
	}

	const notes = unreadNotes(summary, limits, code('regex-le.workspace.*'));
	if (notes.length > 0) lines.push(...notes.map((note) => `> ${note}`), '');
	return lines.join('\n');
}
