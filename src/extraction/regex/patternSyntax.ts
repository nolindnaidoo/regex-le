/**
 * The pattern text, read as a tree an automaton can be built from.
 *
 * The grammar is the union of the spellings the extractor reads, not
 * JavaScript's alone: `(?P<name>...)` is Python's ordinary named group,
 * and refusing it would leave `(?P<w>\w+)+@` — the classic dangerous
 * shape — undecided on working code.
 *
 * **What cannot be read is named, never guessed at.** A backreference
 * and a lookaround are not regular languages, and syntax this does not
 * know could mean anything; each comes back as a refusal carrying its
 * reason, because a pattern read wrongly is a verdict invented.
 *
 * Bytes, not characters — the same reading the crate's parser does, so a
 * multi-byte character is the same run of classes on both sides.
 */

/** A set of code points, as sorted disjoint inclusive ranges. */
export type Range = readonly [number, number];
export type Ranges = readonly Range[];

export const MAX_CODE_POINT = 0x10ffff;

export type Node =
	/** Consumes nothing: a boundary, an empty alternative. */
	| Readonly<{ kind: 'empty' }>
	/**
	 * `^` and `$`. **Not `empty`.** Discarding them models every anchored
	 * pattern as unanchored, and an unanchored loop usually matches empty
	 * at position 0 and returns at once — so `^(a{2,4})+$` looked safe
	 * while `(a{1,3})*` looked dangerous. Both backwards.
	 */
	| Readonly<{ kind: 'start' }>
	| Readonly<{ kind: 'end' }>
	| Readonly<{ kind: 'class'; ranges: Ranges }>
	| Readonly<{ kind: 'concat'; parts: readonly Node[] }>
	| Readonly<{ kind: 'alt'; parts: readonly Node[] }>
	| Readonly<{
			kind: 'repeat';
			node: Node;
			min: number;
			max: number | undefined;
	  }>;

/** Why a pattern could not be decided. */
export const REFUSALS = Object.freeze({
	backreference: 'a backreference is not a regular language',
	lookaround: 'lookaround is not modelled by this construction',
	unsupported: 'the pattern uses syntax this cannot read',
	tooLarge: 'the pattern is too large to decide',
});

export type Refusal = Readonly<{ kind: 'undecided'; reason: string }>;

export function refuse(reason: keyof typeof REFUSALS): Refusal {
	return Object.freeze({ kind: 'undecided', reason: REFUSALS[reason] });
}

const ENCODER = new TextEncoder();

const code = (character: string): number => character.charCodeAt(0);

const OPEN_PAREN = code('(');
const CLOSE_PAREN = code(')');
const OPEN_BRACKET = code('[');
const CLOSE_BRACKET = code(']');
const OPEN_BRACE = code('{');
const CLOSE_BRACE = code('}');
const PIPE = code('|');
const STAR = code('*');
const PLUS = code('+');
const QUESTION = code('?');
const DOT = code('.');
const CARET = code('^');
const DOLLAR = code('$');
const DASH = code('-');
const COMMA = code(',');
const COLON = code(':');
const EQUALS = code('=');
const BANG = code('!');
const LESS_THAN = code('<');
const GREATER_THAN = code('>');
const BACKSLASH = code('\\');
const CAPITAL_P = code('P');
const ZERO = code('0');
const ONE = code('1');
const NINE = code('9');

const BACKREFERENCE_ESCAPES = new Set([code('k')]);
const BOUNDARY_ESCAPES = new Set([code('b'), code('B')]);
const SHORTHAND_ESCAPES = new Set(
	Array.from('dDwWsS', (character) => code(character)),
);
/** Escapes naming a code point this does not compute — refused, not guessed. */
const OPAQUE_ESCAPES = new Set(
	Array.from('uxcpP', (character) => code(character)),
);
const CONTROL_ESCAPES = new Map<number, number>([
	[code('n'), 10],
	[code('r'), 13],
	[code('t'), 9],
	[code('f'), 12],
	[code('v'), 11],
	[ZERO, 0],
]);

/** The widest count the crate's `u32` reads; past it, a brace is text. */
const MAX_COUNT = 0xffff_ffff;

const EMPTY: Node = Object.freeze({ kind: 'empty' });
const START: Node = Object.freeze({ kind: 'start' });
const END: Node = Object.freeze({ kind: 'end' });

function normalise(ranges: Ranges): Ranges {
	const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const out: Range[] = [];
	for (const [low, high] of sorted) {
		const last = out[out.length - 1];
		if (last && low <= last[1] + 1) {
			out[out.length - 1] = [last[0], Math.max(last[1], high)];
			continue;
		}
		out.push([low, high]);
	}
	return out;
}

function complement(ranges: Ranges): Ranges {
	const out: Range[] = [];
	let at = 0;
	for (const [low, high] of ranges) {
		if (low > at) {
			out.push([at, low - 1]);
		}
		at = high + 1;
	}
	if (at <= MAX_CODE_POINT) {
		out.push([at, MAX_CODE_POINT]);
	}
	return out;
}

const DIGIT_RANGES: Ranges = [[0x30, 0x39]];
const WORD_RANGES: Ranges = [
	[0x30, 0x39],
	[0x41, 0x5a],
	[0x5f, 0x5f],
	[0x61, 0x7a],
];
const SPACE_RANGES: Ranges = normalise([
	[9, 13],
	[32, 32],
	[0x00a0, 0x00a0],
	[0x2028, 0x2029],
	[0xfeff, 0xfeff],
]);

/**
 * **`\w`, `\d` and `\s` are spelled out rather than borrowed.** They are
 * ASCII in a JavaScript regex and Unicode in other engines, so taking
 * whichever the host happens to mean would answer for a language other
 * than the one whose pattern is being read.
 */
const ESCAPE_CLASSES: ReadonlyMap<number, Ranges> = new Map<number, Ranges>([
	[code('d'), DIGIT_RANGES],
	[code('D'), complement(DIGIT_RANGES)],
	[code('w'), WORD_RANGES],
	[code('W'), complement(WORD_RANGES)],
	[code('s'), SPACE_RANGES],
	[code('S'), complement(SPACE_RANGES)],
	[code('n'), [[10, 10]]],
	[code('r'), [[13, 13]]],
	[code('t'), [[9, 9]]],
	[code('f'), [[12, 12]]],
	[code('v'), [[11, 11]]],
]);

/** `.` — every code point but the line terminators. */
const DOT_RANGES: Ranges = normalise([
	[0, 9],
	[11, 12],
	[14, MAX_CODE_POINT],
]);

function escapeClass(byte: number): Ranges {
	return ESCAPE_CLASSES.get(byte) ?? [[byte, byte]];
}

function isDigit(byte: number | undefined): boolean {
	return byte !== undefined && byte >= ZERO && byte <= NINE;
}

type Bounds = Readonly<{ min: number; max: number | undefined }>;

type Member =
	| Readonly<{ kind: 'point'; value: number }>
	| Readonly<{ kind: 'whole'; ranges: Ranges }>;

type ClassResult = Readonly<{ kind: 'ranges'; ranges: Ranges }> | Refusal;

/**
 * Read a pattern, or say why it cannot be read.
 *
 * Recursive descent over the pattern's bytes, with the cursor held in a
 * closure so no function here mutates something it was handed.
 */
export function parse(pattern: string): Node | Refusal {
	const bytes = ENCODER.encode(pattern);
	let at = 0;

	const peek = (): number | undefined => bytes[at];
	const peekAt = (ahead: number): number | undefined => bytes[at + ahead];
	const bump = (): number | undefined => {
		const byte = bytes[at];
		if (byte === undefined) return undefined;
		at += 1;
		return byte;
	};
	const eat = (byte: number): boolean => {
		if (bytes[at] !== byte) return false;
		at += 1;
		return true;
	};

	function alternation(): Node | Refusal {
		const first = concat();
		if (first.kind === 'undecided') return first;

		const branches: Node[] = [first];
		while (eat(PIPE)) {
			const branch = concat();
			if (branch.kind === 'undecided') return branch;
			branches.push(branch);
		}
		if (branches.length === 1) return first;
		return { kind: 'alt', parts: branches };
	}

	function concat(): Node | Refusal {
		const parts: Node[] = [];
		for (let byte = peek(); byte !== undefined; byte = peek()) {
			if (byte === PIPE || byte === CLOSE_PAREN) break;
			const part = quantified();
			if (part.kind === 'undecided') return part;
			parts.push(part);
		}
		if (parts.length === 0) return EMPTY;
		if (parts.length === 1) return parts[0] ?? EMPTY;
		return { kind: 'concat', parts };
	}

	function quantified(): Node | Refusal {
		const node = atom();
		if (node.kind === 'undecided') return node;

		const bounds = quantifier();
		if (bounds === undefined) return node;
		// Lazy and possessive change which path is tried first, never how
		// many paths there are.
		if (peek() === QUESTION || peek() === PLUS) at += 1;
		return { kind: 'repeat', node, min: bounds.min, max: bounds.max };
	}

	function quantifier(): Bounds | undefined {
		const byte = peek();
		if (byte === STAR) {
			at += 1;
			return { min: 0, max: undefined };
		}
		if (byte === PLUS) {
			at += 1;
			return { min: 1, max: undefined };
		}
		if (byte === QUESTION) {
			at += 1;
			return { min: 0, max: 1 };
		}
		// A brace that is not a counter is a literal, which JavaScript
		// permits.
		if (byte === OPEN_BRACE) return counted();
		return undefined;
	}

	function counted(): Bounds | undefined {
		const start = at;
		at += 1;
		const min = number();
		const max = min === undefined ? undefined : upperBound(min);
		if (min === undefined || max === undefined || !eat(CLOSE_BRACE)) {
			at = start;
			return undefined;
		}
		return { min, max: max.value };
	}

	/** The `,n}` half of a counter; an absent `value` means unbounded. */
	function upperBound(
		min: number,
	): Readonly<{ value: number | undefined }> | undefined {
		if (!eat(COMMA)) return { value: min };
		if (peek() === CLOSE_BRACE) return { value: undefined };
		const max = number();
		if (max === undefined) return undefined;
		return { value: max };
	}

	function number(): number | undefined {
		const start = at;
		while (isDigit(peek())) at += 1;
		if (at === start) return undefined;

		let value = 0;
		for (let i = start; i < at; i++) {
			value = value * 10 + ((bytes[i] ?? ZERO) - ZERO);
			if (value > MAX_COUNT) return undefined;
		}
		return value;
	}

	function atom(): Node | Refusal {
		const byte = peek();
		if (byte === OPEN_PAREN) return group();
		if (byte === OPEN_BRACKET) {
			const result = characterClass();
			if (result.kind === 'undecided') return result;
			return { kind: 'class', ranges: result.ranges };
		}
		if (byte === DOT) {
			at += 1;
			return { kind: 'class', ranges: DOT_RANGES };
		}
		if (byte === CARET) {
			at += 1;
			return START;
		}
		if (byte === DOLLAR) {
			at += 1;
			return END;
		}
		if (byte === BACKSLASH) return escapeAtom();
		if (byte === STAR || byte === PLUS || byte === QUESTION) {
			return refuse('unsupported');
		}
		if (byte === undefined) return EMPTY;
		at += 1;
		return { kind: 'class', ranges: [[byte, byte]] };
	}

	function group(): Node | Refusal {
		at += 1;
		if (eat(QUESTION)) {
			const refusal = groupPrefix();
			if (refusal) return refusal;
		}
		const inner = alternation();
		if (inner.kind === 'undecided') return inner;
		if (!eat(CLOSE_PAREN)) return refuse('unsupported');
		return inner;
	}

	/** Consume what follows `(?`, or refuse it. */
	function groupPrefix(): Refusal | undefined {
		const byte = peek();
		if (byte === COLON) {
			at += 1;
			return undefined;
		}
		if (byte === EQUALS || byte === BANG) return refuse('lookaround');
		if (byte === LESS_THAN) {
			const after = peekAt(1);
			if (after === EQUALS || after === BANG) return refuse('lookaround');
			// `(?<name>` is an ordinary capture.
			at += 1;
			return skipName();
		}
		// `(?P<name>` is Python's spelling of the same thing, and `(?P=name)`
		// its backreference. Patterns are read from every language the
		// extractor finds one in, so refusing Python's syntax would leave
		// `(?P<w>\w+)+@` — the classic dangerous shape — undecided on
		// working code.
		if (byte === CAPITAL_P) {
			at += 1;
			if (peek() === EQUALS) return refuse('backreference');
			if (!eat(LESS_THAN)) return refuse('unsupported');
			return skipName();
		}
		return refuse('unsupported');
	}

	function skipName(): Refusal | undefined {
		while (!eat(GREATER_THAN)) {
			if (bump() === undefined) return refuse('unsupported');
		}
		return undefined;
	}

	function escapeAtom(): Node | Refusal {
		at += 1;
		const escaped = bump();
		if (escaped === undefined) return refuse('unsupported');
		if (escaped >= ONE && escaped <= NINE) return refuse('backreference');
		if (BACKREFERENCE_ESCAPES.has(escaped)) return refuse('backreference');
		// A boundary consumes nothing.
		if (BOUNDARY_ESCAPES.has(escaped)) return EMPTY;
		if (OPAQUE_ESCAPES.has(escaped)) return refuse('unsupported');
		return { kind: 'class', ranges: escapeClass(escaped) };
	}

	function characterClass(): ClassResult {
		at += 1;
		const negated = eat(CARET);
		const ranges: Range[] = [];
		let first = true;

		while (peek() !== undefined) {
			if (peek() === CLOSE_BRACKET && !first) {
				at += 1;
				const merged = normalise(ranges);
				return {
					kind: 'ranges',
					ranges: negated ? complement(merged) : merged,
				};
			}
			first = false;
			const member = classMember();
			if (member.kind === 'undecided') return member;
			const contributed = memberRanges(member);
			if (contributed.kind === 'undecided') return contributed;
			ranges.push(...contributed.ranges);
		}
		return refuse('unsupported');
	}

	/** One member's code points, reading a `a-z` range when one follows. */
	function memberRanges(member: Member): ClassResult {
		if (member.kind === 'whole') {
			return { kind: 'ranges', ranges: member.ranges };
		}
		const low = member.value;
		const dashed = peek() === DASH && peekAt(1) !== CLOSE_BRACKET;
		if (!dashed) return { kind: 'ranges', ranges: [[low, low]] };

		at += 1;
		const high = classMember();
		if (high.kind === 'undecided') return high;
		if (high.kind === 'point') {
			return {
				kind: 'ranges',
				ranges: [[Math.min(low, high.value), Math.max(low, high.value)]],
			};
		}
		// `[a-\d]` is not a range; JavaScript reads the dash as a literal.
		return {
			kind: 'ranges',
			ranges: [[low, low], [DASH, DASH], ...high.ranges],
		};
	}

	function classMember(): Member | Refusal {
		const byte = bump();
		if (byte === undefined) return refuse('unsupported');
		if (byte !== BACKSLASH) return { kind: 'point', value: byte };

		const escaped = bump();
		if (escaped === undefined) return refuse('unsupported');
		if (SHORTHAND_ESCAPES.has(escaped)) {
			return { kind: 'whole', ranges: escapeClass(escaped) };
		}
		if (OPAQUE_ESCAPES.has(escaped)) return refuse('unsupported');
		return { kind: 'point', value: CONTROL_ESCAPES.get(escaped) ?? escaped };
	}

	return alternation();
}
