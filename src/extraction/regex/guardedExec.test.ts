import { describe, expect, it } from 'vitest';
import { execWithTimeout } from './guardedExec';

describe('execWithTimeout', () => {
	it('returns matches for a well-behaved pattern', async () => {
		const result = await execWithTimeout(
			'\\d+',
			'g',
			'a1 b22 c333',
			1000,
			2000,
		);
		expect(result.kind).toBe('ok');
		if (result.kind !== 'ok') return;
		expect(result.matches.map((m) => m.match)).toEqual(['1', '22', '333']);
	});

	it('reports capture groups with engine-provided ranges', async () => {
		const result = await execWithTimeout('(\\w)(\\d)', 'g', 'a1', 1000, 2000);
		expect(result.kind).toBe('ok');
		if (result.kind !== 'ok') return;
		expect(result.matches[0]?.groupValues).toEqual(['a', '1']);
		expect(result.matches[0]?.groupRanges).toEqual([
			[0, 1],
			[1, 2],
		]);
	});

	// The reason this module exists: a catastrophic pattern blocks inside a
	// single exec(), so it can only be stopped by killing the thread running it.
	it('times out on a catastrophically backtracking pattern', async () => {
		const started = Date.now();
		const result = await execWithTimeout(
			'(a+)+$',
			'',
			`${'a'.repeat(40)}b`,
			1000,
			1000,
		);
		const elapsed = Date.now() - started;
		expect(result.kind).toBe('timeout');
		expect(elapsed).toBeLessThan(5000);
	}, 15000);

	it('reports an invalid pattern as an error, not a crash', async () => {
		const result = await execWithTimeout('[unclosed', '', 'text', 1000, 2000);
		expect(result.kind).toBe('error');
	});
});
