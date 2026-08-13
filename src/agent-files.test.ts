import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * Every major coding assistant looks for its own instruction file, so this
 * repository carries one for each. AGENTS.md says they stay thin pointers and
 * must never grow a second copy of the standard — and the way that rule breaks
 * is someone editing one of the six and not the other five.
 *
 * The rule itself lives in `scripts/check-agent-files.py`, which the crate-only
 * repos in this family run from their `policy` CI job. It was written twice
 * once — a test here and a Python heredoc there — which is the "define it once"
 * rule broken inside the gate that enforces the family's rules, and the two had
 * already diverged. This file is the thin half: it exists so the check runs in
 * `bun run test`, locally and on every push, rather than only in CI.
 *
 * Python because the crate repos have no JavaScript in them, deliberately.
 */

/**
 * The check, run under whichever interpreter this machine names. Windows
 * images call it `python`.
 *
 * One spawn per candidate rather than a `--version` probe followed by the real
 * run: on a Windows runner each spawn costs seconds, and probing first put the
 * whole test over vitest's 5s default — 6.6s on one repo, just under it on the
 * others, which is a fleet-wide flake rather than one repo's bug.
 */
function run(): { ran: boolean; output: string; status: number | null } {
	for (const candidate of ['python3', 'python']) {
		const result = spawnSync(candidate, ['scripts/check-agent-files.py'], {
			encoding: 'utf8',
		});
		// ENOENT means this name is not the interpreter; anything else is an
		// answer, including a failing one.
		if (result.error === undefined) {
			return {
				ran: true,
				output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
				status: result.status,
			};
		}
	}
	return { ran: false, output: '', status: null };
}

describe('agent instruction files', () => {
	// Generous because the cost is process spawning on a hosted Windows runner,
	// not the work: the check itself reads six small files.
	it('are one document, and every link resolves', { timeout: 60_000 }, () => {
		const result = run();
		// Not a skip. A machine with no Python cannot answer this question, and
		// reporting a pass over a check that never ran is the defect this whole
		// family is built against.
		expect(
			result.ran,
			'no python3/python on PATH — cannot run scripts/check-agent-files.py',
		).toBe(true);
		expect(result.output).toContain('agree');
		expect(result.status).toBe(0);
	});
});
