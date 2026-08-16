/**
 * Exponential backtracking, decided rather than guessed.
 *
 * **The property is ambiguity, not nesting.** A backtracking engine goes
 * exponential on a loop when one string can be consumed by that loop in
 * more than one way, because every way is a branch it may have to try.
 * `(a+)+` is such a loop — `"aa"` splits as `a|a` or `aa`. `(?:-[a-z]+)*`
 * is not: every iteration must eat a `-` the inner class cannot produce,
 * so the split is forced. Star height is identical in both, which is why
 * a shape test reported the second `high` and missed `(.*a){20}`.
 *
 * **The verdict is a demonstration, not a classification.** The pattern
 * is compiled to an NFA and that NFA is walked the way a backtracking
 * engine walks one — depth-first, every edge in order, a dead end
 * unwound rather than remembered — while the steps are counted. An
 * attack string is built, pumped, and measured at two lengths. A pattern
 * is reported only when a concrete input drove the count past its
 * budget, and that input is reported with it as `witness`.
 *
 * So a finding here is falsifiable: run the witness and watch. Nothing
 * is reported on the strength of how a pattern is shaped, which is what
 * the star-height rule this replaces did — it called `(?:-[a-z]+)*`
 * dangerous, missed `(.*a){20}` entirely, and scored 6 of 20 against
 * measured truth. This scores 20 of 20; `ambiguity.test.ts` holds it
 * there against `crate/fixtures/redos-truth.json`, whose `measured`
 * column comes from timing a real engine, not from this code.
 *
 * Three things decide the outcome, and each is a way to be wrong:
 *
 * - **The attack string needs a prefix that reaches the loop.** A loop
 *   behind a literal — `say "([a-z]+)*"` — is never entered by a string
 *   of nothing but the pumped core, and the pattern measures flat.
 * - **The tail must fail.** A blow-up only shows on a failing match:
 *   `(a+)+` succeeds on any input holding an `a` and never backtracks,
 *   while `(a+)+b` has to try every split before giving up.
 * - **Anchors are not nothing.** Dropping `^` and `$` models every
 *   anchored pattern as unanchored, and an unanchored loop usually
 *   matches empty at position 0 and returns at once.
 *
 * What cannot be demonstrated is named rather than guessed at. A pattern
 * this cannot read is reported as undecided, never as safe.
 *
 * The pattern itself is never handed to a regex engine, here or in the
 * tests: only this automaton is walked, under a step budget it cannot
 * exceed. No clock is read, so the answer is the same on every machine
 * and the same as the crate's.
 */

import {
	MAX_CODE_POINT,
	type Node,
	parse,
	type Range,
	type Ranges,
	type Refusal,
	refuse,
} from './patternSyntax';

/** A demonstrated blow-up: the input that does it, and what it cost. */
export type Decision =
	| Readonly<{ kind: 'blowup'; witness: string; low: number; high: number }>
	| Readonly<{ kind: 'clean' }>
	| Refusal;

/**
 * The step ceiling. An engine that has taken this many steps on a string
 * this short has already lost. A budget, not a timing, so the answer is
 * the same on every machine.
 */
const STEP_BUDGET = 2_000_000;
/**
 * The two pump lengths. Doubling the input should at most double the
 * work; exponential blows the budget outright.
 */
const PUMP_LOW = 14;
const PUMP_HIGH = 40;
/** What counts as a blow-up between them. Linear is ~2x, quadratic ~4x. */
const BLOWUP_RATIO = 1_000;
/** The longest concrete prefix worth building to reach a loop. */
const MAX_PREFIX = 4_096;
/** The automaton's ceiling, past which the pattern is refused. */
const MAX_STATES = 4_000;
/**
 * A counted repetition is unrolled, because `{20}` of an ambiguous body
 * is twenty chances to split the same string — which is exactly what
 * `(.*a){20}` is, and exactly what a rule keyed on "unbounded" could not
 * see. The bound keeps a hostile `{100000}` from unrolling the process
 * out of memory.
 */
const MAX_UNROLL = 64;

/** What crossing an edge requires. Numbers: this is walked millions of times. */
const EPSILON = 0;
const SYMBOL = 1;
const AT_START = 2;
const AT_END = 3;

interface Edge {
	readonly kind: number;
	/** Which alphabet class, for `SYMBOL`; unused otherwise. */
	readonly symbol: number;
	readonly to: number;
}

interface Nfa {
	/** Outgoing edges per state, in the order they were written. */
	readonly edges: Edge[][];
	/** The code points each symbol stands for, so the walk needs nothing else. */
	readonly alphabet: Ranges;
}

type Fragment = readonly [entry: number, exit: number];

/**
 * Decide the pattern by demonstration.
 *
 * **Nothing is reported that has not been shown.** A structural rule can
 * only say a shape looks dangerous, and both shapes and automata
 * over-report: the prefix-anchored idioms that defeat them are safe
 * because a separator forces the split, which is a fact about strings
 * rather than about syntax. So the question asked here is the one that
 * matters — is there an input that makes this blow up — and the answer
 * carries that input.
 */
export function decide(pattern: string): Decision {
	const node = parse(pattern);
	if (node.kind === 'undecided') return node;

	const symbols = alphabet(node);
	const nfa: Nfa = { edges: [], alphabet: symbols };
	const fragment = compile(nfa, node, symbols);
	if (fragment === undefined) return refuse('tooLarge');

	const [entry, exit] = fragment;
	for (const [prefix, core, tail] of candidates(node, symbols)) {
		const lowInput = prefix + core.repeat(PUMP_LOW) + tail;
		const highInput = prefix + core.repeat(PUMP_HIGH) + tail;
		const low = steps(nfa, entry, exit, lowInput);
		const high = steps(nfa, entry, exit, highInput);
		if (
			high === STEP_BUDGET ||
			Math.floor(high / Math.max(low, 1)) >= BLOWUP_RATIO
		) {
			return Object.freeze({ kind: 'blowup', witness: highInput, low, high });
		}
	}
	return Object.freeze({ kind: 'clean' });
}

// ---------------------------------------------------------------------
// Alphabet
// ---------------------------------------------------------------------

/**
 * Every class in the pattern, cut into disjoint intervals.
 *
 * Two characters that no class tells apart behave identically, so the
 * automaton only ever needs one symbol per equivalence class. This keeps
 * the product walk over `.` — a million code points — the same size as
 * one over `a`.
 */
function alphabet(node: Node): Ranges {
	const cuts = [0];
	collectCuts(node, cuts);
	cuts.push(MAX_CODE_POINT + 1);
	cuts.sort((a, b) => a - b);

	const out: Range[] = [];
	for (let i = 0; i + 1 < cuts.length; i++) {
		const low = cuts[i] ?? 0;
		const next = cuts[i + 1] ?? 0;
		if (low === next || low > MAX_CODE_POINT) continue;
		out.push([low, next - 1]);
	}
	return out;
}

function collectCuts(node: Node, cuts: number[]): void {
	if (node.kind === 'class') {
		for (const [low, high] of node.ranges) {
			cuts.push(low, high + 1);
		}
		return;
	}
	if (node.kind === 'concat' || node.kind === 'alt') {
		for (const part of node.parts) {
			collectCuts(part, cuts);
		}
		return;
	}
	if (node.kind === 'repeat') collectCuts(node.node, cuts);
}

/** The alphabet classes this set of ranges wholly contains. */
function symbolsOf(ranges: Ranges, symbols: Ranges): number[] {
	const out: number[] = [];
	symbols.forEach(([low, high], index) => {
		if (ranges.some(([from, to]) => from <= low && high <= to)) out.push(index);
	});
	return out;
}

// ---------------------------------------------------------------------
// Automaton
// ---------------------------------------------------------------------

/**
 * A new state, or nothing once the ceiling is passed.
 *
 * The crate compiles the whole automaton and measures it afterwards. The
 * count only ever grows, so stopping at the ceiling reaches the same
 * verdict without first allocating the millions of states a pattern like
 * `(?:(?:(?:a{64}){64}){64})` asks for.
 */
function addState(nfa: Nfa): number | undefined {
	if (nfa.edges.length >= MAX_STATES) return undefined;
	nfa.edges.push([]);
	return nfa.edges.length - 1;
}

function link(
	nfa: Nfa,
	from: number,
	kind: number,
	symbol: number,
	to: number,
): void {
	nfa.edges[from]?.push({ kind, symbol, to });
}

/** Compile, returning the fragment's entry and exit. */
function compile(nfa: Nfa, node: Node, symbols: Ranges): Fragment | undefined {
	if (node.kind === 'empty') {
		const state = addState(nfa);
		return state === undefined ? undefined : [state, state];
	}
	if (node.kind === 'start' || node.kind === 'end') {
		const entry = addState(nfa);
		const exit = addState(nfa);
		if (entry === undefined || exit === undefined) return undefined;
		link(nfa, entry, node.kind === 'start' ? AT_START : AT_END, 0, exit);
		return [entry, exit];
	}
	if (node.kind === 'class') {
		const entry = addState(nfa);
		const exit = addState(nfa);
		if (entry === undefined || exit === undefined) return undefined;
		for (const symbol of symbolsOf(node.ranges, symbols)) {
			link(nfa, entry, SYMBOL, symbol, exit);
		}
		return [entry, exit];
	}
	if (node.kind === 'concat') return compileConcat(nfa, node.parts, symbols);
	if (node.kind === 'alt') return compileAlt(nfa, node.parts, symbols);
	return compileRepeat(nfa, node.node, node.min, node.max, symbols);
}

function compileConcat(
	nfa: Nfa,
	parts: readonly Node[],
	symbols: Ranges,
): Fragment | undefined {
	const entry = addState(nfa);
	if (entry === undefined) return undefined;

	let at = entry;
	for (const part of parts) {
		const fragment = compile(nfa, part, symbols);
		if (fragment === undefined) return undefined;
		link(nfa, at, EPSILON, 0, fragment[0]);
		at = fragment[1];
	}
	return [entry, at];
}

function compileAlt(
	nfa: Nfa,
	branches: readonly Node[],
	symbols: Ranges,
): Fragment | undefined {
	const entry = addState(nfa);
	const exit = addState(nfa);
	if (entry === undefined || exit === undefined) return undefined;

	for (const branch of branches) {
		const fragment = compile(nfa, branch, symbols);
		if (fragment === undefined) return undefined;
		link(nfa, entry, EPSILON, 0, fragment[0]);
		link(nfa, fragment[1], EPSILON, 0, exit);
	}
	return [entry, exit];
}

function compileRepeat(
	nfa: Nfa,
	body: Node,
	min: number,
	max: number | undefined,
	symbols: Ranges,
): Fragment | undefined {
	const entry = addState(nfa);
	if (entry === undefined) return undefined;

	let at = entry;
	for (let i = 0; i < Math.min(min, MAX_UNROLL); i++) {
		const fragment = compile(nfa, body, symbols);
		if (fragment === undefined) return undefined;
		link(nfa, at, EPSILON, 0, fragment[0]);
		at = fragment[1];
	}
	if (max === undefined) {
		// A star over the body: back edge, and skippable.
		const fragment = compile(nfa, body, symbols);
		if (fragment === undefined) return undefined;
		const exit = addState(nfa);
		if (exit === undefined) return undefined;
		link(nfa, at, EPSILON, 0, fragment[0]);
		link(nfa, fragment[1], EPSILON, 0, fragment[0]);
		link(nfa, fragment[1], EPSILON, 0, exit);
		link(nfa, at, EPSILON, 0, exit);
		return [entry, exit];
	}

	const exit = addState(nfa);
	if (exit === undefined) return undefined;
	link(nfa, at, EPSILON, 0, exit);
	for (let i = 0; i < Math.min(Math.max(max - min, 0), MAX_UNROLL); i++) {
		const fragment = compile(nfa, body, symbols);
		if (fragment === undefined) return undefined;
		link(nfa, at, EPSILON, 0, fragment[0]);
		link(nfa, fragment[1], EPSILON, 0, exit);
		at = fragment[1];
	}
	return [entry, exit];
}

// ---------------------------------------------------------------------
// The attack strings
// ---------------------------------------------------------------------

/** Characters tried as a failing tail, in order of preference. */
const REJECTED_TAILS = [0, 0x21, 0x23, 0x7e];

/**
 * Attack strings to try: a prefix that reaches a loop, a repeatable
 * core, and a tail that fails.
 *
 * The core comes from the alphabet of the loop being attacked, because a
 * character that loop does not accept cannot drive it. The tail must be
 * rejected, which is what forces the engine to exhaust every split
 * before giving up — a blow-up only shows on a failing match.
 *
 * **The prefix is why `say "([a-z]+)*"` is caught.** Its loop sits
 * behind a literal, so an attack string of nothing but the core dies at
 * the `s` from every start position and the pattern measured flat.
 * Every loop is tried with a concrete string that reaches it.
 */
function candidates(
	node: Node,
	symbols: Ranges,
): ReadonlyArray<readonly [string, string, string]> {
	const rejected = String.fromCodePoint(
		REJECTED_TAILS.find((point) => !accepts(node, point)) ?? 0,
	);

	const reachable: Array<readonly [string, Node]> = [];
	loops(node, '', reachable);
	// The whole pattern with no prefix stays in the list: a bounded but
	// deeply nested repeat has no unbounded loop to find, and used to be
	// measured this way.
	reachable.push(['', node]);

	const out: Array<readonly [string, string, string]> = [];
	const seen = new Set<string>();
	for (const [prefix, target] of reachable) {
		for (const core of cores(target, symbols)) {
			const key = JSON.stringify([prefix, core]);
			if (seen.has(key)) continue;
			seen.add(key);
			out.push([prefix, core, rejected]);
		}
	}
	return out;
}

/** The strings worth pumping through one loop. */
function cores(target: Node, symbols: Ranges): readonly string[] {
	const accepted: number[] = [];
	for (const [low] of symbols) {
		if (isAsciiGraphic(low) && accepts(target, low)) accepted.push(low);
	}
	const out = accepted.slice(0, 6).map((point) => String.fromCodePoint(point));
	// A two-character core catches a loop whose body is a pair, like
	// `(?:ab)+`, which a single character cannot pump.
	if (accepted.length >= 2) {
		out.push(String.fromCodePoint(accepted[0] ?? 0, accepted[1] ?? 0));
	}
	if (out.length === 0) out.push('a');
	return out;
}

/**
 * Every unbounded repeat, each paired with a concrete string that
 * reaches it from the start of the pattern.
 */
function loops(
	node: Node,
	prefix: string,
	out: Array<readonly [string, Node]>,
): void {
	if (node.kind === 'repeat') {
		if (node.max === undefined) out.push([prefix, node.node]);
		// A loop nested inside this one is reached by the same prefix — the
		// outer loop can be entered zero times.
		loops(node.node, prefix, out);
		return;
	}
	if (node.kind === 'alt') {
		for (const part of node.parts) {
			loops(part, prefix, out);
		}
		return;
	}
	if (node.kind !== 'concat') return;

	let here = prefix;
	for (const part of node.parts) {
		loops(part, here, out);
		// Once a part has no concrete match, nothing after it can be
		// reached by a string this builds.
		const text = shortest(part);
		if (text === undefined) return;
		here += text;
	}
}

/**
 * A shortest concrete string this node matches.
 *
 * Used only to build a prefix, so an anchor contributes nothing rather
 * than failing — `^say (a+)+` is reached by `say ` at position 0.
 */
function shortest(node: Node): string | undefined {
	if (node.kind === 'empty' || node.kind === 'start' || node.kind === 'end') {
		return '';
	}
	if (node.kind === 'class') return shortestOfClass(node.ranges);
	if (node.kind === 'concat') {
		const parts = node.parts.map(shortest);
		if (parts.some((part) => part === undefined)) return undefined;
		return parts.join('');
	}
	if (node.kind === 'alt') {
		const found = node.parts
			.map(shortest)
			.filter((part): part is string => part !== undefined);
		return shortestOf(found);
	}
	if (node.min === 0) return '';

	// **A counted minimum is not a length to trust.** `a{4000000000}(b+)+c`
	// would build a four-billion-character prefix and emit it as a witness.
	// The automaton already approximates a repeat past `MAX_UNROLL`, so a
	// prefix that long could not be honest anyway: refusing to build one
	// leaves the loop unreached and the pattern undemonstrated, which is
	// the answer this gives when it cannot show its work.
	const body = shortest(node.node);
	if (body === undefined) return undefined;
	if (byteLength(body) * node.min > MAX_PREFIX) return undefined;
	return body.repeat(node.min);
}

function shortestOfClass(ranges: Ranges): string | undefined {
	for (const [low, high] of ranges) {
		const graphic = Math.max(low, 0x21);
		if (graphic <= Math.min(high, 0x7e)) return String.fromCodePoint(graphic);
	}
	for (const [low] of ranges) {
		// A lone surrogate is not a character; the crate's `char::from_u32`
		// rejects it and moves on to the next range.
		if (low < 0xd800 || low > 0xdfff) return String.fromCodePoint(low);
	}
	return undefined;
}

/** The shortest of several strings, measured as the crate measures — in bytes. */
function shortestOf(texts: readonly string[]): string | undefined {
	let best: string | undefined;
	let bestLength = Number.POSITIVE_INFINITY;
	for (const text of texts) {
		const length = byteLength(text);
		if (length >= bestLength) continue;
		best = text;
		bestLength = length;
	}
	return best;
}

function byteLength(text: string): number {
	let length = 0;
	for (const character of text) {
		const point = character.codePointAt(0) ?? 0;
		length += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
	}
	return length;
}

function isAsciiGraphic(point: number): boolean {
	return point >= 0x21 && point <= 0x7e;
}

/** Whether any class in the pattern admits this code point. */
function accepts(node: Node, point: number): boolean {
	if (node.kind === 'class') {
		return node.ranges.some(([low, high]) => low <= point && point <= high);
	}
	if (node.kind === 'concat' || node.kind === 'alt') {
		return node.parts.some((part) => accepts(part, point));
	}
	if (node.kind === 'repeat') return accepts(node.node, point);
	return false;
}

// ---------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------

/**
 * A step of the walk. `FRAME_LEAVE` is what makes the pruning
 * path-local: it is pushed under a state's edges, so the state is
 * released only once every path through it has been tried.
 */
const FRAME_ENTER = 0;
const FRAME_LEAVE = 1;

/**
 * How many steps a backtracking engine spends before it gives up.
 *
 * Depth-first over the automaton with no memoisation, which is what a
 * backtracking engine is: every edge tried in order, a dead end unwound
 * rather than remembered. Capped at `STEP_BUDGET`, which is also the
 * signal that the pattern lost.
 *
 * **The empty-iteration rule, and it is not an optimisation.** A real
 * engine abandons a loop iteration that consumed nothing, because
 * otherwise it never terminates. Without it this walk prefers the back
 * edge of `(\w*)+` forever and burns the budget, reporting a pattern
 * that every real engine runs in microseconds — a finding whose own
 * witness does not reproduce, which is the one thing this module must
 * never emit.
 *
 * The pruning is **path-local**: a state is blocked only while it is on
 * the current path, and released on the way back out. Blocking it
 * globally — a plain visited set that never releases — would memoise the
 * search into polynomial time and hide the very blow-up being measured,
 * and no corpus would catch that, because every exponential case would
 * go quiet in both frontends at once.
 */
function steps(nfa: Nfa, entry: number, exit: number, input: string): number {
	const chars = Array.from(input, (character) => character.codePointAt(0) ?? 0);
	const width = chars.length + 1;
	// Which (state, position) pairs are on the current path. Stamped with
	// the start position's generation rather than cleared, so beginning a
	// new search costs nothing.
	const stamp = new Uint32Array(nfa.edges.length * width);
	// Frame kind, state and position interleaved: one array, no allocation
	// per step.
	const stack: number[] = [];
	let spent = 0;
	let generation = 0;

	// **A search, not a full match.** An engine tries every start position
	// and stops at the first success, so an unanchored loop that matches
	// empty at position 0 returns at once — `(a{1,3})*` is not a hazard for
	// that reason, though it looks like one. Requiring the whole input to
	// be consumed reported it as exponential.
	for (let start = 0; start <= chars.length; start++) {
		generation += 1;
		stack.length = 0;
		stack.push(FRAME_ENTER, entry, start);
		while (stack.length > 0) {
			const at = stack.pop() ?? 0;
			const state = stack.pop() ?? 0;
			const kind = stack.pop() ?? 0;
			const mark = state * width + at;
			if (kind === FRAME_LEAVE) {
				stamp[mark] = 0;
				continue;
			}
			if (stamp[mark] === generation) continue;
			spent += 1;
			if (spent >= STEP_BUDGET) return STEP_BUDGET;
			if (state === exit) return spent;
			stamp[mark] = generation;
			stack.push(FRAME_LEAVE, state, at);
			follow(nfa, state, at, chars, stack);
		}
	}
	return spent;
}

/**
 * Push every edge out of a state, newest first.
 *
 * The stack reverses whatever it is given, so pushing in reverse is what
 * makes the walk try the alternatives in the order they were written —
 * which is the order a backtracking engine tries them.
 */
function follow(
	nfa: Nfa,
	state: number,
	at: number,
	chars: readonly number[],
	stack: number[],
): void {
	const edges = nfa.edges[state] ?? [];
	for (let i = edges.length - 1; i >= 0; i--) {
		const edge = edges[i];
		if (edge === undefined) continue;
		if (edge.kind === EPSILON) {
			stack.push(FRAME_ENTER, edge.to, at);
			continue;
		}
		if (edge.kind === AT_START) {
			if (at === 0) stack.push(FRAME_ENTER, edge.to, at);
			continue;
		}
		if (edge.kind === AT_END) {
			if (at === chars.length) stack.push(FRAME_ENTER, edge.to, at);
			continue;
		}
		const point = chars[at];
		const range = nfa.alphabet[edge.symbol];
		if (point === undefined || range === undefined) continue;
		if (point >= range[0] && point <= range[1]) {
			stack.push(FRAME_ENTER, edge.to, at + 1);
		}
	}
}
