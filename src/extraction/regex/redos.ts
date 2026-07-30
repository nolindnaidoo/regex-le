/**
 * ReDoS (Regular Expression Denial of Service) detection.
 *
 * Heuristic, structural detection of catastrophic-backtracking shapes:
 * - Nested unbounded quantifiers: a quantified group whose body also
 *   contains an unbounded quantifier — (a+)+, ([a-z]+)*, (\w*)+ — the
 *   classic exponential shape. Reported as high severity.
 * - Quantified alternation with overlapping branches: (a|a)*, (a|ab)+ —
 *   two branches that can match the same prefix inside a quantified
 *   group. Reported as medium severity.
 *
 * Honest scope: this is a scanner, not an automaton analysis. It cannot
 * prove a pattern safe — only flag the common dangerous shapes. Patterns
 * it does not recognize may still backtrack badly on adversarial input.
 */

export interface ReDoSResult {
	readonly detected: boolean;
	readonly severity: 'low' | 'medium' | 'high';
	readonly reason: string;
	readonly vulnerableGroups?: readonly string[] | undefined;
}

interface Group {
	readonly body: string;
	readonly quantifier: string | undefined;
}

/**
 * Check if a regex pattern is vulnerable to ReDoS
 */
export function detectReDoS(pattern: string, flags: string): ReDoSResult {
	try {
		new RegExp(pattern, flags);
	} catch {
		// Invalid regex - not a ReDoS issue, but a syntax error
		return Object.freeze({
			detected: false,
			severity: 'low',
			reason: 'Pattern is invalid',
		});
	}

	const groups = scanGroups(pattern);
	const nested = groups.filter(
		(g) =>
			g.quantifier !== undefined &&
			isUnbounded(g.quantifier) &&
			containsUnboundedQuantifier(g.body),
	);
	if (nested.length > 0) {
		return Object.freeze({
			detected: true,
			severity: 'high',
			reason: 'Nested unbounded quantifiers can cause exponential backtracking',
			vulnerableGroups: Object.freeze(
				nested.map((g) => `(${g.body})${g.quantifier}`),
			),
		});
	}

	const overlapping = groups.filter(
		(g) =>
			g.quantifier !== undefined &&
			isUnbounded(g.quantifier) &&
			hasOverlappingAlternation(g.body),
	);
	if (overlapping.length > 0) {
		return Object.freeze({
			detected: true,
			severity: 'medium',
			reason:
				'Quantified alternation with overlapping branches may backtrack heavily',
			vulnerableGroups: Object.freeze(
				overlapping.map((g) => `(${g.body})${g.quantifier}`),
			),
		});
	}

	return Object.freeze({
		detected: false,
		severity: 'low',
		reason: 'No obvious ReDoS vulnerabilities detected',
	});
}

/**
 * Collect every parenthesized group with its trailing quantifier (if
 * any), skipping escapes and character classes. Nested groups are each
 * reported with their full body text.
 */
function scanGroups(pattern: string): readonly Group[] {
	const groups: Group[] = [];
	const stack: number[] = [];
	let inClass = false;

	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === '\\') {
			i++;
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
		if (ch === '(') {
			stack.push(i);
			continue;
		}
		if (ch === ')') {
			const start = stack.pop();
			if (start === undefined) {
				continue;
			}
			const body = pattern.slice(start + 1, i);
			const quantifier = readQuantifier(pattern, i + 1);
			groups.push({ body: stripGroupPrefix(body), quantifier });
		}
	}

	return groups;
}

/** Read a quantifier starting at offset, or undefined. */
function readQuantifier(pattern: string, offset: number): string | undefined {
	const ch = pattern[offset];
	if (ch === '*' || ch === '+' || ch === '?') {
		return ch;
	}
	if (ch === '{') {
		const m = /^\{\d+(,\d*)?\}/.exec(pattern.slice(offset));
		return m ? m[0] : undefined;
	}
	return undefined;
}

/** True for quantifiers with no upper bound: * + {n,} */
function isUnbounded(quantifier: string): boolean {
	if (quantifier === '*' || quantifier === '+') {
		return true;
	}
	return /^\{\d+,\}$/.test(quantifier);
}

/** Drop (?: (?<name> (?= etc. prefixes so body inspection sees content. */
function stripGroupPrefix(body: string): string {
	return body.replace(/^\?(?::|<[^>=!][^>]*>|=|!|<=|<!)/, '');
}

/**
 * True when the group body contains an unbounded quantifier outside a
 * character class (the inner half of the nested-quantifier shape).
 */
function containsUnboundedQuantifier(body: string): boolean {
	let inClass = false;
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (ch === '\\') {
			i++;
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
		if (ch === '*' || ch === '+') {
			return true;
		}
		if (ch === '{' && /^\{\d+,\}/.test(body.slice(i))) {
			return true;
		}
	}
	return false;
}

/**
 * True when two top-level alternation branches start with the same
 * literal character — the simplest overlap that makes (a|ab)+ ambiguous.
 */
function hasOverlappingAlternation(body: string): boolean {
	const branches = splitTopLevelAlternation(body);
	if (branches.length < 2) {
		return false;
	}
	const firstChars = branches
		.map((b) => firstLiteralChar(b))
		.filter((c): c is string => c !== undefined);
	return new Set(firstChars).size < firstChars.length;
}

/** Split on | at nesting depth 0, outside classes and escapes. */
function splitTopLevelAlternation(body: string): readonly string[] {
	const branches: string[] = [];
	let depth = 0;
	let inClass = false;
	let current = '';

	for (let i = 0; i < body.length; i++) {
		const ch = body[i] ?? '';
		if (ch === '\\') {
			current += ch + (body[i + 1] ?? '');
			i++;
			continue;
		}
		if (inClass) {
			if (ch === ']') {
				inClass = false;
			}
			current += ch;
			continue;
		}
		if (ch === '[') {
			inClass = true;
			current += ch;
			continue;
		}
		if (ch === '(') {
			depth++;
		}
		if (ch === ')') {
			depth = Math.max(0, depth - 1);
		}
		if (ch === '|' && depth === 0) {
			branches.push(current);
			current = '';
			continue;
		}
		current += ch;
	}
	branches.push(current);
	return branches;
}

/** First literal character of a branch, if it starts with one. */
function firstLiteralChar(branch: string): string | undefined {
	const ch = branch[0];
	if (ch === undefined) {
		return undefined;
	}
	if (/[\w\s]/.test(ch)) {
		return ch;
	}
	return undefined;
}
