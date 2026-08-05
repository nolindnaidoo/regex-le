import { extractRegexPatterns } from '../extraction/regex/extractPatterns';
import { detectReDoS } from '../extraction/regex/redos';
import {
	analysisFailed,
	capped,
	DEFAULT_MAX_RESULTS,
	type Diagnostic,
	envelope,
	MAX_MAX_RESULTS,
	readMaxResults,
	readString,
} from './envelope';
import type { ToolDefinition } from './transport';

/**
 * The tools this server exposes.
 *
 * Names are a public API with no deprecation channel — once an agent's prompt
 * or memory references `extract_patterns`, renaming it breaks silently. They
 * are pinned by a golden test for that reason.
 *
 * There is one tool rather than two. Splitting extraction from ReDoS analysis
 * would make the common request — "are any of the regexes in this file
 * dangerous?" — two round trips and force the caller to thread patterns back
 * in, so the verdict travels with the pattern it belongs to.
 *
 * No tool touches the filesystem. The agent already has file-read tools;
 * duplicating them here would add a path-traversal surface for no capability.
 */

const MAX_RESULTS_SCHEMA = {
	type: 'integer',
	minimum: 1,
	maximum: MAX_MAX_RESULTS,
	default: DEFAULT_MAX_RESULTS,
	description: `Cap on returned patterns (default ${DEFAULT_MAX_RESULTS}). meta.truncated reports whether any were dropped.`,
};

function extract(args: Record<string, unknown>): Promise<unknown> {
	const content = readString(args, 'content');
	const maxResults = readMaxResults(args);

	const found = extractRegexPatterns(content);
	const { items, truncated } = capped(found, maxResults);

	const diagnostics: Diagnostic[] = [];
	const analysed = items.map((item) => {
		// A pattern that defeats the analyser is still a real finding: report it
		// without a verdict rather than dropping it or failing the whole scan.
		try {
			const redos = detectReDoS(item.pattern, item.flags);
			return {
				pattern: item.pattern,
				flags: item.flags,
				match: item.match,
				line: item.line,
				column: item.column,
				redos: {
					detected: redos.detected,
					severity: redos.severity,
					reason: redos.reason,
				},
			};
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			diagnostics.push(analysisFailed(item.pattern, reason));
			return {
				pattern: item.pattern,
				flags: item.flags,
				match: item.match,
				line: item.line,
				column: item.column,
				redos: undefined,
			};
		}
	});

	return Promise.resolve(
		envelope(
			'extract_patterns',
			{ patterns: analysed },
			analysed.length,
			diagnostics,
			truncated,
		),
	);
}

export const TOOLS: readonly ToolDefinition[] = Object.freeze([
	Object.freeze({
		name: 'extract_patterns',
		description:
			'Extract every regular expression from source code — literals and RegExp constructors — with its flags, 1-based position, and a ReDoS verdict saying whether the pattern can be driven into catastrophic backtracking. Duplicate pattern-and-flags pairs are reported once, at first occurrence: the output is a pattern list, not an occurrence list.',
		inputSchema: {
			type: 'object',
			properties: {
				content: {
					type: 'string',
					description: 'The source text to scan.',
				},
				maxResults: MAX_RESULTS_SCHEMA,
			},
			required: ['content'],
			additionalProperties: false,
		},
		handler: extract,
	}),
]);
