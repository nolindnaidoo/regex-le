import * as vscode from 'vscode';
import { getConfiguration } from '../config/config';

export interface StatusBar {
	show(): void;
	hide(): void;
	updateText(text: string): void;
	dispose(): void;
}

export function createStatusBar(context: vscode.ExtensionContext): StatusBar {
	const statusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		100,
	);

	statusBarItem.text = '$(symbol-misc) Regex-LE';
	statusBarItem.tooltip = 'Click to test regex from active editor';
	statusBarItem.command = 'regex-le.test';
	context.subscriptions.push(statusBarItem);

	const applyVisibility = (): void => {
		if (getConfiguration().statusBarEnabled) {
			statusBarItem.show();
			return;
		}
		statusBarItem.hide();
	};
	applyVisibility();

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('regex-le.statusBar.enabled')) {
				applyVisibility();
			}
		}),
	);

	return Object.freeze({
		show(): void {
			statusBarItem.show();
		},
		hide(): void {
			statusBarItem.hide();
		},
		updateText(text: string): void {
			statusBarItem.text = text;
		},
		dispose(): void {
			statusBarItem.dispose();
		},
	});
}
