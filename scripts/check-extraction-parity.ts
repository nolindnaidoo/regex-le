/**
 * Fails when the extension's pattern extraction or its ReDoS verdicts
 * drift from the shared corpus, which the Rust CLI (crate/) also builds
 * against.
 *
 * - extraction.json `documents`: every pattern found in each corpus
 *   document, with flags, position, the matched text, and its verdict.
 * - extraction.json `redos`: the detector over the shapes it exists to
 *   catch, the shapes it must not flag, and the invalid patterns that
 *   are a syntax error rather than a vulnerability.
 * - extraction.json `heuristics`: flag validation, compilability, and
 *   the slash-is-division context test — the three things a second
 *   implementation is most likely to get subtly wrong.
 * - mcp-extract-patterns.json: the `extract_patterns` tool, which BOTH
 *   MCP servers offer and must answer identically.
 *
 * This checks only the extension's side. `cargo test` runs the crate's
 * implementation over the same files.
 *
 * Run: bun scripts/check-extraction-parity.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractRegexPatterns } from '../src/extraction/regex/extractPatterns';
import {
	compiles,
	isRegexContext,
	isValidFlagString,
} from '../src/extraction/regex/heuristics';
import { detectReDoS } from '../src/extraction/regex/redos';
import { TOOLS } from '../src/mcp/tools';

const ROOT = join(import.meta.dir, '..');
/** The corpus lives inside the crate so the published package is self-contained. */
const CORPUS = join(ROOT, 'crate', 'fixtures');
const failures: string[] = [];

function fail(message: string): void {
	failures.push(message);
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		return a.every((item, i) => deepEqual(item, b[i]));
	}
	if (typeof a !== 'object' || typeof b !== 'object') return false;
	if (a === null || b === null) return false;
	const keysA = Object.keys(a).sort();
	const keysB = Object.keys(b).sort();
	if (!deepEqual(keysA, keysB)) return false;
	return keysA.every((key) =>
		deepEqual(
			(a as Record<string, unknown>)[key],
			(b as Record<string, unknown>)[key],
		),
	);
}

function asJson(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

function readCorpus(name: string): unknown {
	return JSON.parse(readFileSync(join(CORPUS, name), 'utf8'));
}

function readDocument(file: string): string {
	return readFileSync(join(CORPUS, 'documents', file), 'utf8');
}

function checkDocuments(): void {
	const corpus = readCorpus('extraction.json') as Readonly<{
		documents: ReadonlyArray<{
			name: string;
			file: string;
			expected: readonly unknown[];
		}>;
	}>;

	for (const testCase of corpus.documents) {
		const actual = extractRegexPatterns(readDocument(testCase.file)).map(
			(pattern) => ({
				pattern: pattern.pattern,
				flags: pattern.flags,
				line: pattern.line,
				column: pattern.column,
				match: pattern.match,
				redos: asJson(detectReDoS(pattern.pattern, pattern.flags)),
			}),
		);
		if (!deepEqual(actual, testCase.expected)) {
			fail(
				`documents "${testCase.name}":\n  expected: ${JSON.stringify(testCase.expected)}\n  got:      ${JSON.stringify(actual)}`,
			);
		}
	}
}

function checkRedos(): void {
	const corpus = readCorpus('extraction.json') as Readonly<{
		redos: ReadonlyArray<{
			pattern: string;
			flags: string;
			expected: unknown;
		}>;
	}>;

	for (const testCase of corpus.redos) {
		const actual = asJson(detectReDoS(testCase.pattern, testCase.flags));
		if (!deepEqual(actual, testCase.expected)) {
			fail(
				`redos ${JSON.stringify(testCase.pattern)} /${testCase.flags}:\n  expected: ${JSON.stringify(testCase.expected)}\n  got:      ${JSON.stringify(actual)}`,
			);
		}
	}
}

function checkHeuristics(): void {
	const corpus = readCorpus('extraction.json') as Readonly<{
		heuristics: Readonly<{
			isValidFlagString: ReadonlyArray<{ input: string; expected: boolean }>;
			compiles: ReadonlyArray<{
				pattern: string;
				flags: string;
				expected: boolean;
			}>;
			isRegexContext: ReadonlyArray<{
				text: string;
				offset: number;
				expected: boolean;
			}>;
		}>;
	}>;

	for (const testCase of corpus.heuristics.isValidFlagString) {
		const actual = isValidFlagString(testCase.input);
		if (actual !== testCase.expected) {
			fail(
				`isValidFlagString ${JSON.stringify(testCase.input)}: expected ${testCase.expected}, got ${actual}`,
			);
		}
	}
	for (const testCase of corpus.heuristics.compiles) {
		const actual = compiles(testCase.pattern, testCase.flags);
		if (actual !== testCase.expected) {
			fail(
				`compiles ${JSON.stringify(testCase.pattern)} /${testCase.flags}: expected ${testCase.expected}, got ${actual}`,
			);
		}
	}
	for (const testCase of corpus.heuristics.isRegexContext) {
		const actual = isRegexContext(testCase.text, testCase.offset);
		if (actual !== testCase.expected) {
			fail(
				`isRegexContext ${JSON.stringify(testCase.text)} @${testCase.offset}: expected ${testCase.expected}, got ${actual}`,
			);
		}
	}
}

/**
 * `extract_patterns` is offered by BOTH MCP servers. They are meant to
 * be the same tool, not two similar ones, so the same corpus runs
 * against both: this function here, and `crate/src/mcp/extract.rs`'s own
 * test there.
 */
async function checkMcpExtractPatterns(): Promise<void> {
	const cases = readCorpus('mcp-extract-patterns.json') as ReadonlyArray<{
		name: string;
		file?: string;
		content?: string;
		arguments: Record<string, unknown>;
		expected?: unknown;
		expectedError?: string;
	}>;

	const tool = TOOLS.find((t) => t.name === 'extract_patterns');
	if (!tool) {
		fail('the extension no longer offers extract_patterns');
		return;
	}

	for (const testCase of cases) {
		const args: Record<string, unknown> = { ...testCase.arguments };
		if (testCase.file !== undefined) args.content = readDocument(testCase.file);
		else if (testCase.content !== undefined) args.content = testCase.content;

		if (testCase.expectedError !== undefined) {
			try {
				await tool.handler(args);
				fail(
					`mcp extract "${testCase.name}": expected it to fail with ${JSON.stringify(testCase.expectedError)}`,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message !== testCase.expectedError) {
					fail(
						`mcp extract "${testCase.name}": expected error ${JSON.stringify(testCase.expectedError)}, got ${JSON.stringify(message)}`,
					);
				}
			}
			continue;
		}

		const actual = asJson(await tool.handler(args));
		if (!deepEqual(actual, testCase.expected)) {
			fail(
				`mcp extract "${testCase.name}":\n  expected: ${JSON.stringify(testCase.expected)}\n  got:      ${JSON.stringify(actual)}`,
			);
		}
	}
}

checkDocuments();
checkRedos();
checkHeuristics();
await checkMcpExtractPatterns();

if (failures.length > 0) {
	console.error(`Extraction parity FAILED (${failures.length}):\n`);
	for (const failure of failures) {
		console.error(`- ${failure}\n`);
	}
	process.exit(1);
}
console.log(
	'OK: every corpus case reproduces under the extension, and both MCP servers agree.',
);
