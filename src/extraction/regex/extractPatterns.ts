import { determineLanguage, hasSlashLiterals, type Language } from './format';
import {
	compiles,
	isRegexContext,
	isValidFlagString,
	isWellFormed,
	VALID_FLAGS,
} from './heuristics';
import { isProse, proseSpans, type Span } from './mask';
import { createPositionIndex } from './position';

/**
 * Extract regex patterns from code/text.
 * Finds patterns as literals (/pattern/flags), constructor calls
 * (new RegExp(...) / RegExp(...)), and the call sites Python, Rust, Go,
 * Java, Ruby, PHP and C# write a pattern at — scanning the whole content
 * so constructors split across lines are found too.
 *
 * **The language selects the forms, and nothing else.** With no language
 * every form is scanned for, which is close to what this did when it
 * knew only JavaScript: a caller who cannot name the language gets
 * answers rather than a refusal. What the language buys is precision — a
 * Python document is not scanned for bare `/…/` literals, so
 * `#!/usr/bin/env python` stops reading as a pattern.
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

// The call-site sources are written with String.raw so what is on the
// page is the regex, not a count of backslashes. The two above predate
// this and are left as they were rather than rewritten under a change
// that is about languages.

/** A double-quoted string body, as six of these languages spell one. */
const DOUBLE_QUOTED = String.raw`(?:[^"\\\r\n]|\\.)*`;
/** The same, single-quoted. */
const SINGLE_QUOTED = String.raw`(?:[^'\\\r\n]|\\.)*`;

/**
 * The group names a call form captures its pattern into.
 *
 * A `raw*` group is the regex source verbatim — a Python or Rust raw
 * string, a Go backquoted string, a C# verbatim string — and an `esc*`
 * group is a quoted string, which escapes a level exactly as the
 * JavaScript constructor's argument does. Fixed names rather than a
 * per-form table, so one reader serves every form.
 */
const RAW_GROUPS = ['raw1', 'raw2', 'raw3', 'raw4'] as const;
const ESCAPED_GROUPS = ['esc1', 'esc2', 'esc3', 'esc4'] as const;

/**
 * A call site that takes a pattern.
 *
 * Every language but JavaScript sets its flags with constants, builder
 * methods or an inline `(?i)` rather than a string argument, so a call
 * form reports no flags. Reading `re.I` or `RegexOptions` as a
 * JavaScript flag string is not something this could get right, and the
 * ReDoS scan does not depend on flags.
 */
interface CallForm {
	readonly matcher: RegExp;
	/** PHP writes the delimiters and modifiers *inside* the string. */
	readonly delimited: boolean;
}

const PYTHON = new RegExp(
	String.raw`(?<![A-Za-z0-9_$.])re\.(?:compile|fullmatch|finditer|findall|match|search|split|subn|sub)\s*\(\s*(?:` +
		String.raw`[rR][bB]?"""(?<raw1>[\s\S]*?)"""|[rR][bB]?'''(?<raw2>[\s\S]*?)'''|` +
		`[rR][bB]?"(?<raw3>${DOUBLE_QUOTED})"|[rR][bB]?'(?<raw4>${SINGLE_QUOTED})'|` +
		String.raw`"""(?<esc1>[\s\S]*?)"""|'''(?<esc2>[\s\S]*?)'''|` +
		`"(?<esc3>${DOUBLE_QUOTED})"|'(?<esc4>${SINGLE_QUOTED})')`,
	'dg',
);

// Rust raw strings carry an arbitrary run of hashes, so the closing
// delimiter is a backreference to the opening one rather than a fixed
// list of two or three levels.
const RUST = new RegExp(
	String.raw`(?<![A-Za-z0-9_$])(?:Regex|RegexBuilder)::new\s*\(\s*(?:r(?<hash>#*)"(?<raw1>[\s\S]*?)"\k<hash>|"(?<esc1>${DOUBLE_QUOTED})")`,
	'dg',
);

const GO = new RegExp(
	String.raw`(?<![A-Za-z0-9_$.])regexp\.(?:MustCompilePOSIX|MustCompile|CompilePOSIX|Compile)\s*\(\s*(?:` +
		'`(?<raw1>[^`]*)`' +
		`|"(?<esc1>${DOUBLE_QUOTED})")`,
	'dg',
);

const JAVA = new RegExp(
	String.raw`(?<![A-Za-z0-9_$])Pattern\.(?:compile|matches)\s*\(\s*"(?<esc1>${DOUBLE_QUOTED})"`,
	'dg',
);

const RUBY = new RegExp(
	String.raw`(?<![A-Za-z0-9_$])Regexp\.(?:new|compile)\s*\(\s*(?:"(?<esc1>${DOUBLE_QUOTED})"|'(?<esc2>${SINGLE_QUOTED})')`,
	'dg',
);

const PHP = new RegExp(
	String.raw`(?<![A-Za-z0-9_$])preg_(?:match_all|match|replace_callback|replace|split|grep)\s*\(\s*(?:'(?<esc1>${SINGLE_QUOTED})'|"(?<esc2>${DOUBLE_QUOTED})")`,
	'dg',
);

// C# verbatim strings (@"…") escape nothing but a doubled quote, so the
// body is taken as written.
const CSHARP_NEW = new RegExp(
	String.raw`(?<![A-Za-z0-9_$])(?:new\s+)?Regex\s*\(\s*(?:@"(?<raw1>(?:[^"]|"")*)"|"(?<esc1>${DOUBLE_QUOTED})")`,
	'dg',
);

// The static methods take the subject first and the pattern second, so
// the first argument is skipped. It is skipped as a string literal or as
// a simple expression: a call or an index sitting there is out of reach
// of a scan that does not parse C#.
const CSHARP_STATIC = new RegExp(
	String.raw`(?<![A-Za-z0-9_$])Regex\.(?:Matches|Match|IsMatch|Replace|Split|Count)\s*\(\s*(?:@"(?:[^"]|"")*"|"${DOUBLE_QUOTED}"|[^,()"']*)\s*,\s*(?:@"(?<raw1>(?:[^"]|"")*)"|"(?<esc1>${DOUBLE_QUOTED})")`,
	'dg',
);

const PYTHON_FORM: CallForm = Object.freeze({
	matcher: PYTHON,
	delimited: false,
});
const RUST_FORM: CallForm = Object.freeze({ matcher: RUST, delimited: false });
const GO_FORM: CallForm = Object.freeze({ matcher: GO, delimited: false });
const JAVA_FORM: CallForm = Object.freeze({ matcher: JAVA, delimited: false });
const RUBY_FORM: CallForm = Object.freeze({ matcher: RUBY, delimited: false });
const PHP_FORM: CallForm = Object.freeze({ matcher: PHP, delimited: true });
const CSHARP_FORMS: readonly CallForm[] = Object.freeze([
	Object.freeze({ matcher: CSHARP_NEW, delimited: false }),
	Object.freeze({ matcher: CSHARP_STATIC, delimited: false }),
]);

/**
 * The call forms to scan a document for. With no language, all of them:
 * a form belonging to another language costs a scan and finds nothing,
 * which is cheaper than an answer that is missing.
 */
function callForms(language: Language | undefined): readonly CallForm[] {
	switch (language) {
		case 'javascript':
		case 'typescript':
			return [];
		case 'python':
			return [PYTHON_FORM];
		case 'rust':
			return [RUST_FORM];
		case 'go':
			return [GO_FORM];
		case 'java':
			return [JAVA_FORM];
		case 'ruby':
			return [RUBY_FORM];
		case 'php':
			return [PHP_FORM];
		case 'csharp':
			return CSHARP_FORMS;
		default:
			return [
				PYTHON_FORM,
				RUST_FORM,
				GO_FORM,
				JAVA_FORM,
				RUBY_FORM,
				PHP_FORM,
				...CSHARP_FORMS,
			];
	}
}

/**
 * Extract all regex patterns from text content. Duplicate pattern+flags
 * pairs are reported once, at their first occurrence (intentional: the
 * output is a pattern list, not an occurrence list).
 *
 * `languageId` is the editor's language id, or a format name. Omitted or
 * unrecognized means every form is scanned for.
 */
export function extractRegexPatterns(
	text: string,
	languageId?: string,
): readonly ExtractedRegexPattern[] {
	const language = determineLanguage(languageId);
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

	// A regex written inside a comment or a string is an example, not
	// code — see `mask`. The test is on where a candidate *starts*, so a
	// real call keeps its quoted argument.
	const prose = proseSpans(text, language);

	// JavaScript, TypeScript and Ruby are the grammars with a bare
	// `/…/`, and the only ones the slash-versus-division walk runs for.
	if (language === undefined || hasSlashLiterals(language)) {
		scanLiterals(text, prose, push);
	}
	if (
		language === undefined ||
		language === 'javascript' ||
		language === 'typescript'
	) {
		scanConstructors(text, prose, push);
	}
	for (const form of callForms(language)) {
		scanCallForm(form, text, prose, push);
	}

	patterns.sort((a, b) =>
		a.line !== b.line ? a.line - b.line : a.column - b.column,
	);
	return Object.freeze(patterns);
}

type Push = (
	pattern: string,
	flags: string,
	offset: number,
	match: string,
) => void;

function scanLiterals(text: string, prose: readonly Span[], push: Push): void {
	LITERAL.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = LITERAL.exec(text)) !== null) {
		const full = m[0];
		const body = full.slice(1, full.lastIndexOf('/'));
		const flags = full.slice(full.lastIndexOf('/') + 1);
		if (isProse(prose, m.index) || !isRegexContext(text, m.index)) {
			continue;
		}
		if (!isValidFlagString(flags) || !compiles(body, flags)) {
			continue;
		}
		push(body, flags, m.index, full);
	}
}

function scanConstructors(
	text: string,
	prose: readonly Span[],
	push: Push,
): void {
	CONSTRUCTOR.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = CONSTRUCTOR.exec(text)) !== null) {
		if (isProse(prose, m.index)) {
			continue;
		}
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
}

function scanCallForm(
	form: CallForm,
	text: string,
	prose: readonly Span[],
	push: Push,
): void {
	form.matcher.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = form.matcher.exec(text)) !== null) {
		// The *call* must start in code. Its argument is a string by
		// definition, which is why this is not a blanket string rule.
		if (isProse(prose, m.index)) {
			continue;
		}
		const body = callBody(m.groups);
		if (body === undefined) {
			continue;
		}
		const pattern = form.delimited ? stripPhpDelimiters(body) : body;
		// The validity judge is the language-tolerant one: JavaScript is
		// the only engine here, and a Python or Go pattern it refuses is
		// far more often valid than a typo.
		if (
			pattern === undefined ||
			pattern.length === 0 ||
			!isWellFormed(pattern, '')
		) {
			continue;
		}
		push(pattern, '', m.index, m[0]);
	}
}

/**
 * The pattern a call form captured, unescaped when the language's string
 * literal escapes.
 */
function callBody(
	groups: Record<string, string | undefined> | undefined,
): string | undefined {
	if (groups === undefined) {
		return undefined;
	}
	for (const name of RAW_GROUPS) {
		const value = groups[name];
		if (value !== undefined) {
			return value;
		}
	}
	for (const name of ESCAPED_GROUPS) {
		const value = groups[name];
		if (value !== undefined) {
			return unescapeStringLiteral(value);
		}
	}
	return undefined;
}

/** PCRE's modifier letters, PHP-flavoured. */
const PHP_MODIFIERS = 'imsxeADSUXJnu';

/**
 * Strip the delimiters PHP writes inside the pattern string —
 * '/(a+)+/i', '#a+#', '~a+~u', '{a+}'.
 *
 * The modifiers are dropped rather than reported as flags: PHP's set is
 * not JavaScript's, and handing `x` to a JavaScript engine would report
 * a working PCRE pattern as a syntax error. The bracket pairs and the
 * common single-character delimiters are handled; a delimiter that is a
 * letter or a digit is not one PHP accepts, and is refused rather than
 * guessed at.
 */
function stripPhpDelimiters(value: string): string | undefined {
	const open = value[0];
	if (open === undefined || /[A-Za-z0-9\\\s]/.test(open)) {
		return undefined;
	}
	const close =
		open === '('
			? ')'
			: open === '{'
				? '}'
				: open === '['
					? ']'
					: open === '<'
						? '>'
						: open;
	const end = value.lastIndexOf(close);
	if (end <= 0) {
		return undefined;
	}
	const modifiers = value.slice(end + 1);
	if (!Array.from(modifiers).every((c) => PHP_MODIFIERS.includes(c))) {
		return undefined;
	}
	return value.slice(1, end);
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
