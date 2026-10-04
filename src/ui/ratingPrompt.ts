import * as vscode from 'vscode';
import {
	parseRatingState,
	recordAsk,
	recordUse,
	settle,
	shouldAsk,
} from '../rating/policy';

export const RATING_STATE_KEY = 'rating.state';

export interface RatingPrompt {
	/**
	 * Resolves once the toast has been answered, which may be never. Callers
	 * on a command path must not await it.
	 */
	recordSuccess(): Promise<void>;
}

export type RatingReport = (
	event: string,
	properties?: Record<string, unknown>,
) => void;

/**
 * The wiring every extension in the family uses, so that activation holds one
 * line and the two files stay byte-identical across the repos.
 */
export function createRatingPromptFor(
	context: vscode.ExtensionContext,
	report: RatingReport,
): RatingPrompt {
	// Synced so an answer given on one machine is not asked for again on the
	// next one the user signs in to.
	context.globalState.setKeysForSync([RATING_STATE_KEY]);
	return createRatingPrompt({
		state: context.globalState,
		extensionId: context.extension.id,
		displayName: context.extension.packageJSON.displayName,
		report,
		today: () => new Date().toISOString().slice(0, 10),
	});
}

export function createRatingPrompt(
	deps: Readonly<{
		state: vscode.Memento;
		extensionId: string;
		displayName: string;
		report: RatingReport;
		today: () => string;
	}>,
): RatingPrompt {
	const reviewPage = reviewUrl(deps.extensionId);

	const ask = async (page: string): Promise<void> => {
		// Bound once and compared below: showInformationMessage returns the
		// clicked label, so an English literal would read every translated
		// click as a dismissal.
		const rateLabel = vscode.l10n.t('Rate');
		const laterLabel = vscode.l10n.t('Later');
		const neverLabel = vscode.l10n.t("Don't Ask Again");

		deps.report('rating-prompt-shown');
		const choice = await vscode.window.showInformationMessage(
			vscode.l10n.t(
				'Enjoying {0}? A rating helps other developers find it.',
				deps.displayName,
			),
			rateLabel,
			laterLabel,
			neverLabel,
		);

		if (choice === neverLabel) {
			await settleStored(deps.state);
			return;
		}
		if (choice !== rateLabel) return;

		const opened = await vscode.env.openExternal(vscode.Uri.parse(page));
		// A browser that never opened is not a rating; the snooze already
		// written stands and the second ask is still owed.
		if (!opened) return;
		await settleStored(deps.state);
	};

	return Object.freeze({
		async recordSuccess(): Promise<void> {
			try {
				const used = recordUse(
					parseRatingState(deps.state.get(RATING_STATE_KEY)),
					deps.today(),
				);
				if (
					!reviewPage ||
					!shouldAsk(used) ||
					!promptsAllowed(deps.extensionId)
				) {
					await deps.state.update(RATING_STATE_KEY, used);
					return;
				}

				// Written before the toast is awaited. A window closed with the
				// toast still up never resolves it, and counting the ask only on
				// an answer would show it again on every launch.
				await deps.state.update(RATING_STATE_KEY, recordAsk(used));
				await ask(reviewPage);
			} catch (error) {
				// Nothing the user did failed, so this is logged rather than
				// shown: an error toast about a rating prompt is worse than no
				// prompt.
				deps.report('rating-prompt-failed', {
					message: error instanceof Error ? error.message : String(error),
				});
			}
		},
	});
}

async function settleStored(state: vscode.Memento): Promise<void> {
	await state.update(
		RATING_STATE_KEY,
		settle(parseRatingState(state.get(RATING_STATE_KEY))),
	);
}

/**
 * `notificationsLevel` defaults to `silent`, so honouring the effective value
 * would mean nobody is ever asked. What is honoured is a level the user set
 * themselves: anything they chose other than `all` is a request for quiet,
 * and the default is not a choice.
 */
function promptsAllowed(extensionId: string): boolean {
	const section = extensionId.slice(extensionId.indexOf('.') + 1);
	const level = vscode.workspace
		.getConfiguration(section)
		.inspect<string>('notificationsLevel');
	const chosen =
		level?.workspaceFolderValue ?? level?.workspaceValue ?? level?.globalValue;
	if (chosen === undefined) return true;
	return chosen === 'all';
}

/**
 * The two registries carry different builds of the same extension, under
 * different publishers, so the installed id says which one this copy came
 * from — and that is the only listing its user can be expected to rate.
 * Keyed in lower case because extension ids compare case-insensitively.
 */
const REVIEW_PAGES: ReadonlyMap<string, (name: string) => string> = new Map([
	[
		'nolindnaidoo',
		(name: string) =>
			`https://marketplace.visualstudio.com/items?itemName=nolindnaidoo.${name}&ssr=false#review-details`,
	],
	[
		'offensiveedge',
		(name: string) =>
			`https://open-vsx.org/extension/OffensiveEdge/${name}/reviews`,
	],
]);

/**
 * Undefined for a publisher with no listing — a fork, or a locally packaged
 * build — and the prompt is then never shown: there is no page to send that
 * user to, and guessing one sends them to a 404.
 */
function reviewUrl(extensionId: string): string | undefined {
	const [publisher = '', name = ''] = extensionId.split('.');
	if (!name) return undefined;
	return REVIEW_PAGES.get(publisher.toLowerCase())?.(name);
}
