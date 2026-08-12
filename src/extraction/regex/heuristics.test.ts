import { describe, expect, it } from 'vitest';
import {
	compiles,
	isRegexContext,
	isValidFlagString,
	isWellFormed,
	javaScriptEquivalent,
} from './heuristics';

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

describe('isWellFormed', () => {
	// The spellings JavaScript refuses and their own languages accept.
	// Judging these as syntax errors put `Pattern is invalid` on working
	// Python, Go and PHP.
	const foreign = [
		'(?P<year>\\d{4})',
		'(?P<a>x)(?P=a)',
		'(?>a+)',
		'a++',
		'a{2,}+',
		'(?i)abc',
		'(?im-sx)abc',
		"(?'name'a)",
		'(?#a comment)b',
	];

	for (const pattern of foreign) {
		it(`${pattern} is another language's spelling, not a syntax error`, () => {
			expect(compiles(pattern, '')).toBe(false);
			expect(isWellFormed(pattern, '')).toBe(true);
		});
	}

	// Widening the judge must not turn a typo into a pattern.
	it('still refuses a real syntax error', () => {
		for (const pattern of ['(', 'a{2,1}', '[z-a]', '(?P<a>x', '(?>a+']) {
			expect(isWellFormed(pattern, '')).toBe(false);
		}
		expect(isWellFormed('x', 'zz')).toBe(false);
	});
});

describe('javaScriptEquivalent', () => {
	// The rewrite answers a question; it never reaches a report. These
	// pin what it produces so a change to it is visible.
	it('translates rather than repairs', () => {
		expect(javaScriptEquivalent('(?P<y>\\d+)')).toBe('(?<y>\\d+)');
		expect(javaScriptEquivalent('(?P<a>x)(?P=a)')).toBe('(?<a>x)\\k<a>');
		expect(javaScriptEquivalent('(?>a+)b')).toBe('(?:a+)b');
		expect(javaScriptEquivalent('(?i)abc')).toBe('abc');
		expect(javaScriptEquivalent('(?s:a.b)')).toBe('(?:a.b)');
		expect(javaScriptEquivalent('a++b*+')).toBe('a+b*');
		expect(javaScriptEquivalent('(?#note)a')).toBe('a');
		expect(javaScriptEquivalent("(?'n'a)")).toBe('(?<n>a)');
	});

	it('leaves alone what JavaScript already spells the same way', () => {
		const same = '[a+]\\+(?<n>x)(?=y)(?<=z)(?!q)';
		expect(javaScriptEquivalent(same)).toBe(same);
	});
});
