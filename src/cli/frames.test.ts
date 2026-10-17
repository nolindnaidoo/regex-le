import { describe, expect, it } from 'vitest';
import { requests } from './frames';

async function read(...chunks: (string | number[])[]): Promise<unknown[]> {
	const input = (async function* () {
		for (const chunk of chunks) {
			yield typeof chunk === 'string'
				? Buffer.from(chunk)
				: Uint8Array.from(chunk);
		}
	})();
	const out: unknown[] = [];
	for await (const request of requests(input)) out.push(request);
	return out;
}

describe('requests', () => {
	it('drops a frame that is not UTF-8 and reads on', async () => {
		expect(await read([0xff, 0xfe, 10], '{"id":1}\n')).toEqual([{ id: 1 }]);
	});

	it('drops a frame that is not JSON, a BOM-led one included', async () => {
		expect(await read('nope\n\uFEFF{"id":1}\n{"id":2}\n')).toEqual([{ id: 2 }]);
	});

	it('reads a last line with no newline, and a frame split across chunks', async () => {
		expect(await read('{"id"', ':1}\r\n{"id":2}')).toEqual([
			{ id: 1 },
			{ id: 2 },
		]);
	});

	it("skips a line Rust's trim leaves empty", async () => {
		expect(await read('\u0085 \t\n{"id":1}\n')).toEqual([{ id: 1 }]);
	});
});
