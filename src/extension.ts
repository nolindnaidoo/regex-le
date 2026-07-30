import type * as vscode from 'vscode';
import { registerCommands } from './commands';
import { registerOpenSettingsCommand } from './config/settings';
import { createServices } from './services/serviceFactory';

/**
 * Extension activation entry point
 * Keeps this file minimal - only register commands and providers
 */
export function activate(context: vscode.ExtensionContext): void {
	// Create all core services using the service factory
	const services = createServices(context);

	// Register commands with services
	registerCommands(context, {
		telemetry: services.telemetry,
		notifier: services.notifier,
		statusBar: services.statusBar,
	});

	// Register settings commands
	registerOpenSettingsCommand(context, services.telemetry);

	services.telemetry.event('extension-activated');
}

/**
 * Extension deactivation
 * Cleanup is handled automatically via context.subscriptions
 */
export function deactivate(): void {
	// Extensions are automatically disposed via context.subscriptions
}
