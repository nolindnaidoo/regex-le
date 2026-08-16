import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decide } from './ambiguity';
import { REFUSALS } from './patternSyntax';

/**
 * The decider is scored, not asserted.
 *
 * `crate/fixtures/redos-truth.json` is shared with the Rust CLI and its
 * `measured` column comes from timing a real engine — `scripts/measure-redos.py`
 * — rather than from this code. A rule that grades its own homework can
 * be wrong in both places at once, which is how the shape rule this
 * replaces held a green suite while scoring 6 of 20.
 */

const TRUTH_FILE = join(
	__dirname,
	'..',
	'..',
	'..',
	'crate',
	'fixtures',
	'redos-truth.json',
);

interface TruthCase {
	readonly pattern: string;
	readonly measured: string;
}

function blows(pattern: string): boolean {
	return decide(pattern).kind === 'blowup';
}

describe('scored against measured truth', () => {
	const truth = JSON.parse(readFileSync(TRUTH_FILE, 'utf8')) as {
		cases: readonly TruthCase[];
	};

	it('is right about all twenty, with no miss and no false alarm', () => {
		const misses: string[] = [];
		const alarms: string[] = [];
		for (const testCase of truth.cases) {
			const expected = testCase.measured === 'exponential';
			const found = blows(testCase.pattern);
			if (expected && !found) misses.push(testCase.pattern);
			if (!expected && found) alarms.push(testCase.pattern);
		}
		expect({ cases: truth.cases.length, misses, alarms }).toEqual({
			cases: 20,
			misses: [],
			alarms: [],
		});
	});
});

describe('a holdout set the thresholds were never tuned against', () => {
	// Known-catastrophic shapes from the ReDoS literature.
	const CATASTROPHIC = [
		'^(\\w+\\s?)*$',
		'^(([a-z])+.)+[A-Z]([a-z])+$',
		'(x+x+)+y',
		'^(a|a?)+$',
		'(\\s*\\w+)+$',
	];
	for (const pattern of CATASTROPHIC) {
		it(`demonstrates a blow-up on ${pattern}`, () => {
			expect(blows(pattern)).toBe(true);
		});
	}

	// Ordinary idioms that must stay quiet. Each is safe because a
	// separator forces the split, which is a fact about strings that no
	// test on syntax can settle.
	const ORDINARY = [
		'^[\\w.+-]+@[\\w-]+\\.[\\w.]+$',
		'^/api/v[0-9]+/[a-z-]+$',
		'^#[0-9a-fA-F]{6}$',
		'^(?:\\d{1,3}\\.){3}\\d{1,3}$',
		'^[A-Za-z]+(?: [A-Za-z]+)*$',
		'^\\$?\\d+(?:,\\d{3})*(?:\\.\\d{2})?$',
	];
	for (const pattern of ORDINARY) {
		it(`stays quiet on ${pattern}`, () => {
			expect(blows(pattern)).toBe(false);
		});
	}
});

describe('a loop whose body can match empty', () => {
	// **The corpus could not have told you this**: none of the twenty
	// measured cases is an empty-body loop. Each of these was reported
	// `high` with a witness that runs in microseconds in CPython and V8 —
	// a receipt that does not reproduce, which is worse than no receipt.
	// A real engine abandons an iteration that consumed nothing; the walk
	// now does too, path-locally.
	for (const pattern of ['(\\w*)+', '((a)*)*', '(.*)+', '(a*)*']) {
		it(`does not report ${pattern} without a reproducing witness`, () => {
			expect(blows(pattern)).toBe(false);
		});
	}

	// The other half of the same rule: an empty-matching body behind an
	// anchor or a failing tail *is* catastrophic, and narrowing the false
	// alarm must not take these with it. Both exceed a five second budget
	// at 28 characters in CPython.
	for (const pattern of ['^(\\w*)+$', '(\\w*)+@']) {
		it(`still reports ${pattern}`, () => {
			expect(blows(pattern)).toBe(true);
		});
	}

	it('prunes on the current path only, never globally', () => {
		// A visited set that never releases would memoise the search into
		// polynomial time and silence every exponential case at once — and
		// no corpus would catch it, because both frontends would go quiet
		// together. These are the canaries for that.
		expect(blows('(a+)+b')).toBe(true);
		expect(blows('^(a?){26}a{26}$')).toBe(true);
	});
});

describe('the tail is what makes a loop exploitable', () => {
	it('does not report a loop that always succeeds', () => {
		// `(a+)+` matches any input holding an `a` on the first path it
		// tries, so it never backtracks. Reporting it was the single
		// largest source of false alarms in the rule this replaces.
		expect(blows('(a+)+')).toBe(false);
	});

	it('reports the same loop once a failing tail is added', () => {
		expect(blows('(a+)+b')).toBe(true);
	});
});

describe('a finding carries its witness', () => {
	it('names the input, and either exhausts the budget or dwarfs the smaller pump', () => {
		const decision = decide('(a+)+b');
		if (decision.kind !== 'blowup') throw new Error('expected a blow-up');

		expect(decision.witness).toBeTruthy();
		// When a pattern is bad enough that *both* pumps exhaust the budget
		// the ratio is 1, so the budget is the signal — asserting only the
		// ratio missed that.
		expect(
			decision.high === 2_000_000 || decision.high > decision.low * 100,
		).toBe(true);
	});

	it('reaches the loop behind a literal', () => {
		// An attack string of nothing but the pumped core dies at the `s`
		// from every start position, and the pattern measures flat. The
		// prefix is what finds this one.
		const decision = decide('say "([a-z]+)*"');
		if (decision.kind !== 'blowup') throw new Error('expected a blow-up');
		expect(decision.witness.startsWith('say "')).toBe(true);
	});
});

describe('what cannot be decided says so', () => {
	const REFUSED: ReadonlyArray<readonly [string, string]> = [
		['(a)\\1', REFUSALS.backreference],
		['(?P<w>a)(?P=w)', REFUSALS.backreference],
		['(?=a)b', REFUSALS.lookaround],
		['(?<=a)b', REFUSALS.lookaround],
		['(?<!a)b', REFUSALS.lookaround],
		['\\u0041+', REFUSALS.unsupported],
		['(?:(?:(?:a{64}){64}){64})b', REFUSALS.tooLarge],
	];

	for (const [pattern, reason] of REFUSED) {
		it(`refuses ${pattern} by name`, () => {
			expect(decide(pattern)).toEqual({ kind: 'undecided', reason });
		});
	}

	it('leaves a pattern undemonstrated rather than building an absurd prefix', () => {
		// A counted minimum is a number in the pattern text, not a promise
		// about length: building this one literally emitted a witness of
		// four billion characters.
		expect(decide('a{4000000000}(b+)+c').kind).toBe('clean');
	});

	it('reads a named group as the ordinary capture it is', () => {
		expect(decide('(?<year>\\d{4})').kind).toBe('clean');
		expect(decide('(?P<year>\\d{4})').kind).toBe('clean');
	});
});
