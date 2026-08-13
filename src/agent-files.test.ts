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

/** The interpreter, or nothing. Windows images name it `python`. */
function interpreter(): string | undefined {
	for (const candidate of ['python3', 'python']) {
		const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
		if (probe.status === 0) return candidate;
	}
	return undefined;
}

describe('agent instruction files', () => {
	it('are one document, and every link resolves', () => {
		const python = interpreter();
		// Not a skip. A machine with no Python cannot answer this question, and
		// reporting a pass over a check that never ran is the defect this whole
		// family is built against.
		expect(
			python,
			'no python3/python on PATH — cannot run scripts/check-agent-files.py',
		).toBeDefined();

		const result = spawnSync(
			python ?? 'python3',
			['scripts/check-agent-files.py'],
			{
				encoding: 'utf8',
			},
		);
		expect(`${result.stdout}${result.stderr}`.trim()).toContain('agree');
		expect(result.status).toBe(0);
	});
});
