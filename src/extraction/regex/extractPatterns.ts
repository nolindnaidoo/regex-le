import {
	compiles,
	isRegexContext,
	isValidFlagString,
	VALID_FLAGS,
} from './heuristics';
import { createPositionIndex } from './position';

/**
 * Extract regex patterns from code/text.
 * Finds patterns as literals (/pattern/flags) and constructor calls
 * (new RegExp(...) / RegExp(...)), scanning the whole content so
 * constructors split across lines are found too.
 */

export interface ExtractedRegexPattern {
	readonly pattern: string;
	readonly flags: string;
	readonly line: number;
	readonly column: number;
	readonly match: string; // The full match string (e.g., "/pattern/gi" or "new RegExp(...)")
}

// Literal regex: /pattern/flags — pattern cannot contain an unescaped
// slash or newline. Flags are captured greedily and validated after.
const LITERAL = new RegExp(
	`\\/(?:[^/\\r\\n\\\\]|\\\\.)+\\/[${VALID_FLAGS}]*`,
	'dg',
);

// Constructor: new RegExp('pattern', 'flags') / RegExp("pattern") with
// proper escaped-quote handling in both arguments. Whitespace (including
// newlines) allowed everywhere a JS parser allows it.
const CONSTRUCTOR = new RegExp(
	'(?<![.\\w$])(?:new\\s+)?RegExp\\s*\\(\\s*' +
		`(?:'(?<sq>(?:[^'\\\\\\r\\n]|\\\\.)*)'|"(?<dq>(?:[^"\\\\\\r\\n]|\\\\.)*)")` +
		`\\s*(?:,\\s*(?:'(?<sqf>[${VALID_FLAGS}]*)'|"(?<dqf>[${VALID_FLAGS}]*)")\\s*)?,?\\s*\\)`,
	'dg',
);

/**
 * Extract all regex patterns from text content. Duplicate pattern+flags
 * pairs are reported once, at their first occurrence (intentional: the
 * output is a pattern list, not an occurrence list).
 */
export function extractRegexPatterns(
	text: string,
): readonly ExtractedRegexPattern[] {
	const patterns: ExtractedRegexPattern[] = [];
	const found = new Set<string>();
	const index = createPositionIndex(text);

	const push = (
		pattern: string,
		flags: string,
		offset: number,
		match: string,
	): void => {
		const key = `${pattern}::${flags}`;
		if (found.has(key)) {
			return;
		}
		found.add(key);
		const { line, column } = index.positionAt(offset);
		patterns.push(Object.freeze({ pattern, flags, line, column, match }));
	};

	LITERAL.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = LITERAL.exec(text)) !== null) {
		const full = m[0];
		const body = full.slice(1, full.lastIndexOf('/'));
		const flags = full.slice(full.lastIndexOf('/') + 1);
		if (!isRegexContext(text, m.index)) {
			continue;
		}
		if (!isValidFlagString(flags) || !compiles(body, flags)) {
			continue;
		}
		push(body, flags, m.index, full);
	}

	CONSTRUCTOR.lastIndex = 0;
	while ((m = CONSTRUCTOR.exec(text)) !== null) {
		const groups = m.groups ?? {};
		const body = groups.sq ?? groups.dq ?? '';
		const flags = groups.sqf ?? groups.dqf ?? '';
		if (body.length === 0) {
			continue;
		}
		// The string literal escapes a level: '\\d' is the pattern \d.
		const pattern = unescapeStringLiteral(body);
		if (!compiles(pattern, flags)) {
			continue;
		}
		push(pattern, flags, m.index, m[0]);
	}

	patterns.sort((a, b) =>
		a.line !== b.line ? a.line - b.line : a.column - b.column,
	);
	return Object.freeze(patterns);
}

/**
 * Resolve the JS string-literal escapes that change regex meaning:
 * doubled backslashes ('\\d' is the pattern \d) and escaped quotes.
 * Other escapes (\n, \t, \u….) are left intact — as regex source they
 * match the same characters the string escape would produce.
 */
function unescapeStringLiteral(s: string): string {
	return s.replace(/\\(\\|'|")/g, '$1');
}
