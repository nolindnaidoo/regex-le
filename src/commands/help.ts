import * as vscode from 'vscode';
import type { Telemetry } from '../telemetry/telemetry';

/**
 * Register help command to show documentation
 */
export function registerHelpCommand(
	context: vscode.ExtensionContext,
	telemetry: Telemetry,
): void {
	const disposable = vscode.commands.registerCommand(
		'regex-le.help',
		async () => {
			telemetry.event('help-opened');

			const helpContent = buildHelpContent();

			const doc = await vscode.workspace.openTextDocument({
				content: helpContent,
				language: 'markdown',
			});

			await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
		},
	);

	context.subscriptions.push(disposable);
}

function buildHelpContent(): string {
	const title = 'Regex-LE Help';
	const quickStart =
		'1. Open a file with text content\n2. Run "Regex-LE: Test Regex" (Ctrl+Alt+R / Cmd+Alt+R)\n3. Enter a regex pattern\n4. View results with matches and performance metrics';
	const commands =
		'**Test**: Test a regex pattern against the active editor content\n**Extract**: Extract all regex patterns from the active editor\n**Validate**: Validate a regex pattern and check for ReDoS vulnerabilities\n**Settings**: Configure extension options';
	const troubleshooting =
		'**No matches found?** Check your pattern syntax and flags\n**ReDoS warnings?** Review the pattern for nested quantifiers or exponential backtracking\n**Need help?** Check Output panel for details';
	const settings =
		'Access via Command Palette: "Regex-LE: Open Settings"\nKey settings: ReDoS detection, match limits, safety thresholds, notification level';
	const support =
		"- GitHub Issues: https://github.com/nolindnaidoo/regex-le/issues\n- Documentation: https://github.com/nolindnaidoo/regex-le#readme\n- LE Tools: https://letools.dev\n\nEnjoying it? A rating helps more than you'd think:\n- Rate on VS Code Marketplace: https://marketplace.visualstudio.com/items?itemName=nolindnaidoo.regex-le&ssr=false#review-details\n- Rate on Open VSX: https://open-vsx.org/extension/OffensiveEdge/regex-le/reviews\n\nBuilt by nolindnaidoo (https://github.com/nolindnaidoo) — MIT licensed.";

	return `# ${title}

## Quick Start

${quickStart}

## Commands

${commands}

## Troubleshooting

${troubleshooting}

## Settings

${settings}

## Support

${support}
`;
}
