/**
 * `regex-le mcp`: the crate's MCP server (`crate/src/mcp/`), not the
 * extension's. It offers `regex_le_lint` beside the shared
 * `extract_patterns`, answers in the crate's words, and writes every reply
 * with its keys sorted, because the crate builds each one as a
 * `serde_json::Value` without `preserve_order`.
 */

import { sortedKeys } from '../mcp/envelope';
import { TOOLS } from '../mcp/tools';
import type { ScanOptions } from './args';
import { requests } from './frames';
import { type FileReport, scanFile } from './scan';
import { collect } from './walk';

const PROTOCOL_VERSION = '2025-06-18';
const INVALID_PARAMS = -32602;
const METHOD_NOT_FOUND = -32601;

type Handled =
	| { readonly result: unknown }
	| { readonly error: { readonly code: number; readonly message: string } };

type Diagnostic = Readonly<{ severity: string; code: string; message: string }>;

const SHARED = sharedTool('extract_patterns');

const LINT_DEFINITION = {
	name: 'regex_le_lint',
	description:
		'Find every regular expression in files or directories and report which of them can be driven into catastrophic backtracking. Reads the filesystem; never writes to it, and never runs a pattern. It flags dangerous shapes and cannot prove a pattern safe.',
	inputSchema: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'a file or directory to scan' },
			paths: {
				type: 'array',
				items: { type: 'string' },
				description: 'several files or directories, instead of `path`',
			},
			severity: {
				type: 'string',
				enum: ['high', 'medium'],
				default: 'medium',
				description: 'Count a pattern as a finding at this verdict or worse.',
			},
			all: {
				type: 'boolean',
				default: false,
				description:
					'Report every pattern, not only the vulnerable ones. The finding count does not change.',
			},
			hidden: {
				type: 'boolean',
				default: false,
				description: 'Walk hidden files and directories too.',
			},
			ignored: {
				type: 'boolean',
				default: false,
				description: 'Walk files excluded by .gitignore too.',
			},
		},
	},
};

/** The shared tool is the extension's, definition and handler both. */
function sharedTool(name: string) {
	const tool = TOOLS.find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`the extension offers no tool named ${name}`);
	return tool;
}

/**
 * Serves until stdin closes, one request at a time, in order, over the
 * crate's framing in `frames.ts`.
 */
export async function serve(
	input: AsyncIterable<Uint8Array>,
	write: (line: string) => void,
	version: string,
): Promise<number> {
	for await (const request of requests(input)) {
		const response = await handle(request, version);
		if (response !== undefined) write(`${response}\n`);
	}
	return 0;
}

function field(value: unknown, name: string): unknown {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return undefined;
	}
	return Object.hasOwn(value, name)
		? (value as Record<string, unknown>)[name]
		: undefined;
}

async function handle(
	request: unknown,
	version: string,
): Promise<string | undefined> {
	const id = field(request, 'id');
	const method = field(request, 'method');
	if (typeof method !== 'string') return undefined;
	// A notification carries no id and gets no reply.
	if (id === undefined) return undefined;

	const handled = await dispatch(method, field(request, 'params'), version);
	return JSON.stringify(sortedKeys({ jsonrpc: '2.0', id, ...handled }));
}

async function dispatch(
	method: string,
	params: unknown,
	version: string,
): Promise<Handled> {
	if (method === 'initialize') {
		return {
			result: {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: { name: 'regex-le', version },
			},
		};
	}
	if (method === 'tools/list') {
		return {
			result: {
				tools: [
					{
						name: SHARED.name,
						description: SHARED.description,
						inputSchema: SHARED.inputSchema,
					},
					LINT_DEFINITION,
				],
			},
		};
	}
	if (method === 'tools/call') return callTool(params);
	if (method === 'ping') return { result: {} };
	return {
		error: {
			code: METHOD_NOT_FOUND,
			message: `this server does not implement ${method}`,
		},
	};
}

/**
 * Protocol failures are JSON-RPC errors. A tool that fails on its arguments
 * returns a result carrying `isError`, so a model reads the reason rather than
 * concluding the server is broken.
 */
async function callTool(params: unknown): Promise<Handled> {
	if (params === undefined) {
		return {
			error: { code: INVALID_PARAMS, message: 'no tool call was supplied' },
		};
	}
	const name = field(params, 'name');
	if (typeof name !== 'string') {
		return {
			error: { code: INVALID_PARAMS, message: 'the tool call named no tool' },
		};
	}
	// serde_json answers `get` on anything but an object with nothing, so
	// arguments that are not an object read as an empty one.
	const raw = field(params, 'arguments');
	const args = isObject(raw) ? raw : {};
	if (name === 'extract_patterns') {
		return { result: await outcome(() => SHARED.handler(args)) };
	}
	if (name === 'regex_le_lint') {
		return { result: await outcome(async () => lint(args)) };
	}
	return {
		error: {
			code: INVALID_PARAMS,
			message: `this server offers no tool named ${name}`,
		},
	};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function outcome(tool: () => Promise<unknown>): Promise<unknown> {
	let envelope: unknown;
	try {
		envelope = sortedKeys(await tool());
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { content: [{ type: 'text', text: message }], isError: true };
	}
	return {
		content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
		structuredContent: envelope,
		isError: false,
	};
}

function lint(args: Record<string, unknown>): unknown {
	const inputs = requestedPaths(args);
	const walk = {
		hidden: args.hidden === true,
		respectIgnore: args.ignored !== true,
	};
	const options: ScanOptions = {
		threshold: threshold(args.severity),
		all: args.all === true,
	};
	const files = collect(inputs, walk);
	const reports: FileReport[] = [];
	for (const file of files) {
		const report = scanFile(file, options);
		if (report) reports.push(report);
	}
	const binary = files.length - reports.length;
	const findings = reports.reduce(
		(sum, each) => sum + each.summary.findings,
		0,
	);
	const diagnostics: Diagnostic[] = reports
		.filter((each) =>
			each.diagnostics.some((diagnostic) => diagnostic.severity === 'error'),
		)
		.map((each) => ({
			severity: 'warning',
			code: 'unreadable',
			message: `${each.file} could not be examined, so this scan does not cover it`,
		}));
	return {
		ok: true,
		data: { reports, findings, binary },
		diagnostics,
		meta: { tool: 'regex_le_lint', count: reports.length, truncated: false },
	};
}

/** Absent, or not a string, is medium; `low` is refused with its reason. */
function threshold(raw: unknown): ScanOptions['threshold'] {
	if (typeof raw !== 'string' || raw === 'medium') return 'medium';
	if (raw === 'high') return 'high';
	if (raw === 'low') {
		throw new Error(
			'low is not a threshold: every pattern has a verdict, so it would count every regex as a finding. Ask for all instead.',
		);
	}
	throw new Error(`${raw} is not a severity; one of: high, medium`);
}

function requestedPaths(args: Record<string, unknown>): readonly string[] {
	if (typeof args.path === 'string') return [args.path];
	if (Array.isArray(args.paths)) {
		const paths = args.paths.filter(
			(item): item is string => typeof item === 'string',
		);
		if (paths.length === 0) throw new Error('the list of paths was empty');
		return paths;
	}
	throw new Error('no file or directory was supplied to audit');
}
