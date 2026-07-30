/**
 * Shared heuristics for deciding whether a `/.../` occurrence in source
 * text is a regex literal, and for validating candidate patterns. Both
 * extraction forms (literal and constructor) route through here so the
 * rules cannot diverge per call site.
 *
 * Intentional rejections (documented, pinned by characterization tests):
 * - Division / path / date contexts: a `/` directly preceded by an
 *   identifier, number, `)`, `]`, or `.` is parsed as division or path
 *   segment (`a / b`, `10/29/2025`, `/usr/local/bin`), except when that
 *   word is a JS keyword like `return`, where a regex is legal.
 * - Candidates that do not compile as JavaScript regexes.
 * - Empty constructor patterns (`new RegExp('')`).
 *
 * Known limitations (honest, not bugs to paper over):
 * - This is lexing by heuristic, not a JS parser: a `/` inside a string
 *   or comment can still be picked up when its context looks
 *   expression-like.
 * - Constructor extraction only handles literal string arguments; a
 *   variable or template argument is invisible to it.
 */

/** Every flag current JavaScript engines accept. */
export const VALID_FLAGS = 'dgimsuvy';

const FLAG_PATTERN = new RegExp(`^[${VALID_FLAGS}]*$`);

/** JS keywords after which a `/` starts a regex, not division. */
const REGEX_ALLOWING_KEYWORDS = new Set([
	'return',
	'typeof',
	'instanceof',
	'in',
	'of',
	'new',
	'delete',
	'void',
	'do',
	'else',
	'case',
	'yield',
	'await',
	'throw',
]);

/**
 * True when flags are syntactically valid and mutually compatible
 * enough to compile (compilation is checked separately).
 */
export function isValidFlagString(flags: string): boolean {
	if (!FLAG_PATTERN.test(flags)) {
		return false;
	}
	return new Set(flags).size === flags.length;
}

/**
 * True when the pattern+flags compile as a JavaScript regex.
 */
export function compiles(pattern: string, flags: string): boolean {
	try {
		new RegExp(pattern, flags);
		return true;
	} catch {
		return false;
	}
}

/**
 * Decide whether a `/` at `offset` can start a regex literal, based on
 * what precedes it. Mirrors how JS engines disambiguate regex from
 * division: a regex is only legal where an expression is expected.
 */
export function isRegexContext(text: string, offset: number): boolean {
	let i = offset - 1;
	while (i >= 0) {
		const ch = text[i] ?? '';
		if (ch === ' ' || ch === '\t') {
			i--;
			continue;
		}
		break;
	}
	if (i < 0) {
		return true; // start of text
	}

	const prev = text[i] ?? '';
	if (prev === '\n' || prev === '\r') {
		return true; // start of line
	}

	// After an identifier/number/close-bracket the slash is division —
	// unless the word is a keyword like `return`.
	if (/[\w$]/.test(prev)) {
		let start = i;
		while (start > 0 && /[\w$]/.test(text[start - 1] ?? '')) {
			start--;
		}
		const word = text.slice(start, i + 1);
		return REGEX_ALLOWING_KEYWORDS.has(word);
	}
	// After ) ] . the slash is division; directly after another slash it
	// is a comment or a division chain (kills https://… false positives).
	if (prev === ')' || prev === ']' || prev === '.' || prev === '/') {
		return false;
	}

	return true;
}
