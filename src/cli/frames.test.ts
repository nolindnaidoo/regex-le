import { describe, expect, it, vi } from 'vitest';
import { MAX_FRAME_BYTES } from '../mcp/transport';
import { frames } from './frames';

async function read(...chunks: (string | number[])[]): Promise<unknown[]> {
	const input = (async function* () {
		for (const chunk of chunks) {
			yield typeof chunk === 'string'
				? Buffer.from(chunk)
				: Uint8Array.from(chunk);
		}
	})();
	const out: unknown[] = [];
	for await (const frame of frames(input)) out.push(frame);
	return out;
}

const ping = (id: unknown) => ({
	request: { jsonrpc: '2.0', id, method: 'ping' },
});
const invalid = { refusal: 'Invalid JSON' };
const notARequest = { refusal: 'Not a JSON-RPC 2.0 request' };

describe('frames', () => {
	it('answers a line that is not UTF-8 with a parse error and reads on', async () => {
		expect(
			await read(
				[0xff, 0xfe, 10],
				'{"jsonrpc":"2.0","id":1,"method":"ping"}\n',
			),
		).toEqual([invalid, ping(1)]);
	});

	it('reads an invalid byte inside a string as a replacement character', async () => {
		const [frame] = await read([
			...Buffer.from('{"jsonrpc":"2.0","id":2,"method":"ping","x":"caf'),
			0xe9,
			...Buffer.from('"}\n'),
		]);
		expect(frame).toEqual({
			request: { jsonrpc: '2.0', id: 2, method: 'ping', x: 'caf�' },
		});
	});

	it('refuses a line that is not JSON, a BOM-led one included', async () => {
		expect(
			await read('nope\n﻿{"jsonrpc":"2.0","id":1,"method":"ping"}\n'),
		).toEqual([invalid, invalid]);
	});

	it('refuses JSON that is not a JSON-RPC 2.0 request', async () => {
		expect(
			await read(
				'{"id":1}\n{"id":1,"method":"ping"}\n{"jsonrpc":"1.0","id":1,"method":"ping"}\n{"jsonrpc":"2.0","id":1,"method":7}\n[1,2,3]\n5\n',
			),
		).toEqual([
			notARequest,
			notARequest,
			notARequest,
			notARequest,
			notARequest,
			notARequest,
		]);
	});

	it('reassembles a frame split across chunks, and drops one trailing CR', async () => {
		expect(
			await read('{"jsonrpc":"2.0","id"', ':1,"method":"ping"}\r\n'),
		).toEqual([ping(1)]);
	});

	it('drops a last line with no newline: a partial frame at close was never a request', async () => {
		expect(
			await read(
				'{"jsonrpc":"2.0","id":1,"method":"ping"}\n{"jsonrpc":"2.0","id":2,"method":"ping"}',
			),
		).toEqual([ping(1)]);
	});

	it('refuses a frame over the limit and reads the next line, whenever its newline arrives', async () => {
		// Input with no newline was held whole. One byte over with the newline
		// in the same chunk; far over with the newline many chunks later.
		const limit = {
			refusal: `Message exceeds the ${MAX_FRAME_BYTES} byte frame limit`,
		};
		expect(
			await read(
				`${'x'.repeat(MAX_FRAME_BYTES + 1)}\n`,
				'{"jsonrpc":"2.0","id":1,"method":"ping"}\n',
			),
		).toEqual([limit, ping(1)]);
		expect(
			await read(
				'x'.repeat(MAX_FRAME_BYTES + 1),
				'y'.repeat(1000),
				'z\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n',
			),
		).toEqual([limit, ping(1)]);
	});

	it('joins the chunks of a line once, at its newline', async () => {
		// Joining on every chunk copied the whole line so far each time: a
		// 16 MiB line cost about a gigabyte of transient copies on its way to
		// the limit, with nothing held past it.
		const concat = vi.spyOn(Buffer, 'concat');
		try {
			const body = Array.from({ length: 64 }, () => 'x'.repeat(1024));
			const read_ = await read(
				'{"jsonrpc":"2.0","id":1,"method":"ping","params":{"pad":"',
				...body,
				'"}}\n',
				'{"jsonrpc":"2.0","id":2,"method":"ping"}\n',
			);
			expect(
				read_.map((frame) => (frame as { request: { id: number } }).request.id),
			).toEqual([1, 2]);
			expect(concat).toHaveBeenCalledTimes(1);
		} finally {
			concat.mockRestore();
		}
	});

	it('reads a frame exactly at the limit', async () => {
		const head = '{"jsonrpc":"2.0","id":1,"method":"ping","params":{"pad":"';
		const line = `${head}${'x'.repeat(MAX_FRAME_BYTES - head.length - 3)}"}}`;
		expect(Buffer.byteLength(line)).toBe(MAX_FRAME_BYTES);
		const [frame] = await read(`${line}\n`);
		expect((frame as { request: { id: number } }).request.id).toBe(1);
	});

	it("skips a line Rust's trim leaves empty, and keeps a null id for the server to read as a notification", async () => {
		expect(
			await read('\u0085 \t\n{"jsonrpc":"2.0","id":null,"method":"ping"}\n'),
		).toEqual([ping(null)]);
	});
});
