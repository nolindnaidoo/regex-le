import * as vscode from 'vscode';
import { getConfiguration } from '../config/config';

/**
 * All user notifications route through here so notificationsLevel
 * actually governs them: 'all' shows everything, 'important' shows
 * warnings and errors, 'silent' shows errors only.
 */
export interface Notifier {
	showInfo(message: string): void;
	showWarning(message: string): void;
	showError(message: string): void;
}

export function createNotifier(): Notifier {
	return Object.freeze({
		showInfo(message: string): void {
			if (getConfiguration().notificationsLevel === 'all') {
				vscode.window.showInformationMessage(message);
			}
		},
		showWarning(message: string): void {
			if (getConfiguration().notificationsLevel !== 'silent') {
				vscode.window.showWarningMessage(message);
			}
		},
		showError(message: string): void {
			vscode.window.showErrorMessage(message);
		},
	});
}
