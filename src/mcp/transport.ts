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
 * Answered whatever the client asked for, as the crate's server answers it;
 * a client then accepts the revision or disconnects. Echoing the client's
 * own version, which this did, had the two servers answer one handshake
 * differently.
 */
const SUPPORTED_PROTOCOL = '2025-06-18';

/**
 * The most one frame may hold before the server gives up on it.
 *
 * Input is held until a newline arrives, and without a ceiling a client that
 * streamed bytes with no newline grew the process without bound: 64 MiB of
 * such input held a server in this family near a gigabyte resident, and no
 * error was ever written. Counted in UTF-16 code units, which is never more
 * than the bytes. Sixteen MiB is far past any message a tool here can use;
 * `maxResults` caps the answer at a few thousand rows.
 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

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

		// Absent or null arguments are an empty object, which the tool then
		// refuses for what it lacks, in the same words the crate's server uses.
		const args = (params?.arguments ?? {}) as Record<string, unknown>;

		// An argument that does not fit the tool's schema is a protocol error,
		// thrown with its code, which the responder answers as `-32602`. A tool
		// that fails on what it was given at run time is a result carrying
		// isError, so a model can read the reason rather than a JSON-RPC error
		// that reads as "the server is broken".
		try {
			const data = await tool.handler(args);
			return {
				content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
				structuredContent: data,
				isError: false,
			};
		} catch (error) {
			if ((error as { code?: unknown })?.code === INVALID_PARAMS) throw error;
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
		// Notifications carry no id, or a null one, and take no reply, whatever
		// the method. The crate's server answers the same way.
		if (request.id === undefined || request.id === null) return null;
		const id = request.id;

		try {
			if (method === 'initialize') {
				return {
					jsonrpc: '2.0' as const,
					id,
					result: {
						protocolVersion: SUPPORTED_PROTOCOL,
						capabilities: { tools: {} },
						serverInfo: info,
					},
				};
			}

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
	// Set once a frame has passed the limit: the rest of that line is dropped
	// as it arrives, so the oversized message is never held.
	let discarding = false;

	// A client that reads slowly fills the pipe, and every reply after that
	// sits in this process until it drains. Reading stops while the pipe is
	// full, so what is held is bounded by the requests already in flight
	// rather than by everything the client has sent.
	let waitingForDrain = false;
	const write = (message: unknown): void => {
		if (output.write(`${JSON.stringify(message)}\n`) || waitingForDrain) return;
		waitingForDrain = true;
		input.pause();
		output.once('drain', () => {
			waitingForDrain = false;
			input.resume();
		});
	};

	const frameRefusal = () => ({
		jsonrpc: '2.0' as const,
		id: null,
		error: {
			code: PARSE_ERROR,
			message: `Message exceeds the ${MAX_FRAME_BYTES} byte frame limit`,
		},
	});

	input.setEncoding?.('utf8');
	input.on('data', (received: string) => {
		let chunk = received;
		if (discarding) {
			const end = chunk.indexOf('\n');
			if (end === -1) return;
			discarding = false;
			chunk = chunk.slice(end + 1);
		}
		buffer += chunk;

		// Process every complete line; keep the partial tail for the next chunk.
		let newline = buffer.indexOf('\n');
		while (newline !== -1) {
			const line = rustTrim(buffer.slice(0, newline));
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf('\n');
			if (!line) continue;
			if (line.length > MAX_FRAME_BYTES) {
				// The newline arrived in the chunk that took the frame over the
				// limit, so the check below never saw it. The limit is on the
				// line, not on when its end happened to arrive.
				write(frameRefusal());
				continue;
			}

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

		if (buffer.length > MAX_FRAME_BYTES) {
			buffer = '';
			discarding = true;
			write(frameRefusal());
		}
	});
}

/**
 * Rust's `str::trim`, which the crate's server reads a line with. JavaScript's
 * also strips a byte order mark and keeps U+0085, so a frame led by a BOM was
 * read here and refused there.
 */
function rustTrim(line: string): string {
	const space =
		'[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
	return line.replace(new RegExp(`^${space}+|${space}+$`, 'g'), '');
}
