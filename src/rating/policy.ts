/**
 * When to ask for a rating. No `vscode` import: the whole decision is a
 * function of stored counts, so it is tested without the mock.
 */

export interface RatingState {
	readonly uses: number;
	readonly asks: number;
	readonly nextAskAtUses: number;
	readonly settled: boolean;
}

/**
 * The third delivered result, and the twentieth. Two asks is the lifetime
 * ceiling: the second is the last, whatever the answer.
 *
 * The bar is low on purpose. These are tools used now and then, and one set
 * at ten uses over three days was a bar most people who liked them never
 * reached, so they were never asked.
 *
 * The second ask is counted from the first, so that one which came late is
 * not followed by another on the very next run. A first ask on the third
 * use puts the second on the twentieth.
 */
export const RATING_POLICY = Object.freeze({
	firstAskAtUses: 3,
	snoozeUses: 17,
	maxAsks: 2,
});

export const INITIAL_RATING_STATE: RatingState = Object.freeze({
	uses: 0,
	asks: 0,
	nextAskAtUses: RATING_POLICY.firstAskAtUses,
	settled: false,
});

/**
 * The stored value roams through Settings Sync and outlives this version of
 * the code, so it is read as untrusted input rather than cast.
 */
export function parseRatingState(raw: unknown): RatingState {
	if (!raw || typeof raw !== 'object') return INITIAL_RATING_STATE;

	const stored = raw as Partial<Record<keyof RatingState, unknown>>;
	return Object.freeze({
		uses: readCount(stored.uses, INITIAL_RATING_STATE.uses),
		asks: readCount(stored.asks, INITIAL_RATING_STATE.asks),
		nextAskAtUses: readCount(
			stored.nextAskAtUses,
			INITIAL_RATING_STATE.nextAskAtUses,
		),
		settled: stored.settled === true,
	});
}

function readCount(value: unknown, fallback: number): number {
	if (!Number.isSafeInteger(value)) return fallback;
	if ((value as number) < 0) return fallback;
	return value as number;
}

export function recordUse(state: RatingState): RatingState {
	return Object.freeze({ ...state, uses: state.uses + 1 });
}

export function shouldAsk(state: RatingState): boolean {
	if (state.settled) return false;
	return state.uses >= state.nextAskAtUses;
}

export function recordAsk(state: RatingState): RatingState {
	const asks = state.asks + 1;
	return Object.freeze({
		...state,
		asks,
		nextAskAtUses: state.uses + RATING_POLICY.snoozeUses,
		settled: asks >= RATING_POLICY.maxAsks,
	});
}

export function settle(state: RatingState): RatingState {
	return Object.freeze({ ...state, settled: true });
}
