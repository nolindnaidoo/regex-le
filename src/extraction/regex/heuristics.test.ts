import { describe, expect, it } from 'vitest';
import { compiles, isRegexContext, isValidFlagString } from './heuristics';

describe('isRegexContext', () => {
	const cases: ReadonlyArray<[string, boolean, string]> = [
		['const a = ', true, 'after assignment'],
		['', true, 'start of text'],
		['foo(', true, 'after open paren'],
		['a, ', true, 'after comma'],
		['x ? ', true, 'after ternary'],
		['a && ', true, 'after logical operator'],
		['return ', true, 'after return keyword'],
		['typeof ', true, 'after typeof keyword'],
		['a ', false, 'after identifier (division)'],
		['10', false, 'after number (date-like)'],
		['f() ', false, 'after call result'],
		['arr[0] ', false, 'after index result'],
		['obj.', false, 'after property access'],
		['https:/', false, 'directly after another slash'],
	];

	for (const [prefix, expected, label] of cases) {
		it(`${label} -> ${expected}`, () => {
			const text = `${prefix}/x/`;
			expect(isRegexContext(text, prefix.length)).toBe(expected);
		});
	}

	it('start of a new line allows a regex', () => {
		const text = 'const a = 1\n/x/.test(s)';
		expect(isRegexContext(text, text.indexOf('/x/'))).toBe(true);
	});
});

describe('flag validation', () => {
	it('accepts empty and common flag sets', () => {
		expect(isValidFlagString('')).toBe(true);
		expect(isValidFlagString('g')).toBe(true);
		expect(isValidFlagString('gim')).toBe(true);
		expect(isValidFlagString('dgy')).toBe(true);
	});

	it('rejects unknown letters and duplicates', () => {
		expect(isValidFlagString('x')).toBe(false);
		expect(isValidFlagString('gg')).toBe(false);
	});
});

describe('compiles', () => {
	it('accepts valid patterns and rejects broken ones', () => {
		expect(compiles('\\d+', 'g')).toBe(true);
		expect(compiles('[unclosed', '')).toBe(false);
		expect(compiles('a', 'uv')).toBe(false); // u+v are mutually exclusive
	});
});
