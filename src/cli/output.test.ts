import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { crateOutput, exitWhenDrained } from './output';

/** A pipe whose reader takes `delay` milliseconds over every chunk. */
function slowPipe(delay: number, taken: string[], name = ''): Writable {
	return new Writable({
		write(chunk, _encoding, done) {
			setTimeout(() => {
				if (chunk.length > 0) taken.push(name || String(chunk));
				done();
			}, delay);
		},
	});
}

/** A pipe whose reader has gone: every write fails as EPIPE does. */
function closedPipe(): Writable {
	return new Writable({
		write(_chunk, _encoding, done) {
			done(
				Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -32 }),
			);
		},
	});
}

// Rust's wording for the error each platform reports on a closed pipe.
const BROKEN_PIPE =
	process.platform === 'win32'
		? 'The pipe is being closed. (os error 232)'
		: 'Broken pipe (os error 32)';

describe('exitWhenDrained', () => {
	it('exits only after the slower stream has been read', async () => {
		const taken: string[] = [];
		const stdout = slowPipe(1, taken, 'stdout');
		const stderr = slowPipe(25, taken, 'stderr');
		stdout.write('report\n');
		stderr.write('summary\n');

		const atExit = await new Promise<string[]>((resolve) =>
			exitWhenDrained([stdout, stderr], () => resolve([...taken])),
		);

		expect(atExit).toEqual(['stdout', 'stderr']);
	});
});

describe('crateOutput', () => {
	const exited = (
		output: ReturnType<typeof crateOutput>,
		code: number,
		refusal: string | null,
	) =>
		new Promise<void>((resolve) => {
			output.exit(code, refusal);
			setTimeout(resolve, 300);
		});

	it('writes stderr after the stdout written before it', async () => {
		const order: string[] = [];
		const output = crateOutput(
			'tool',
			slowPipe(20, order),
			slowPipe(1, order),
			() => {},
		);
		output.stdout('report\n');
		output.stderr('summary\n');
		await exited(output, 0, 'could not write the report');
		expect(order).toEqual(['report\n', 'summary\n']);
	});

	it('exits only after the stderr queued behind stdout has been read', async () => {
		const taken: string[] = [];
		const atExit: string[][] = [];
		const output = crateOutput(
			'tool',
			slowPipe(5, taken, 'stdout'),
			slowPipe(25, taken, 'stderr'),
			() => atExit.push([...taken]),
		);
		output.stdout('report\n');
		output.stderr('summary\n');
		await exited(output, 0, 'could not write the report');
		expect(atExit).toEqual([['stdout', 'stderr']]);
	});

	it('refuses in the crate words when stdout has gone, and nothing else', async () => {
		const stderr: string[] = [];
		const codes: number[] = [];
		const output = crateOutput(
			'tool',
			closedPipe(),
			slowPipe(1, stderr),
			(code) => codes.push(code),
		);
		output.stdout('report\n');
		output.stderr('summary\n');
		await exited(output, 0, 'could not write the report');
		expect(stderr).toEqual([
			`tool: could not write the report: ${BROKEN_PIPE}\n`,
		]);
		expect(codes).toEqual([2]);
	});

	it('exits 2 and says nothing when the caller has no refusal', async () => {
		const stderr: string[] = [];
		const codes: number[] = [];
		const output = crateOutput(
			'tool',
			closedPipe(),
			slowPipe(1, stderr),
			(code) => codes.push(code),
		);
		output.stdout('{"jsonrpc":"2.0"}\n');
		await exited(output, 0, null);
		expect(stderr).toEqual([]);
		expect(codes).toEqual([2]);
	});

	it('answers false when the pipe is full, so a caller can wait for drain', async () => {
		// The MCP server writes one reply per request and must stop reading
		// while the client has not taken the last one. The stream's own `write`
		// says whether it has; this handed that answer back as nothing, so a
		// caller could only guess.
		const taken: string[] = [];
		const pipe = new Writable({
			highWaterMark: 16,
			write(chunk, _encoding, done) {
				setTimeout(() => {
					taken.push(String(chunk));
					done();
				}, 5);
			},
		});
		const output = crateOutput('tool', pipe, slowPipe(1, []), () => {});
		expect(output.stdout('a\n')).toBe(true);
		expect(output.stdout('x'.repeat(64))).toBe(false);
		await new Promise((resolve) => pipe.once('drain', resolve));
		expect(output.stdout('b\n')).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(taken).toEqual(['a\n', 'x'.repeat(64), 'b\n']);
	});

	it('answers false once stdout has failed, and writes nothing more', async () => {
		const codes: number[] = [];
		const output = crateOutput('tool', closedPipe(), slowPipe(1, []), (code) =>
			codes.push(code),
		);
		output.stdout('report\n');
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(output.stdout('more\n')).toBe(false);
		await exited(output, 0, 'could not write the report');
		expect(codes).toEqual([2]);
	});

	it('finishes as before when only stderr has gone', async () => {
		const stdout: string[] = [];
		const codes: number[] = [];
		const output = crateOutput(
			'tool',
			slowPipe(1, stdout),
			closedPipe(),
			(code) => codes.push(code),
		);
		output.stdout('report\n');
		output.stderr('summary\n');
		await exited(output, 1, 'could not write the report');
		expect(stdout).toEqual(['report\n']);
		expect(codes).toEqual([1]);
	});
});
