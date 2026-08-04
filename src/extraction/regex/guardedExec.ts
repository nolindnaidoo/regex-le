import { Worker } from 'node:worker_threads';

/**
 * Raw match data produced by the worker. Deliberately plain-JSON so it can
 * cross the thread boundary; enrichment (group names, line/column) happens on
 * the caller's side against the same text.
 */
export interface RawMatch {
	readonly match: string;
	readonly index: number;
	readonly groupValues: ReadonlyArray<string | undefined>;
	readonly groupRanges: ReadonlyArray<readonly [number, number] | undefined>;
}

export type GuardedExecResult =
	| { readonly kind: 'ok'; readonly matches: readonly RawMatch[] }
	| { readonly kind: 'timeout'; readonly ms: number }
	| { readonly kind: 'error'; readonly message: string };

/**
 * The match loop, as worker source.
 *
 * This has to live in the worker rather than on the caller's thread: a
 * catastrophically backtracking pattern blocks inside a single `regex.exec()`
 * call, so no deadline checked *between* matches can interrupt it, and a
 * match-count cap never gets the chance to fire. Terminating a worker is the
 * only way to stop an in-flight match — JavaScript offers no way to abort a
 * regex on the thread running it.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { pattern, flags, text, maxMatches } = workerData;
try {
	const execFlags = flags.includes('d') ? flags : flags + 'd';
	const regex = new RegExp(pattern, execFlags);
	const out = [];
	let m;
	while ((m = regex.exec(text)) !== null && out.length < maxMatches) {
		const indices = m.indices || [];
		const groupValues = [];
		const groupRanges = [];
		for (let i = 1; i < m.length; i++) {
			groupValues.push(m[i]);
			const r = indices[i];
			groupRanges.push(r ? [r[0], r[1]] : undefined);
		}
		out.push({ match: m[0], index: m.index, groupValues, groupRanges });
		if (!flags.includes('g')) break;
		if (m[0].length === 0) regex.lastIndex++;
	}
	parentPort.postMessage({ kind: 'ok', matches: out });
} catch (e) {
	parentPort.postMessage({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
}
`;

/**
 * Run a pattern against text on a worker thread, terminating it if it exceeds
 * the budget. Returns 'timeout' rather than throwing so callers can report a
 * suspected-catastrophic pattern instead of surfacing an opaque failure.
 */
export function execWithTimeout(
	pattern: string,
	flags: string,
	text: string,
	maxMatches: number,
	timeoutMs: number,
): Promise<GuardedExecResult> {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result: GuardedExecResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			void worker.terminate();
			resolve(result);
		};

		const worker = new Worker(WORKER_SOURCE, {
			eval: true,
			workerData: { pattern, flags, text, maxMatches },
		});

		const timer = setTimeout(() => {
			finish({ kind: 'timeout', ms: timeoutMs });
		}, timeoutMs);

		worker.on('message', (msg: GuardedExecResult) => finish(msg));
		worker.on('error', (err: Error) =>
			finish({ kind: 'error', message: err.message }),
		);
		worker.on('exit', (code) => {
			if (code !== 0) {
				finish({
					kind: 'error',
					message: `Worker stopped with exit code ${code}`,
				});
			}
		});
	});
}
