/**
 * The MCP wire protocol, hand-rolled.
 *
 * `@modelcontextprotocol/sdk` was measured first and rejected: it pulls 60
 * packages and 5.9 MB into a repo whose entire shipped bundle is 66 KB, and
 * esbuild cannot resolve its subpath exports without marking them external —
 * which would break the self-contained-bundle invariant. These tools are pure
 * functions over a string: no resources, prompts, sampling, roots, or
 * notifications. That needs five methods, not a framework.
 *
 * Everything protocol-shaped lives here, so swapping back to the SDK later is a
 * one-file change rather than a rewrite.
 */

/**
 * Newline-delimited JSON-RPC 2.0 over stdio, which is what MCP stdio is.
 *
 * Note what is absent: no Content-Length framing. MCP's stdio transport is
 * line-delimited, unlike LSP's, and a server that copies LSP's framing will
 * hang a client forever without ever erroring — the client waits for a header
 * that never comes. This is the single most common way a hand-rolled MCP
 * server fails, and it fails silently.
 */
interface JsonRpcRequest {
	readonly jsonrpc: '2.0';
	readonly id?: number | string | null;
	readonly method: string;
	readonly params?: Record<string, unknown>;
}

export interface ToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
	readonly handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/** One JSON-RPC reply. `result` and `error` are mutually exclusive. */
export interface JsonRpcResponse {
	readonly jsonrpc: '2.0';
	// Required, not optional: a response is only built once the id is known, and
	// `exactOptionalPropertyTypes` rightly refuses an implicit undefined here.
	readonly id: number | string | null;
	readonly result?: Record<string, unknown>;
	readonly error?: { readonly code: number; readonly message: string };
}

export interface ServerInfo {
	readonly name: string;
	readonly version: string;
}

/**
 * The protocol revision this server speaks.
 *
 * Echoed back only when the client asks for it; otherwise the client's own
 * version is returned, which is what the specification requires for forward
 * compatibility.
 */
const SUPPORTED_PROTOCOL = '2025-06-18';

const PARSE_ERROR = -32700;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

function isRequest(value: unknown): value is JsonRpcRequest {
	if (typeof value !== 'object' || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return candidate.jsonrpc === '2.0' && typeof candidate.method === 'string';
}

/**
 * Build the responder for a tool set.
 *
 * Returns a function from one parsed request to one response, or null for a
 * notification — which by JSON-RPC has no reply, and answering one is the
 * classic way to wedge a client.
 */
export function createResponder(
	info: ServerInfo,
	tools: readonly ToolDefinition[],
) {
	const byName = new Map(tools.map((t) => [t.name, t]));

	const listing = tools.map((t) => ({
		name: t.name,
		description: t.description,
		inputSchema: t.inputSchema,
	}));

	async function callTool(
		params: Record<string, unknown> | undefined,
	): Promise<Record<string, unknown>> {
		const name = params?.name;
		if (typeof name !== 'string') {
			throw Object.assign(new Error('tools/call requires a string `name`'), {
				code: INVALID_PARAMS,
			});
		}

		const tool = byName.get(name);
		if (!tool) {
			throw Object.assign(new Error(`Unknown tool: ${name}`), {
				code: INVALID_PARAMS,
			});
		}

		const args = (params?.arguments ?? {}) as Record<string, unknown>;

		// A tool that throws is a tool-level failure, not a protocol failure: the
		// client gets a result carrying isError so a model can read the reason,
		// rather than a JSON-RPC error that reads as "the server is broken".
		try {
			const data = await tool.handler(args);
			return {
				content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
				structuredContent: data,
				isError: false,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: 'text', text: message }],
				isError: true,
			};
		}
	}

	// One request in, at most one response out. Kept free of I/O so the whole
	// protocol surface is testable without spawning a process — `serve` owns
	// the stream and this owns the semantics.
	return async function respond(
		request: JsonRpcRequest,
	): Promise<JsonRpcResponse | null> {
		const { method, params } = request;
		const id = request.id ?? null;
		// Notifications carry no id and take no reply.
		const isNotification = request.id === undefined || request.id === null;

		try {
			if (method === 'initialize') {
				const asked = params?.protocolVersion;
				return {
					jsonrpc: '2.0' as const,
					id,
					result: {
						protocolVersion:
							typeof asked === 'string' ? asked : SUPPORTED_PROTOCOL,
						capabilities: { tools: { listChanged: false } },
						serverInfo: info,
					},
				};
			}

			if (method === 'notifications/initialized') return null;
			if (isNotification) return null;

			if (method === 'ping') {
				return { jsonrpc: '2.0' as const, id, result: {} };
			}

			if (method === 'tools/list') {
				return { jsonrpc: '2.0' as const, id, result: { tools: listing } };
			}

			if (method === 'tools/call') {
				return {
					jsonrpc: '2.0' as const,
					id,
					result: await callTool(params),
				};
			}

			return {
				jsonrpc: '2.0' as const,
				id,
				error: { code: METHOD_NOT_FOUND, message: `Unknown method: ${method}` },
			};
		} catch (error) {
			const code =
				typeof (error as { code?: unknown })?.code === 'number'
					? (error as { code: number }).code
					: INTERNAL_ERROR;
			const message = error instanceof Error ? error.message : String(error);
			return { jsonrpc: '2.0' as const, id, error: { code, message } };
		}
	};
}

/**
 * Serve on stdin/stdout until stdin closes.
 *
 * Reads newline-delimited JSON. Anything unparseable gets a parse error rather
 * than crashing the process — a malformed line from one client should not take
 * the server down.
 */
export function serve(
	info: ServerInfo,
	tools: readonly ToolDefinition[],
	input: NodeJS.ReadableStream = process.stdin,
	output: NodeJS.WritableStream = process.stdout,
): void {
	const respond = createResponder(info, tools);
	let buffer = '';

	const write = (message: unknown): void => {
		output.write(`${JSON.stringify(message)}\n`);
	};

	input.setEncoding?.('utf8');
	input.on('data', (chunk: string) => {
		buffer += chunk;

		// Process every complete line; keep the partial tail for the next chunk.
		let newline = buffer.indexOf('\n');
		while (newline !== -1) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf('\n');
			if (!line) continue;

			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				write({
					jsonrpc: '2.0',
					id: null,
					error: { code: PARSE_ERROR, message: 'Invalid JSON' },
				});
				continue;
			}

			if (!isRequest(parsed)) {
				write({
					jsonrpc: '2.0',
					id: null,
					error: { code: PARSE_ERROR, message: 'Not a JSON-RPC 2.0 request' },
				});
				continue;
			}

			void respond(parsed).then((response) => {
				if (response) write(response);
			});
		}
	});
}
