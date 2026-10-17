/**
 * The crate MCP server's framing, shared by every npm port: newline-delimited
 * JSON read the way `BufRead::lines` reads it, one trailing `\r` dropped and a
 * last line with no newline still a frame.
 *
 * A frame that is not UTF-8, is blank by Rust's `str::trim`, or is not JSON
 * carries no id to answer against, so it is dropped and the server reads on.
 * Ending the session instead cost every request that followed. A byte order
 * mark is not whitespace to either parser, so a frame led by one is not JSON.
 */
export async function* requests(
	input: AsyncIterable<Uint8Array>,
): AsyncGenerator<unknown> {
	for await (const line of lines(input)) {
		if (line === null || isRustBlank(line)) continue;
		let request: unknown;
		try {
			request = JSON.parse(line);
		} catch {
			continue;
		}
		yield request;
	}
}

/** Lines split on `\n` with one trailing `\r` dropped, or null for invalid UTF-8. */
async function* lines(
	input: AsyncIterable<Uint8Array>,
): AsyncGenerator<string | null> {
	const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
	let pending = Buffer.alloc(0);
	for await (const chunk of input) {
		pending = Buffer.concat([pending, chunk]);
		let newline = pending.indexOf(10);
		while (newline !== -1) {
			yield decodeLine(decoder, pending.subarray(0, newline));
			pending = pending.subarray(newline + 1);
			newline = pending.indexOf(10);
		}
	}
	if (pending.length > 0) yield decodeLine(decoder, pending);
}

function decodeLine(decoder: TextDecoder, bytes: Uint8Array): string | null {
	try {
		const line = decoder.decode(bytes);
		return line.endsWith('\r') ? line.slice(0, -1) : line;
	} catch {
		return null;
	}
}

/** Rust's `char::is_whitespace`, which `str::trim` strips. */
function isRustBlank(line: string): boolean {
	return /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/.test(
		line,
	);
}
