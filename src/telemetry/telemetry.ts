import * as vscode from 'vscode';
import { getConfiguration } from '../config/config';

/**
 * Local-only telemetry service for debugging
 * No data leaves the user's machine - privacy-first design
 */
export interface Telemetry {
	event(name: string, properties?: Record<string, unknown>): void;
	dispose(): void;
}

export function createTelemetry(): Telemetry {
	let outputChannel: vscode.OutputChannel | undefined;

	return Object.freeze({
		event(name: string, properties?: Record<string, unknown>): void {
			if (!getConfiguration().telemetryEnabled) {
				return;
			}
			outputChannel ??= vscode.window.createOutputChannel('Regex-LE Telemetry');
			const timestamp = new Date().toISOString();
			const props = properties ? ` ${JSON.stringify(properties)}` : '';
			outputChannel.appendLine(`[${timestamp}] ${name}${props}`);
		},
		dispose(): void {
			outputChannel?.dispose();
		},
	});
}
