import * as vscode from 'vscode';
import type { Telemetry } from '../telemetry/telemetry';
import type { Configuration } from '../types';
import type { Notifier } from '../ui/notifier';
import type { RatingPrompt } from '../ui/ratingPrompt';
import type { StatusBar } from '../ui/statusBar';
import type { ScanLimits } from '../workspace/scan';

/** What the commands that read a folder have in common. */

export type WorkspaceDeps = Readonly<{
	telemetry: Telemetry;
	notifier: Notifier;
	statusBar: StatusBar;
	ratingPrompt: RatingPrompt;
}>;

export function limitsFrom(config: Configuration): ScanLimits {
	return {
		patterns: config.workspaceScanPatterns,
		excludes: config.workspaceScanExcludes,
		useDefaultExcludes: config.workspaceScanUseDefaultExcludes,
		skipBinaryFiles: config.workspaceScanSkipBinaryFiles,
		alwaysInclude: config.workspaceScanAlwaysInclude,
		maxFiles: config.workspaceScanMaxFiles,
		maxFileBytes: config.safetyEnabled
			? config.safetyFileSizeWarnBytes
			: undefined,
		respectGitignore: config.workspaceScanRespectGitignore,
	};
}

/** False, with the warning shown, when there is nothing to scan. */
export function hasSomethingToScan(
	root: vscode.Uri | undefined,
	deps: WorkspaceDeps,
): boolean {
	if (
		root !== undefined ||
		(vscode.workspace.workspaceFolders ?? []).length > 0
	)
		return true;
	deps.notifier.showWarning(
		vscode.l10n.t('No workspace open. Please open a workspace folder first.'),
	);
	return false;
}

export async function askForFolder(): Promise<vscode.Uri | undefined> {
	const start = vscode.workspace.workspaceFolders?.[0]?.uri;
	const chosen = await vscode.window.showOpenDialog({
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
		...(start === undefined ? {} : { defaultUri: start }),
		openLabel: vscode.l10n.t('Scan Folder'),
	});
	return chosen?.[0];
}

/** Copy first, then open, as the single-file commands do, and for their reason. */
export async function deliver(
	report: (positions: boolean) => string,
	config: Configuration,
	deps: WorkspaceDeps,
): Promise<void> {
	if (config.copyToClipboardEnabled) {
		try {
			await vscode.env.clipboard.writeText(
				report(config.clipboardIncludesPositions),
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			deps.notifier.showWarning(
				vscode.l10n.t(
					'Could not copy the report to the clipboard: {0}',
					message,
				),
			);
		}
	}
	const document = await vscode.workspace.openTextDocument({
		content: report(config.showPositions),
		language: 'markdown',
	});
	await vscode.window.showTextDocument(
		document,
		config.openResultsSideBySide
			? vscode.ViewColumn.Beside
			: vscode.ViewColumn.Active,
	);
	// Not awaited: it resolves when the toast is answered, and a command that
	// waited on that would stay pending for as long as the toast is ignored.
	void deps.ratingPrompt.recordSuccess();
}

/** Text as a code span. A code span cannot escape a backtick, so one becomes a quote. */
export function code(text: string): string {
	return `\`${text.replace(/`/g, "'").replace(/\r?\n/g, ' ')}\``;
}
