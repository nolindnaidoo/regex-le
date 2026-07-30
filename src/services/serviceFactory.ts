import * as vscode from 'vscode';
import type { Telemetry } from '../telemetry/telemetry';
import { createTelemetry } from '../telemetry/telemetry';
import type { Notifier } from '../ui/notifier';
import { createNotifier } from '../ui/notifier';
import type { StatusBar } from '../ui/statusBar';
import { createStatusBar } from '../ui/statusBar';
import { createErrorHandler, type ErrorHandler } from '../utils/errorHandling';

/**
 * Core services used throughout the extension
 */
export interface ExtensionServices {
	readonly telemetry: Telemetry;
	readonly notifier: Notifier;
	readonly statusBar: StatusBar;
	readonly errorHandler: ErrorHandler;
}

/**
 * Creates all core services for the extension
 * Centralizes service initialization and dependency management
 */
export function createServices(
	context: vscode.ExtensionContext,
): ExtensionServices {
	// Create output channel for logging
	const outputChannel = vscode.window.createOutputChannel('Regex-LE');
	context.subscriptions.push(outputChannel);

	// Create core services
	const telemetry = createTelemetry();
	const notifier = createNotifier();
	const statusBar = createStatusBar(context);

	// Register disposables to prevent memory leaks
	context.subscriptions.push(telemetry);
	context.subscriptions.push(statusBar);

	// Create error handling services
	const errorHandler = createErrorHandler();

	return Object.freeze({
		telemetry,
		notifier,
		statusBar,
		errorHandler,
	});
}
