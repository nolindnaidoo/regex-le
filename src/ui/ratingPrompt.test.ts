import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
	parseRatingState,
	RATING_POLICY,
	type RatingState,
} from '../rating/policy';
import {
	createRatingPrompt,
	createRatingPromptFor,
	RATING_STATE_KEY,
} from './ratingPrompt';

/**
 * Byte-identical across the family, so it stands on `vi.spyOn` and its own
 * memento rather than on helpers that only one repo's `vscode` mock has.
 */

const MARKETPLACE_ID = 'nolindnaidoo.example-le';
const RATE = 'Rate';
const LATER = 'Later';
const NEVER = "Don't Ask Again";

function createMemento() {
	const store = new Map<string, unknown>();
	return {
		get: (key: string) => store.get(key),
		update: async (key: string, value: unknown) => {
			store.set(key, value);
		},
		keys: () => [...store.keys()],
	};
}

/** Answers the toast with `label`; undefined is a dismissal. */
function answerWith(label: string | undefined) {
	return vi
		.spyOn(vscode.window, 'showInformationMessage')
		.mockImplementation((async () => label) as never);
}

function opening(result: boolean) {
	return vi
		.spyOn(vscode.env, 'openExternal')
		.mockImplementation((async () => result) as never);
}

/** What the user chose for notificationsLevel; undefined is the default. */
function chosenLevel(level: string | undefined) {
	return vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
		inspect: () => ({ key: 'notificationsLevel', globalValue: level }),
	} as never);
}

function setup(extensionId: string = MARKETPLACE_ID) {
	const state = createMemento();
	const clock = { day: '2026-01-01' };
	const reports: string[] = [];
	const prompt = createRatingPrompt({
		state: state as never,
		extensionId,
		displayName: 'Example-LE',
		report: (event, properties) =>
			reports.push(`${event}:${JSON.stringify(properties)}`),
		today: () => clock.day,
	});
	const stored = (): RatingState =>
		parseRatingState(state.get(RATING_STATE_KEY));
	const use = async (day: string, times: number): Promise<void> => {
		clock.day = day;
		for (let i = 0; i < times; i++) await prompt.recordSuccess();
	};
	/** Leaves the state one use short of the first ask. */
	const reachThreshold = async (): Promise<void> => {
		await use('2026-01-01', 1);
		await use('2026-01-02', 1);
		await use('2026-01-03', RATING_POLICY.firstAskAtUses - 3);
	};
	return { state, prompt, reports, stored, use, reachThreshold };
}

beforeEach(() => {
	vi.restoreAllMocks();
	chosenLevel(undefined);
	opening(true);
});

describe('rating prompt', () => {
	it('stays quiet until the thresholds are met, then asks once', async () => {
		const toast = answerWith(undefined);
		const { use, reachThreshold, stored } = setup();
		await reachThreshold();
		expect(toast).not.toHaveBeenCalled();

		await use('2026-01-03', 1);
		expect(toast).toHaveBeenCalledTimes(1);
		expect(toast.mock.calls[0]?.[0]).toContain('Example-LE');
		expect(toast.mock.calls[0]?.slice(1)).toEqual([RATE, LATER, NEVER]);
		expect(stored().asks).toBe(1);

		await use('2026-01-03', 5);
		expect(toast).toHaveBeenCalledTimes(1);
	});

	// The Open VSX build is published as OffensiveEdge, so the installed id is
	// what tells the two registries apart.
	it.each([
		[
			'nolindnaidoo.example-le',
			'https://marketplace.visualstudio.com/items?itemName=nolindnaidoo.example-le&ssr=false#review-details',
		],
		[
			'OffensiveEdge.example-le',
			'https://open-vsx.org/extension/OffensiveEdge/example-le/reviews',
		],
		[
			'offensiveedge.example-le',
			'https://open-vsx.org/extension/OffensiveEdge/example-le/reviews',
		],
	])('sends %s to the registry it was installed from', async (id, page) => {
		answerWith(RATE);
		const parse = vi.spyOn(vscode.Uri, 'parse');
		const { use, reachThreshold, stored } = setup(id);
		await reachThreshold();
		await use('2026-01-03', 1);

		expect(parse.mock.calls.map((call) => call[0])).toEqual([page]);
		expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);
		expect(stored().settled).toBe(true);
	});

	it.each(['local.example-le', 'constructor.example-le', 'example-le'])(
		'never asks a build with no listing: %s',
		async (id) => {
			const toast = answerWith(RATE);
			const { use, reachThreshold, stored } = setup(id);
			await reachThreshold();
			await use('2026-01-03', 50);

			expect(toast).not.toHaveBeenCalled();
			expect(stored().asks).toBe(0);
		},
	);

	it('still owes the second ask when the browser did not open', async () => {
		answerWith(RATE);
		opening(false);
		const { use, reachThreshold, stored } = setup();
		await reachThreshold();
		await use('2026-01-03', 1);

		expect(stored().settled).toBe(false);
		expect(stored().asks).toBe(1);
	});

	it("settles on Don't Ask Again without opening anything", async () => {
		const toast = answerWith(NEVER);
		const { use, reachThreshold, stored } = setup();
		await reachThreshold();
		await use('2026-01-03', 1);

		expect(vscode.env.openExternal).not.toHaveBeenCalled();
		expect(stored().settled).toBe(true);

		await use('2026-02-01', 500);
		expect(toast).toHaveBeenCalledTimes(1);
	});

	it.each([
		['Later', LATER],
		['a dismissed toast', undefined],
	])('asks exactly once more after %s', async (_name, answer) => {
		const toast = answerWith(answer);
		const { use, reachThreshold, stored } = setup();
		await reachThreshold();
		await use('2026-01-03', 1);
		expect(stored().settled).toBe(false);

		await use('2026-01-04', RATING_POLICY.snoozeUses - 1);
		expect(toast).toHaveBeenCalledTimes(1);
		await use('2026-01-04', 1);
		expect(toast).toHaveBeenCalledTimes(2);
		expect(stored().settled).toBe(true);

		await use('2026-06-01', 500);
		expect(toast).toHaveBeenCalledTimes(2);
	});

	it('records the ask before the toast is answered', async () => {
		const { state, prompt, reachThreshold } = setup();
		await reachThreshold();

		let asksWhileOpen = 0;
		vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation(
			(async () => {
				asksWhileOpen = parseRatingState(state.get(RATING_STATE_KEY)).asks;
				return undefined;
			}) as never,
		);
		await prompt.recordSuccess();
		expect(asksWhileOpen).toBe(1);
	});

	it.each(['silent', 'important'])(
		'never asks a user who set notificationsLevel to %s',
		async (level) => {
			const toast = answerWith(RATE);
			chosenLevel(level);
			const { use, reachThreshold, stored } = setup();
			await reachThreshold();
			await use('2026-01-03', 50);

			expect(toast).not.toHaveBeenCalled();
			expect(stored().asks).toBe(0);
		},
	);

	it('asks a user who set notificationsLevel to all', async () => {
		const toast = answerWith(undefined);
		chosenLevel('all');
		const { use, reachThreshold } = setup();
		await reachThreshold();
		await use('2026-01-03', 1);
		expect(toast).toHaveBeenCalledTimes(1);
	});

	it('reports a storage failure instead of throwing into the command', async () => {
		const reports: string[] = [];
		const prompt = createRatingPrompt({
			state: {
				get: () => undefined,
				update: async () => {
					throw new Error('disk full');
				},
				keys: () => [],
			},
			extensionId: MARKETPLACE_ID,
			displayName: 'Example-LE',
			report: (event, properties) =>
				reports.push(`${event}:${JSON.stringify(properties)}`),
			today: () => '2026-01-01',
		});

		await expect(prompt.recordSuccess()).resolves.toBeUndefined();
		expect(reports).toEqual(['rating-prompt-failed:{"message":"disk full"}']);
	});
});

describe('createRatingPromptFor', () => {
	it('reads the identity from the context and syncs the stored answer', async () => {
		const state = createMemento();
		const synced: string[][] = [];
		const prompt = createRatingPromptFor(
			{
				globalState: {
					...state,
					setKeysForSync: (keys: string[]) => synced.push(keys),
				},
				extension: {
					id: MARKETPLACE_ID,
					packageJSON: { displayName: 'Example-LE' },
				},
			} as never,
			() => {},
		);

		await prompt.recordSuccess();
		expect(synced).toEqual([[RATING_STATE_KEY]]);
		expect(parseRatingState(state.get(RATING_STATE_KEY)).uses).toBe(1);
	});
});
