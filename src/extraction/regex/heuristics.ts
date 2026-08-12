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
 * True when the pattern is a well-formed regular expression in *some*
 * grammar this extractor reads.
 *
 * `compiles` answers for JavaScript, which is the right judge of a
 * JavaScript literal and the wrong one for the rest: JavaScript is the
 * only engine here, so `re.compile(r"(?P<year>\d+)")` — ordinary
 * Python — would come back a syntax error and be reported as
 * `Pattern is invalid`, a verdict on working code.
 */
export function isWellFormed(pattern: string, flags: string): boolean {
	return (
		compiles(pattern, flags) || compiles(javaScriptEquivalent(pattern), flags)
	);
}

/** PCRE-family flag letters, as an inline mode switch spells them. */
const INLINE_FLAGS = 'imsxuUXAJn';

/**
 * The non-JavaScript spellings this extractor reads, rendered as the
 * JavaScript an engine can answer for.
 *
 * **Nothing here reaches a report.** It exists so the validity question
 * has an answer for a pattern written in another language; the pattern
 * text that is reported, and that the ReDoS scan reads, is always the
 * source exactly as written. That is why dropping a possessive `+` is
 * safe: `(a++)+` still reaches the scan as `(a++)+` and is still
 * flagged, which is the conservative answer a tool that cannot prove a
 * pattern safe should give.
 */
export function javaScriptEquivalent(pattern: string): string {
	const characters = Array.from(pattern);
	const out: string[] = [];
	let inClass = false;
	let afterQuantifier = false;
	let i = 0;

	while (i < characters.length) {
		const ch = characters[i] ?? '';
		if (ch === '\\') {
			out.push(ch, characters[i + 1] ?? '');
			afterQuantifier = false;
			i += 2;
			continue;
		}
		if (inClass) {
			inClass = ch !== ']';
			out.push(ch);
			i++;
			continue;
		}
		if (ch === '(') {
			const [rendered, width] = rewriteGroupPrefix(characters, i);
			out.push(rendered);
			afterQuantifier = false;
			i += width;
			continue;
		}
		// A possessive quantifier is a `+` on another quantifier —
		// `a++`, `a{2,}+` — which JavaScript spells with no `+` at all.
		if (ch === '+' && afterQuantifier) {
			i++;
			continue;
		}
		inClass = ch === '[';
		afterQuantifier = ch === '*' || ch === '+' || ch === '?' || ch === '}';
		out.push(ch);
		i++;
	}
	return out.join('');
}

/**
 * Rewrite a group opener JavaScript does not spell the same way,
 * returning the rendering and how many characters it consumed.
 */
function rewriteGroupPrefix(
	characters: readonly string[],
	index: number,
): readonly [string, number] {
	// A PCRE comment carries no pattern at all.
	if (startsWith(characters, index, '(?#')) {
		const end = find(characters, index, ')');
		return ['', (end === -1 ? characters.length : end + 1) - index];
	}
	if (startsWith(characters, index, '(?P<')) {
		return ['(?<', 4];
	}
	if (startsWith(characters, index, '(?P=')) {
		const end = find(characters, index + 4, ')');
		if (end !== -1) {
			return [
				`\\k<${characters.slice(index + 4, end).join('')}>`,
				end + 1 - index,
			];
		}
	}
	if (startsWith(characters, index, "(?'")) {
		const end = find(characters, index + 3, "'");
		if (end !== -1) {
			return [
				`(?<${characters.slice(index + 3, end).join('')}>`,
				end + 1 - index,
			];
		}
	}
	// An atomic group is a non-capturing group that refuses to give
	// characters back. JavaScript has no such group, and the shape the
	// ReDoS scan reads is the same either way.
	if (startsWith(characters, index, '(?>')) {
		return ['(?:', 3];
	}
	const flags = inlineFlags(characters, index);
	if (flags === undefined) {
		return ['(', 1];
	}
	return [flags[1] === ':' ? '(?:' : '', flags[0]];
}

/**
 * `(?i)`, `(?im-sx)`, `(?s:` — a mode switch rather than a pattern. Go
 * and Rust write one at the head of nearly every case-insensitive
 * pattern they have.
 */
function inlineFlags(
	characters: readonly string[],
	index: number,
): readonly [number, string] | undefined {
	if (!startsWith(characters, index, '(?')) {
		return undefined;
	}
	let at = index + 2;
	while (
		at < characters.length &&
		INLINE_FLAGS.includes(characters[at] ?? '')
	) {
		at++;
	}
	if (characters[at] === '-') {
		at++;
		const negated = at;
		while (
			at < characters.length &&
			INLINE_FLAGS.includes(characters[at] ?? '')
		) {
			at++;
		}
		if (at === negated) {
			return undefined;
		}
	}
	const terminator = characters[at];
	if (terminator !== ')' && terminator !== ':') {
		return undefined;
	}
	return [at + 1 - index, terminator];
}

function startsWith(
	characters: readonly string[],
	index: number,
	prefix: string,
): boolean {
	return Array.from(prefix).every(
		(expected, offset) => characters[index + offset] === expected,
	);
}

function find(
	characters: readonly string[],
	from: number,
	needle: string,
): number {
	const at = characters.slice(from).indexOf(needle);
	return at === -1 ? -1 : from + at;
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
