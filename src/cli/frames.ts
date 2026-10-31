/**
 * The crate MCP server's framing, which `regex-le mcp` reproduces and
 * `check:cli-pipes` holds: newline-delimited JSON, a line read with
 * replacement characters where it is not UTF-8, as `from_utf8_lossy` reads
 * it, and trimmed as Rust's `str::trim` trims. A blank line is skipped. A
 * line that is not JSON, or not a JSON-RPC 2.0 request, is a parse error the
 * server answers, in the words the extension's server uses, so a client that
 * sent one learns what happened; dropping it cost the client every request
 * it then waited on. A partial frame at close was never a request. A byte
 * order mark is not whitespace to either parser, so a frame led by one is
 * not JSON.
 */
import { MAX_FRAME_BYTES } from '../mcp/transport';

export interface Request {
	readonly jsonrpc: '2.0';
	readonly method: string;
	readonly id?: unknown;
	readonly params?: unknown;
}

export type Frame =
	| { readonly request: Request }
	| { readonly refusal: string };

/** A frame past the limit is refused in the words the extension's server uses, and never held. */
const FRAME_REFUSAL = `Message exceeds the ${MAX_FRAME_BYTES} byte frame limit`;

export async function* frames(
	input: AsyncIterable<Uint8Array>,
): AsyncGenerator<Frame> {
	for await (const line of lines(input)) {
		if (line === null) {
			yield { refusal: FRAME_REFUSAL };
			continue;
		}
		const text = rustTrim(line);
		if (text === '') continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			yield { refusal: 'Invalid JSON' };
			continue;
		}
		if (!isRequest(parsed)) {
			yield { refusal: 'Not a JSON-RPC 2.0 request' };
			continue;
		}
		yield { request: parsed };
	}
}

/**
 * Complete lines, split on `\n`, or null for a line over the limit; whatever
 * follows the last newline at close is dropped. Past the limit the rest of
 * the line is dropped as it arrives, so an oversized frame is never held, and
 * a line whose newline arrives in the chunk that takes it over is refused too.
 */
async function* lines(
	input: AsyncIterable<Uint8Array>,
): AsyncGenerator<string | null> {
	const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
	// The chunks of the line in progress, joined once at its newline. Joining
	// on every chunk copied the whole line so far each time, and a 16 MiB
	// line cost about a gigabyte of transient copies on its way to the limit.
	let pending: Uint8Array[] = [];
	let pendingBytes = 0;
	let discarding = false;
	for await (const chunk of input) {
		let bytes: Uint8Array = chunk;
		if (discarding) {
			const end = bytes.indexOf(10);
			if (end === -1) continue;
			discarding = false;
			bytes = bytes.subarray(end + 1);
		}
		let newline = bytes.indexOf(10);
		while (newline !== -1) {
			const head = bytes.subarray(0, newline);
			const line =
				pending.length === 0 ? head : Buffer.concat([...pending, head]);
			pending = [];
			pendingBytes = 0;
			bytes = bytes.subarray(newline + 1);
			newline = bytes.indexOf(10);
			yield line.length > MAX_FRAME_BYTES ? null : decoder.decode(line);
		}
		if (bytes.length > 0) {
			pending.push(bytes);
			pendingBytes += bytes.length;
		}
		if (pendingBytes > MAX_FRAME_BYTES) {
			pending = [];
			pendingBytes = 0;
			discarding = true;
			yield null;
		}
	}
}

function isRequest(value: unknown): value is Request {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return candidate.jsonrpc === '2.0' && typeof candidate.method === 'string';
}

/**
 * Rust's `str::trim`: `char::is_whitespace` at both ends. JavaScript's `trim`
 * also strips a byte order mark, which the crate reads as not JSON.
 */
function rustTrim(line: string): string {
	const space =
		'[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
	return line.replace(new RegExp(`^${space}+|${space}+$`, 'g'), '');
}
