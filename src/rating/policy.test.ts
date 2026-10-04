import { describe, expect, it } from 'vitest';
import {
	INITIAL_RATING_STATE,
	parseRatingState,
	RATING_POLICY,
	type RatingState,
	recordAsk,
	recordUse,
	settle,
	shouldAsk,
} from './policy';

function useOn(state: RatingState, day: string, times: number): RatingState {
	let next = state;
	for (let i = 0; i < times; i++) next = recordUse(next, day);
	return next;
}

/** The fewest uses that satisfy both thresholds. */
function eligible(): RatingState {
	const dayOne = useOn(INITIAL_RATING_STATE, '2026-01-01', 1);
	const dayTwo = useOn(dayOne, '2026-01-02', 1);
	return useOn(dayTwo, '2026-01-03', RATING_POLICY.firstAskAtUses - 2);
}

describe('rating policy', () => {
	it('does not ask a heavy first-day user', () => {
		const state = useOn(INITIAL_RATING_STATE, '2026-01-01', 500);
		expect(state.activeDays).toBe(1);
		expect(shouldAsk(state)).toBe(false);
	});

	it('does not ask a returning user below the use threshold', () => {
		const dayOne = useOn(INITIAL_RATING_STATE, '2026-01-01', 1);
		const dayTwo = useOn(dayOne, '2026-01-02', 1);
		const dayThree = useOn(dayTwo, '2026-01-03', 1);
		expect(dayThree.activeDays).toBe(RATING_POLICY.minActiveDays);
		expect(shouldAsk(dayThree)).toBe(false);
	});

	it('asks once both thresholds are met', () => {
		expect(shouldAsk(eligible())).toBe(true);
	});

	it('snoozes after the first ask and asks once more', () => {
		const asked = recordAsk(eligible());
		expect(asked.settled).toBe(false);
		expect(shouldAsk(asked)).toBe(false);

		const almost = useOn(asked, '2026-01-04', RATING_POLICY.snoozeUses - 1);
		expect(shouldAsk(almost)).toBe(false);
		expect(shouldAsk(recordUse(almost, '2026-01-04'))).toBe(true);
	});

	it('never asks a third time', () => {
		const first = recordAsk(eligible());
		const second = recordAsk(
			useOn(first, '2026-01-04', RATING_POLICY.snoozeUses),
		);
		expect(second.asks).toBe(RATING_POLICY.maxAsks);
		expect(second.settled).toBe(true);
		expect(shouldAsk(useOn(second, '2026-02-01', 10_000))).toBe(false);
	});

	it('never asks once settled', () => {
		expect(shouldAsk(useOn(settle(eligible()), '2026-03-01', 10_000))).toBe(
			false,
		);
	});

	it('does not mutate the state it is given', () => {
		const before = eligible();
		recordUse(before, '2026-01-09');
		recordAsk(before);
		settle(before);
		expect(before).toEqual(eligible());
	});
});

describe('parseRatingState', () => {
	it.each([undefined, null, false, 'x', 42])(
		'falls back to the initial state for %s',
		(raw) => {
			expect(parseRatingState(raw)).toEqual(INITIAL_RATING_STATE);
		},
	);

	it('round-trips a stored state', () => {
		const state = recordAsk(eligible());
		expect(parseRatingState(JSON.parse(JSON.stringify(state)))).toEqual(state);
	});

	it('replaces fields that are not usable counts', () => {
		const parsed = parseRatingState({
			uses: -4,
			activeDays: 'three',
			lastActiveDay: 7,
			asks: 1.5,
			nextAskAtUses: Number.NaN,
			settled: 'yes',
		});
		expect(parsed).toEqual(INITIAL_RATING_STATE);
	});
});
