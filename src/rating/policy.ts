/**
 * When to ask for a rating. No `vscode` import: the whole decision is a
 * function of stored counts and a day string, so it is tested without the
 * mock and a clock.
 */

export interface RatingState {
	readonly uses: number;
	readonly activeDays: number;
	readonly lastActiveDay: string;
	readonly asks: number;
	readonly nextAskAtUses: number;
	readonly settled: boolean;
}

/**
 * Uses alone would ask a first-day user who ran the command ten times while
 * trying it out, so the day count is what separates someone evaluating the
 * tool from someone who came back to it. Two asks is the lifetime ceiling:
 * the second is the last, whatever the answer.
 */
export const RATING_POLICY = Object.freeze({
	firstAskAtUses: 10,
	minActiveDays: 3,
	snoozeUses: 30,
	maxAsks: 2,
});

export const INITIAL_RATING_STATE: RatingState = Object.freeze({
	uses: 0,
	activeDays: 0,
	lastActiveDay: '',
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
		activeDays: readCount(stored.activeDays, INITIAL_RATING_STATE.activeDays),
		lastActiveDay:
			typeof stored.lastActiveDay === 'string' ? stored.lastActiveDay : '',
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

export function recordUse(state: RatingState, day: string): RatingState {
	const isNewDay = day !== state.lastActiveDay;
	return Object.freeze({
		...state,
		uses: state.uses + 1,
		activeDays: isNewDay ? state.activeDays + 1 : state.activeDays,
		lastActiveDay: day,
	});
}

export function shouldAsk(state: RatingState): boolean {
	if (state.settled) return false;
	if (state.activeDays < RATING_POLICY.minActiveDays) return false;
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
