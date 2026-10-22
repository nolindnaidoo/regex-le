import * as vscode from 'vscode';
import { guarded } from '../commands/guard';
import type { Telemetry } from '../telemetry/telemetry';
import { createNotifier } from '../ui/notifier';

/**
 * Register command to open extension settings
 */
export function registerOpenSettingsCommand(
	context: vscode.ExtensionContext,
	telemetry: Telemetry,
): void {
	const command = vscode.commands.registerCommand(
		'regex-le.openSettings',
		guarded(createNotifier(), async () => {
			telemetry.event('command-open-settings');
			await vscode.commands.executeCommand(
				'workbench.action.openSettings',
				'regex-le',
			);
		}),
	);

	context.subscriptions.push(command);
}
