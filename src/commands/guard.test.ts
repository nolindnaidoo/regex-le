import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { guarded } from './guard';

/**
 * The guard itself, and that every command goes through it.
 *
 * No command body had an outer handler: a rejection from the editor's API
 * escaped as an unhandled rejection the editor reported in its own words,
 * raw message and home directory included. The first test holds what the
 * guard does with one; the last reads the source so a command registered
 * without it is a failing test, not a finding for the next pass.
 */

function stub() {
	return { showError: vi.fn((_message: string): void => {}) };
}

describe('guarded', () => {
	it('reports a rejection once, redacted, and resolves', async () => {
		const notifier = stub();
		const run = guarded(notifier, async () => {
			throw new Error('disk full at /Users/someone/out');
		});
		await expect(run()).resolves.toBeUndefined();
		expect(notifier.showError).toHaveBeenCalledTimes(1);
		expect(notifier.showError).toHaveBeenCalledWith(
			'Regex-LE could not finish: disk full at /Users/***/out',
		);
	});

	it('reports a thrown value that is not an Error without printing undefined', async () => {
		const notifier = stub();
		await guarded(notifier, async () => {
			throw 'no window';
		})();
		expect(notifier.showError).toHaveBeenCalledWith(
			'Regex-LE could not finish: no window',
		);
	});

	it('says nothing when the body resolves, and passes its arguments through', async () => {
		const notifier = stub();
		const seen: unknown[] = [];
		await guarded(notifier, async (...args: unknown[]) => {
			seen.push(...args);
		})('a', 2);
		expect(seen).toEqual(['a', 2]);
		expect(notifier.showError).not.toHaveBeenCalled();
	});
});

describe('every command is registered through the guard', () => {
	const root = join(__dirname, '..');

	function sourceFiles(dir: string): string[] {
		return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				return entry.name === '__mocks__' ? [] : sourceFiles(path);
			}
			return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
		});
	}

	it('hands registerCommand a guarded handler at every site', () => {
		const REGISTRATION =
			// The lookahead sits on the comma, so backtracking cannot shorten the
			// whitespace to slip past it.
			/vscode\.commands\.registerCommand\(\s*(?:'[^']*'|"[^"]*"|[A-Za-z_.]+)\s*,(?!\s*guarded\()/g;
		const unguarded = sourceFiles(root).flatMap((file) => {
			const text = readFileSync(file, 'utf8');
			return [...text.matchAll(REGISTRATION)].map(
				(match) =>
					`${file.slice(root.length + 1)}:${text.slice(0, match.index).split('\n').length}`,
			);
		});
		expect(unguarded).toEqual([]);
	});
});
