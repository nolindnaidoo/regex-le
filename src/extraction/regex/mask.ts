/**
 * The spans of a document that are prose, not code.
 *
 * A regex written inside a comment is an *example* — documentation, a
 * line someone commented out, a JSDoc block explaining the very hazard
 * this tool reports. Scanning it finds a pattern nobody runs, and the
 * finding is worse than noise: it fails a build over a sentence.
 *
 * **The rule is about where a candidate starts, not where it sits.**
 * `re.compile(r"(a+)+b")` has its pattern inside a string and is a real
 * call; a docstring holding that whole line has the *call itself* inside
 * a string and is prose. Testing the start offset separates the two with
 * no parser and no per-language special case:
 *
 * ```text
 * re.compile(r"(a+)+b")           call starts in code     → scanned
 * """ re.compile(r"(a+)+b") """   call starts in a string → skipped
 * ```
 *
 * This is a lexer for comments and strings and nothing else. It does not
 * parse the language; it tracks just enough to know when a quote closes
 * and when a comment ends, which is what makes it cheap enough to run
 * over every document before extraction.
 */

import type { Language } from './format';

/** A half-open range that extraction should not start a match in. */
export type Span = readonly [start: number, end: number];

/** An opener and the closer that ends it. */
type Delimiters = readonly [opener: string, closer: string];

const pair = (opener: string, closer: string): Delimiters => [opener, closer];

/** What a grammar spells its comments and strings with. */
interface Syntax {
	readonly lineComments: readonly string[];
	readonly blockComments: readonly Delimiters[];
	/** Quote characters whose strings honour a `\` escape. */
	readonly escapedQuotes: readonly string[];
	/**
	 * Openers and closers for strings that take no escape — Go's
	 * backticks, Python's triple quotes, C#'s verbatim strings.
	 */
	readonly rawStrings: readonly Delimiters[];
	/** Rust's `r#"…"#`, whose closer depends on the opener's hash count. */
	readonly rustRawStrings: boolean;
}

const C_LIKE: Syntax = Object.freeze({
	lineComments: ['//'],
	blockComments: [pair('/*', '*/')],
	escapedQuotes: ['"', "'", '`'],
	rawStrings: [],
	rustRawStrings: false,
});

const PYTHON: Syntax = Object.freeze({
	lineComments: ['#'],
	blockComments: [],
	escapedQuotes: ['"', "'"],
	// Triple quotes first: they must win over the single-quote rule that
	// shares their first character.
	rawStrings: [pair('"""', '"""'), pair("'''", "'''")],
	rustRawStrings: false,
});

const RUBY: Syntax = Object.freeze({
	lineComments: ['#'],
	blockComments: [pair('=begin', '=end')],
	escapedQuotes: ['"', "'"],
	rawStrings: [],
	rustRawStrings: false,
});

const RUST: Syntax = Object.freeze({
	lineComments: ['//'],
	blockComments: [pair('/*', '*/')],
	escapedQuotes: ['"'],
	rawStrings: [],
	rustRawStrings: true,
});

const GO: Syntax = Object.freeze({
	lineComments: ['//'],
	blockComments: [pair('/*', '*/')],
	escapedQuotes: ['"'],
	rawStrings: [pair('`', '`')],
	rustRawStrings: false,
});

const CSHARP: Syntax = Object.freeze({
	lineComments: ['//'],
	blockComments: [pair('/*', '*/')],
	escapedQuotes: ['"', "'"],
	rawStrings: [pair('@"', '"')],
	rustRawStrings: false,
});

const PHP: Syntax = Object.freeze({
	lineComments: ['//', '#'],
	blockComments: [pair('/*', '*/')],
	escapedQuotes: ['"', "'"],
	rawStrings: [],
	rustRawStrings: false,
});

const SYNTAXES: Readonly<Record<Language, Syntax>> = Object.freeze({
	javascript: C_LIKE,
	typescript: C_LIKE,
	java: C_LIKE,
	python: PYTHON,
	ruby: RUBY,
	rust: RUST,
	go: GO,
	csharp: CSHARP,
	php: PHP,
});

/**
 * Every comment and string span in the document, sorted and
 * non-overlapping.
 *
 * With no language, nothing is masked. A document whose grammar is
 * unknown is scanned for every spelling at once — see
 * `extractRegexPatterns` — and a comment rule guessed from the wrong
 * grammar would drop real patterns rather than phantom ones. Finding an
 * example regex in a comment is the lesser error.
 */
export function proseSpans(
	text: string,
	language: Language | undefined,
): readonly Span[] {
	if (language === undefined) return [];
	return scan(text, SYNTAXES[language]);
}

/**
 * Whether an offset falls inside one of the spans.
 *
 * Binary search rather than a walk: `scanLiterals` asks once per
 * candidate slash, and a minified bundle has thousands of them.
 */
export function isProse(spans: readonly Span[], offset: number): boolean {
	let low = 0;
	let high = spans.length - 1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		const span = spans[middle];
		if (span === undefined) return false;
		if (offset < span[0]) {
			high = middle - 1;
			continue;
		}
		if (offset >= span[1]) {
			low = middle + 1;
			continue;
		}
		return true;
	}
	return false;
}

function scan(text: string, syntax: Syntax): readonly Span[] {
	const spans: Span[] = [];
	let at = 0;

	while (at < text.length) {
		const end = spanEnd(text, at, syntax);
		if (end !== undefined) {
			spans.push([at, end]);
			at = end;
			continue;
		}
		at += characterAt(text, at).length;
	}
	return spans;
}

/**
 * Where the prose starting at this offset ends, if any starts here.
 *
 * The order is the grammar's own precedence: a `#` inside a Python
 * docstring is not a comment, and C#'s `@"` is not a plain quote.
 */
function spanEnd(text: string, at: number, syntax: Syntax): number | undefined {
	const block = blockCommentEnd(text, at, syntax);
	if (block !== undefined) return block;
	const line = lineCommentEnd(text, at, syntax);
	if (line !== undefined) return line;
	const raw = rawStringEnd(text, at, syntax);
	if (raw !== undefined) return raw;
	return quotedStringEnd(text, at, syntax);
}

function lineCommentEnd(
	text: string,
	at: number,
	syntax: Syntax,
): number | undefined {
	const opener = syntax.lineComments.find((mark) => text.startsWith(mark, at));
	if (opener === undefined) return undefined;
	// The newline itself stays out: nothing starts a match on it, and
	// leaving it unmasked keeps the spans from touching.
	const found = text.indexOf('\n', at + opener.length);
	return found === -1 ? text.length : found;
}

function blockCommentEnd(
	text: string,
	at: number,
	syntax: Syntax,
): number | undefined {
	const found = syntax.blockComments.find(([opener]) =>
		text.startsWith(opener, at),
	);
	if (found === undefined) return undefined;
	// **An unterminated block comment runs to the end of the document**,
	// which is what the compiler does with one. Ending the span at the
	// opener instead would scan the rest of the file as code.
	return closerEnd(text, at + found[0].length, found[1]);
}

function rawStringEnd(
	text: string,
	at: number,
	syntax: Syntax,
): number | undefined {
	if (syntax.rustRawStrings) {
		const rust = rustRawStringEnd(text, at);
		if (rust !== undefined) return rust;
	}
	const found = syntax.rawStrings.find(([opener]) =>
		text.startsWith(opener, at),
	);
	if (found === undefined) return undefined;
	return closerEnd(text, at + found[0].length, found[1]);
}

/** `r"…"`, `r#"…"#`, `r##"…"##` — the closer carries the opener's hashes. */
function rustRawStringEnd(text: string, at: number): number | undefined {
	if (text[at] !== 'r') return undefined;
	let hashes = 0;
	while (text[at + 1 + hashes] === '#') hashes += 1;
	if (text[at + 1 + hashes] !== '"') return undefined;

	const opened = at + 1 + hashes + 1;
	return closerEnd(text, opened, `"${'#'.repeat(hashes)}`);
}

/** Past the closer, or the end of the document when it never comes. */
function closerEnd(text: string, from: number, closer: string): number {
	const found = text.indexOf(closer, from);
	return found === -1 ? text.length : found + closer.length;
}

function quotedStringEnd(
	text: string,
	at: number,
	syntax: Syntax,
): number | undefined {
	const quote = characterAt(text, at);
	if (!syntax.escapedQuotes.includes(quote)) return undefined;

	let i = at + quote.length;
	while (i < text.length) {
		const character = characterAt(text, i);
		if (character === '\\') {
			// Skip whatever the backslash escapes, including a quote.
			i += 1 + characterAt(text, i + 1).length;
			continue;
		}
		if (character === quote) return i + character.length;
		// A single-quoted or double-quoted string does not span lines in
		// any of these grammars. An unterminated one is a typo, and running
		// its span to the end of the document would hide the whole file
		// from extraction.
		if (character === '\n' && quote !== '`') return i;
		i += character.length;
	}
	return text.length;
}

/** The whole character at an offset, so a surrogate pair is never split. */
function characterAt(text: string, at: number): string {
	const point = text.codePointAt(at);
	return point === undefined ? '' : String.fromCodePoint(point);
}
