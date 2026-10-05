import { describe, expect, it } from 'vitest';
import { positioned, withoutPositions } from './positions';

describe('withoutPositions', () => {
	it('drops the position lines of a test or validation report and nothing else', () => {
		const report = [
			'## Pattern 1: `/a/g`',
			'**Line:** 12',
			'**Status:** ✅ Valid',
			'1. `a` at position 4',
			'   Line 3, Column 5',
		].join('\n');
		expect(withoutPositions(report)).toBe(
			[
				'## Pattern 1: `/a/g`',
				'**Status:** ✅ Valid',
				'1. `a` at position 4',
			].join('\n'),
		);
	});

	it('takes the prefix off an extracted pattern', () => {
		expect(withoutPositions('1:11\t/\\d+/g\n2:11\t/x|y/i')).toBe(
			'/\\d+/g\n/x|y/i',
		);
	});

	it('leaves a pattern that only looks like a position', () => {
		// No tab follows, so this is the pattern itself and not where it is.
		expect(withoutPositions('/12:30 \\d+/')).toBe('/12:30 \\d+/');
		expect(withoutPositions('12:30 is in the text')).toBe(
			'12:30 is in the text',
		);
	});
});

describe('positioned', () => {
	it('returns the text as written when positions are kept', () => {
		expect(positioned('1:1\t/a/', true)).toBe('1:1\t/a/');
		expect(positioned('1:1\t/a/', false)).toBe('/a/');
	});
});
