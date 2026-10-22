import * as vscode from 'vscode';
import { sanitizeErrorMessage } from '../utils/errors';

/**
 * The outer handler every command body runs inside.
 *
 * A rejection that escapes a command is reported by the editor in its own
 * words, as "command '…' resulted in an error" with the raw message, home
 * directory and all, and whatever the command had set up stays as it was.
 * Through here it is one error notification, redacted, in the user's
 * language, and the command's own `finally` blocks have run.
 */
export function guarded<Args extends unknown[]>(
	notifier: { showError(message: string): void },
	run: (...args: Args) => Promise<void>,
): (...args: Args) => Promise<void> {
	return async (...args: Args): Promise<void> => {
		try {
			await run(...args);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notifier.showError(
				vscode.l10n.t(
					'Regex-LE could not finish: {0}',
					sanitizeErrorMessage(message),
				),
			);
		}
	};
}
