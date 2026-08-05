/**
 * The one result shape every tool returns.
 *
 * The engines across the family disagree — some async, some sync, six different
 * result envelopes. Normalising here rather than in the engines keeps the
 * characterization goldens untouched and the extension's behaviour unchanged.
 */
export interface ToolEnvelope<T> {
	readonly ok: boolean;
	readonly data: T;
	readonly diagnostics: readonly Diagnostic[];
	readonly meta: EnvelopeMeta;
}

export interface Diagnostic {
	readonly severity: 'warning' | 'error';
	readonly code: string;
	readonly message: string;
}

export interface EnvelopeMeta {
	readonly tool: string;
	readonly count: number;
	readonly truncated: boolean;
}

/**
 * Result caps, in units of "what fits in a context window".
 *
 * These are not performance limits — the engines are fast enough that the cap
 * never binds for speed. They exist because the consumer is a language model
 * with a finite context, and an unbounded result is the difference between a
 * useful answer and a conversation that dies mid-sentence. 500 rows is roughly
 * a few thousand tokens; the 5,000 ceiling is the point past which no realistic
 * context survives the response.
 *
 * The default is a starting point rather than a policy: a caller who has read
 * `meta.truncated` and genuinely wants more can ask for it, up to the ceiling.
 */
export const DEFAULT_MAX_RESULTS = 500;
export const MAX_MAX_RESULTS = 5000;

/**
 * `ok` is not `success`.
 *
 * `extractRegexPatterns` has no failure mode and no error channel: it scans
 * text and returns what it found, so a document with no regexes is an empty
 * result rather than a problem. Diagnostics here come from analysing an
 * individual pattern, which can fail without the scan having failed.
 */
export function isOk(diagnostics: readonly Diagnostic[]): boolean {
	return !diagnostics.some((d) => d.severity === 'error');
}

/** A diagnostic for a pattern the safety analysis could not read. */
export function analysisFailed(pattern: string, reason: string): Diagnostic {
	return {
		severity: 'warning',
		code: 'analysis',
		message: `Could not analyse ${pattern}: ${reason}`,
	};
}

/**
 * Apply the result cap, reporting honestly whether anything was dropped.
 *
 * The `truncated` flag matters more than the cap. Silently returning the first
 * 500 of 900 matches produces an answer that is wrong in the most expensive
 * way: confidently incomplete, with nothing to indicate it. A model told the
 * result was truncated can narrow its input or raise the cap; one that is not
 * told will state a count that is simply false.
 */
export function capped<T>(
	items: readonly T[],
	maxResults: number,
): { readonly items: readonly T[]; readonly truncated: boolean } {
	if (items.length <= maxResults) {
		return { items, truncated: false };
	}
	return { items: items.slice(0, maxResults), truncated: true };
}

export function envelope<T>(
	tool: string,
	data: T,
	count: number,
	diagnostics: readonly Diagnostic[],
	truncated: boolean,
): ToolEnvelope<T> {
	return {
		ok: isOk(diagnostics),
		data,
		diagnostics,
		meta: { tool, count, truncated },
	};
}

/**
 * Read a bounded integer argument, rejecting values a tool cannot honour.
 *
 * Note the asymmetry: a nonsensical value (zero, negative, fractional, a
 * string) throws, while a merely excessive one is clamped. The first is a bug
 * in the caller that it needs to hear about; the second is a caller asking for
 * everything, which is reasonable, and refusing it would be pedantry that costs
 * a round trip. Clamp quietly, reject loudly.
 */
export function readMaxResults(args: Record<string, unknown>): number {
	const raw = args.maxResults;
	if (raw === undefined) return DEFAULT_MAX_RESULTS;
	if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
		throw new Error('maxResults must be a positive integer');
	}
	return Math.min(raw, MAX_MAX_RESULTS);
}

/**
 * Read a required string argument with a message naming the argument.
 *
 * The message names the argument because the caller is a model choosing what to
 * send next. "content is required and must be a string" is actionable;
 * "invalid arguments" costs an entire retry to learn nothing.
 */
export function readString(
	args: Record<string, unknown>,
	name: string,
): string {
	const value = args[name];
	if (typeof value !== 'string') {
		throw new Error(`${name} is required and must be a string`);
	}
	return value;
}
