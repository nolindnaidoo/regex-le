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

function use(state: RatingState, times: number): RatingState {
	let next = state;
	for (let i = 0; i < times; i++) next = recordUse(next);
	return next;
}

/** The fewest uses that earn the first ask. */
function eligible(): RatingState {
	return use(INITIAL_RATING_STATE, RATING_POLICY.firstAskAtUses);
}

describe('rating policy', () => {
	it('does not ask before the third use', () => {
		expect(shouldAsk(INITIAL_RATING_STATE)).toBe(false);
		expect(shouldAsk(use(INITIAL_RATING_STATE, 2))).toBe(false);
	});

	it('asks on the third use, whatever day it falls on', () => {
		const state = eligible();
		expect(state.uses).toBe(3);
		expect(shouldAsk(state)).toBe(true);
	});

	it('puts the second ask on the twentieth use', () => {
		const asked = recordAsk(eligible());
		expect(asked.settled).toBe(false);
		expect(asked.nextAskAtUses).toBe(20);
		expect(shouldAsk(asked)).toBe(false);

		const almost = use(asked, RATING_POLICY.snoozeUses - 1);
		expect(almost.uses).toBe(19);
		expect(shouldAsk(almost)).toBe(false);
		expect(shouldAsk(recordUse(almost))).toBe(true);
	});

	it('counts the second ask from the first, so a late one is not followed at once', () => {
		// A first ask held back to the fortieth use, as it is while the
		// user's notification level keeps the prompt quiet.
		const late = recordAsk(use(INITIAL_RATING_STATE, 40));
		expect(late.nextAskAtUses).toBe(40 + RATING_POLICY.snoozeUses);
		expect(shouldAsk(recordUse(late))).toBe(false);
	});

	it('never asks a third time', () => {
		const first = recordAsk(eligible());
		const second = recordAsk(use(first, RATING_POLICY.snoozeUses));
		expect(second.asks).toBe(RATING_POLICY.maxAsks);
		expect(second.settled).toBe(true);
		expect(shouldAsk(use(second, 10_000))).toBe(false);
	});

	it('never asks once settled', () => {
		expect(shouldAsk(use(settle(eligible()), 10_000))).toBe(false);
	});

	it('does not mutate the state it is given', () => {
		const before = eligible();
		recordUse(before);
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
			asks: 1.5,
			nextAskAtUses: Number.NaN,
			settled: 'yes',
		});
		expect(parsed).toEqual(INITIAL_RATING_STATE);
	});

	it('drops what an earlier build stored and this one has no use for', () => {
		const parsed = parseRatingState({
			uses: 2,
			activeDays: 2,
			lastActiveDay: '2026-01-02',
			asks: 0,
			nextAskAtUses: 3,
			settled: false,
		});
		expect(parsed).toEqual({
			uses: 2,
			asks: 0,
			nextAskAtUses: 3,
			settled: false,
		});
	});
});
