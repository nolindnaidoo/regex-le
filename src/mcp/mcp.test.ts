import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { analysisFailed, capped, isOk, readMaxResults } from './envelope';
import { TOOLS } from './tools';
import { createResponder, serve } from './transport';

/**
 * The MCP layer: the normalisation boundary, the tool table and the protocol.
 *
 * The engine is covered by its own tests. What is new here is that the safety
 * verdict travels with the pattern — the reason this is one tool and not two —
 * and that a pattern the analyser cannot read is still reported rather than
 * dropped.
 */

describe('envelope', () => {
	it('is ok when nothing was reported', () => {
		expect(isOk([])).toBe(true);
	});

	it('treats a failed analysis as a warning, not a failed scan', () => {
		// The scan succeeded; one pattern defeated the analyser. Failing the whole
		// result would discard every other finding.
		const diagnostic = analysisFailed('/(/', 'unterminated group');
		expect(diagnostic.severity).toBe('warning');
		expect(isOk([diagnostic])).toBe(true);
	});

	it('reports truncation honestly when it drops items', () => {
		const { items, truncated } = capped([1, 2, 3, 4, 5], 2);
		expect(items).toEqual([1, 2]);
		expect(truncated).toBe(true);
	});

	it('does not claim truncation when everything fits', () => {
		const { items, truncated } = capped([1, 2], 5);
		expect(items).toHaveLength(2);
		expect(truncated).toBe(false);
	});

	it('rejects a maxResults a tool cannot honour', () => {
		expect(() => readMaxResults({ maxResults: 0 })).toThrow(/positive integer/);
		expect(() => readMaxResults({ maxResults: 1.5 })).toThrow();
		expect(() => readMaxResults({ maxResults: 'ten' })).toThrow();
	});

	it('clamps an oversized request rather than refusing it', () => {
		expect(readMaxResults({ maxResults: 999999 })).toBe(5000);
	});
});

describe('tool table', () => {
	it('pins the tool names', () => {
		expect(TOOLS.map((t) => t.name)).toEqual(['extract_patterns']);
	});

	it('gives every tool a description and a closed schema', () => {
		for (const tool of TOOLS) {
			expect(tool.description.length).toBeGreaterThan(20);
			expect(tool.inputSchema.type).toBe('object');
			expect(tool.inputSchema.additionalProperties).toBe(false);
			expect(typeof tool.handler).toBe('function');
		}
	});

	it('caps results by default rather than leaving it unbounded', () => {
		const schema = TOOLS[0]?.inputSchema as {
			properties: { maxResults: { default: number } };
		};
		expect(schema.properties.maxResults.default).toBe(500);
	});
});

describe('extract_patterns', () => {
	const call = async (args: Record<string, unknown>) => {
		const tool = TOOLS[0];
		if (!tool) throw new Error('no tool');
		return (await tool.handler(args)) as {
			ok: boolean;
			data: {
				patterns: {
					pattern: string;
					flags: string;
					line: number;
					redos?: { detected: boolean; severity: string; reason: string };
				}[];
			};
			meta: { count: number; truncated: boolean };
		};
	};

	it('extracts a literal with its flags and position', async () => {
		const result = await call({ content: 'const re = /^ab+c$/gi;' });
		expect(result.data.patterns[0]?.pattern).toBe('^ab+c$');
		expect(result.data.patterns[0]?.flags).toBe('gi');
		expect(result.data.patterns[0]?.line).toBe(1);
		expect(result.ok).toBe(true);
	});

	it('carries a ReDoS verdict with every pattern', async () => {
		// The reason this is one tool: "are any of these dangerous?" should not be
		// a second round trip with the patterns threaded back in.
		const result = await call({ content: 'const bad = /^(a+)+$/;' });
		expect(result.data.patterns[0]?.redos?.detected).toBe(true);
		expect(result.data.patterns[0]?.redos?.severity).toBeTruthy();
		expect(result.data.patterns[0]?.redos?.reason).toBeTruthy();
	});

	it('does not flag a safe pattern as vulnerable', async () => {
		const result = await call({ content: 'const ok = /\\d{3}-\\d{4}/;' });
		expect(result.data.patterns[0]?.redos?.detected).toBe(false);
	});

	it('reports a pattern once, at first occurrence', async () => {
		// Documented engine behaviour: the output is a pattern list, not an
		// occurrence list, and the tool description says so.
		const result = await call({
			content: 'const a = /x+/g;\nconst b = /x+/g;',
		});
		expect(result.meta.count).toBe(1);
	});

	it('truncates at maxResults and says so', async () => {
		const content = Array.from(
			{ length: 10 },
			(_, i) => `const r${i} = /pat${i}/;`,
		).join('\n');
		const result = await call({ content, maxResults: 3 });
		expect(result.meta.count).toBe(3);
		expect(result.meta.truncated).toBe(true);
	});

	it('returns an empty list for text with no regexes', async () => {
		const result = await call({ content: 'const x = 1;' });
		expect(result.data.patterns).toEqual([]);
		expect(result.ok).toBe(true);
	});

	it('requires content', async () => {
		await expect(call({})).rejects.toThrow(/content is required/);
	});
});

describe('protocol', () => {
	const respond = createResponder(
		{ name: 'regex-le', version: '1.0.0' },
		TOOLS,
	);

	it('echoes the protocol version the client asked for', async () => {
		const reply = await respond({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: { protocolVersion: '2024-11-05' },
		});
		expect(reply?.result?.protocolVersion).toBe('2024-11-05');
		expect(reply?.result?.serverInfo).toEqual({
			name: 'regex-le',
			version: '1.0.0',
		});
	});

	it('does not reply to a notification', async () => {
		// A reply to a notification is the classic way to wedge a client.
		expect(
			await respond({ jsonrpc: '2.0', method: 'notifications/initialized' }),
		).toBeNull();
	});

	it('reports an unknown method as a JSON-RPC error', async () => {
		const reply = await respond({ jsonrpc: '2.0', id: 2, method: 'nope' });
		expect(reply?.error?.code).toBe(-32601);
	});

	it('reports an unknown tool without killing the connection', async () => {
		const reply = await respond({
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: { name: 'no_such_tool', arguments: {} },
		});
		expect(reply?.error?.code).toBe(-32602);
	});

	it('returns a tool failure as a result, not a protocol error', async () => {
		// A model can read an isError result and correct itself; a JSON-RPC error
		// reads as "the server is broken".
		const reply = await respond({
			jsonrpc: '2.0',
			id: 4,
			method: 'tools/call',
			params: { name: 'extract_patterns', arguments: {} },
		});
		expect(reply?.error).toBeUndefined();
		expect(reply?.result?.isError).toBe(true);
	});
});

describe('serve: the stdio loop', () => {
	/** A fake stdin/stdout pair so the loop can be driven without a process. */
	function harness() {
		const input = new EventEmitter() as EventEmitter & {
			setEncoding?: (e: string) => void;
		};
		const written: string[] = [];
		const output = {
			write: (chunk: string) => {
				written.push(chunk);
				return true;
			},
		};
		serve(
			{ name: 'regex-le', version: '1.0.0' },
			TOOLS,
			input as never,
			output as never,
		);
		const replies = () =>
			written
				.join('')
				.split('\n')
				.filter(Boolean)
				.map((l) => JSON.parse(l));
		return { input, replies };
	}

	const settle = () => new Promise((r) => setTimeout(r, 20));

	it('answers a request delivered as one line', async () => {
		const { input, replies } = harness();
		input.emit('data', '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
		await settle();
		expect(replies()[0]?.result?.tools).toHaveLength(1);
	});

	it('reassembles a request split across chunks', async () => {
		// stdin delivers whatever the OS gives it; a request arriving in two
		// pieces must not be dropped or double-parsed.
		const { input, replies } = harness();
		input.emit('data', '{"jsonrpc":"2.0","id":2,"me');
		input.emit('data', 'thod":"ping"}\n');
		await settle();
		expect(replies()[0]?.id).toBe(2);
	});

	it('handles several requests in one chunk', async () => {
		const { input, replies } = harness();
		input.emit(
			'data',
			'{"jsonrpc":"2.0","id":3,"method":"ping"}\n{"jsonrpc":"2.0","id":4,"method":"ping"}\n',
		);
		await settle();
		expect(replies().map((r) => r.id)).toEqual([3, 4]);
	});

	it('reports malformed JSON without dying', async () => {
		// One bad line from a client must not take the server down for everyone.
		const { input, replies } = harness();
		input.emit('data', 'not json at all\n');
		input.emit('data', '{"jsonrpc":"2.0","id":5,"method":"ping"}\n');
		await settle();
		expect(replies()[0]?.error?.code).toBe(-32700);
		expect(replies()[1]?.id).toBe(5);
	});

	it('rejects a payload that is not a JSON-RPC request', async () => {
		const { input, replies } = harness();
		input.emit('data', '{"hello":"world"}\n');
		await settle();
		expect(replies()[0]?.error?.code).toBe(-32700);
	});

	it('ignores blank lines', async () => {
		const { input, replies } = harness();
		input.emit('data', '\n\n{"jsonrpc":"2.0","id":6,"method":"ping"}\n');
		await settle();
		expect(replies()).toHaveLength(1);
	});

	it('writes nothing for a notification', async () => {
		const { input, replies } = harness();
		input.emit(
			'data',
			'{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
		);
		await settle();
		expect(replies()).toHaveLength(0);
	});
});
