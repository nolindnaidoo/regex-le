import type {
	PerformanceMetrics,
	RegexGroup,
	RegexMatch,
	RegexTestResult,
} from '../../types';
import { createPositionIndex } from './position';

/**
 * Test a regex pattern against text and return matches.
 * Executes with the 'd' (hasIndices) flag so capture-group positions
 * come from the engine instead of being guessed with indexOf.
 */
export function testRegexPattern(
	pattern: string,
	flags: string,
	text: string,
	maxMatches: number = 1000,
): RegexTestResult {
	try {
		const execFlags = flags.includes('d') ? flags : `${flags}d`;
		const regex = new RegExp(pattern, execFlags);
		const groupNames = captureGroupNames(pattern);
		const positionIndex = createPositionIndex(text);
		const matches: RegexMatch[] = [];
		let match: RegExpExecArray | null = null;

		while ((match = regex.exec(text)) !== null && matches.length < maxMatches) {
			const indices = match.indices ?? [];
			const groups: RegexGroup[] = [];

			for (let i = 1; i < match.length; i++) {
				const value = match[i];
				if (value === undefined) {
					continue;
				}
				const range = indices[i];
				groups.push(
					Object.freeze({
						index: i - 1,
						name: groupNames[i - 1],
						value,
						start: range?.[0] ?? match.index,
						end: range?.[1] ?? match.index + value.length,
					}),
				);
			}

			const { line, column } = positionIndex.positionAt(match.index);

			matches.push(
				Object.freeze({
					match: match[0],
					index: match.index,
					groups: groups.length > 0 ? Object.freeze(groups) : undefined,
					line,
					column,
				}),
			);

			// If not global, exec would loop on the first match forever.
			if (!flags.includes('g')) {
				break;
			}

			// Advance past zero-width matches.
			if (match[0].length === 0) {
				regex.lastIndex++;
			}
		}

		return Object.freeze({
			success: true,
			pattern,
			flags,
			matches: Object.freeze(matches),
			errors: Object.freeze([]),
		});
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		return Object.freeze({
			success: false,
			pattern,
			flags,
			matches: Object.freeze([]),
			errors: Object.freeze([
				Object.freeze({
					type: 'parse-error' as const,
					message: errorMessage,
				}),
			]),
		});
	}
}

/**
 * Map capture-group index -> name by scanning the pattern for capturing
 * parens, skipping escapes and character classes. Unnamed groups map to
 * undefined.
 */
function captureGroupNames(pattern: string): ReadonlyArray<string | undefined> {
	const names: Array<string | undefined> = [];
	let inClass = false;

	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === '\\') {
			i++; // skip escaped char
			continue;
		}
		if (inClass) {
			if (ch === ']') {
				inClass = false;
			}
			continue;
		}
		if (ch === '[') {
			inClass = true;
			continue;
		}
		if (ch !== '(') {
			continue;
		}
		if (pattern[i + 1] !== '?') {
			names.push(undefined); // plain capturing group
			continue;
		}
		const named = /^\(\?<([^>=!][^>]*)>/.exec(pattern.slice(i));
		if (named) {
			names.push(named[1]);
		}
		// (?: (?= (?! (?<= (?<! are non-capturing — no entry
	}

	return names;
}

/**
 * Test regex with performance tracking
 */
export function testRegexWithPerformance(
	pattern: string,
	flags: string,
	text: string,
	maxMatches: number,
	startTime: number,
): RegexTestResult & { performance: PerformanceMetrics } {
	const testResult = testRegexPattern(pattern, flags, text, maxMatches);
	const endTime = performance.now();
	const duration = endTime - startTime;

	const performanceMetrics: PerformanceMetrics = Object.freeze({
		operation: 'regex-test',
		startTime,
		endTime,
		duration,
		inputSize: text.length,
		outputSize: testResult.matches.length,
		itemCount: testResult.matches.length,
		memoryUsage: 0, // Not measured; scoring treats 0 as "no data"
		cpuUsage: 0, // Not measured
		warnings: testResult.warnings?.length || 0,
		errors: testResult.errors.length,
	});

	return Object.freeze({
		...testResult,
		performance: performanceMetrics,
	});
}
