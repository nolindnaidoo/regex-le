import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PerformanceMetrics } from '../../types';
import { extractRegexPatterns } from './extractPatterns';
import {
	calculatePerformanceScore,
	estimatePatternComplexity,
} from './performance';
import { detectReDoS } from './redos';
import { testRegexPattern } from './regexTest';

/**
 * Characterization tests: pin the CURRENT output of the regex domain,
 * including known bugs (multiline constructors missed, global dedup
 * dropping repeat locations, division/date false positives, nested-depth
 * calculation stuck on the first paren, group positions via indexOf,
 * ReDoS source-string comparison that near-never fires). Behavior changes
 * must update these snapshots in the same commit, so every output diff
 * is explicit.
 */

const FIXTURES = [
	'patterns.js',
	'patterns.ts',
	'multiline.js',
	'log.txt',
] as const;

describe('extraction characterization', () => {
	for (const fixture of FIXTURES) {
		it(`extractRegexPatterns on ${fixture}`, () => {
			const content = readFileSync(
				join(__dirname, '__fixtures__', fixture),
				'utf8',
			);
			expect(extractRegexPatterns(content)).toMatchSnapshot();
		});
	}
});

describe('redos characterization', () => {
	const PATTERNS: ReadonlyArray<readonly [string, string]> = [
		['\\d+', 'g'],
		['(a+)+', ''],
		['(.*)+', ''],
		['(\\w+)*', ''],
		['(a|a)*', ''],
		['([a-z]+)*@example', 'i'],
		['(foo(bar+)+)+', ''],
		['[unclosed', ''],
	];

	for (const [pattern, flags] of PATTERNS) {
		it(`detectReDoS(/${pattern}/${flags})`, () => {
			expect(detectReDoS(pattern, flags)).toMatchSnapshot();
		});
	}
});

describe('complexity characterization', () => {
	const PATTERNS: readonly string[] = [
		'\\d+',
		'((((a))))',
		'(a)(b)(c)(d)',
		'a|b|c|d|e|f|g',
		'a*b+c?d{2,3}e*f+g?h{1}i*j+k?',
		'foo(?=bar)(?<=baz)',
	];

	for (const pattern of PATTERNS) {
		it(`estimatePatternComplexity(${pattern})`, () => {
			expect(estimatePatternComplexity(pattern)).toMatchSnapshot();
		});
	}
});

describe('regex test characterization', () => {
	it('global match with groups', () => {
		expect(
			testRegexPattern(
				'(\\d{3})-(\\d{4})',
				'g',
				'call 555-1234 or 555-9876 today',
			),
		).toMatchSnapshot();
	});

	it('named groups are not surfaced', () => {
		expect(
			testRegexPattern('(?<area>\\d{3})-(?<line>\\d{4})', 'g', '555-1234'),
		).toMatchSnapshot();
	});

	it('non-global stops after first match', () => {
		expect(testRegexPattern('\\d+', '', 'a1 b2 c3')).toMatchSnapshot();
	});

	it('zero-width matches do not loop forever', () => {
		expect(testRegexPattern('\\b', 'g', 'ab cd')).toMatchSnapshot();
	});

	it('repeated group text pins indexOf position bug', () => {
		// group value 'ab' appears earlier inside the match than the group does
		expect(testRegexPattern('ab(ab)', 'g', 'xxabab')).toMatchSnapshot();
	});

	it('maxMatches caps output', () => {
		expect(testRegexPattern('\\d', 'g', '123456789', 3)).toMatchSnapshot();
	});

	it('invalid pattern returns parse error', () => {
		expect(testRegexPattern('[', 'g', 'anything')).toMatchSnapshot();
	});

	it('multiline positions', () => {
		expect(
			testRegexPattern('^\\w+', 'gm', 'first\nsecond\nthird'),
		).toMatchSnapshot();
	});
});

describe('performance score characterization', () => {
	const metrics = (
		duration: number,
		inputSize: number,
		memoryUsage: number,
	): PerformanceMetrics =>
		Object.freeze({
			operation: 'regex-test',
			startTime: 0,
			endTime: duration,
			duration,
			inputSize,
			outputSize: 10,
			itemCount: 10,
			memoryUsage,
			cpuUsage: 0,
			warnings: 0,
			errors: 0,
		});

	it('fast small input', () => {
		expect(
			calculatePerformanceScore(metrics(1, 1000, 0), 1000),
		).toMatchSnapshot();
	});

	it('slow large input', () => {
		expect(
			calculatePerformanceScore(
				metrics(5000, 100000, 50 * 1024 * 1024),
				100000,
			),
		).toMatchSnapshot();
	});

	it('zero memory reads as perfect memory score', () => {
		expect(
			calculatePerformanceScore(metrics(100, 50000, 0), 50000),
		).toMatchSnapshot();
	});
});
