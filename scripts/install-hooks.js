#!/usr/bin/env node
/**
 * Point git at the repo's tracked hooks.
 *
 * Run from `prepare`, so a fresh clone is wired by `bun install`. Written in
 * Node rather than a shell one-liner because `prepare` also runs on CI's
 * Windows runner, where Bun's shell cannot parse POSIX redirection.
 *
 * A checkout without a .git directory — a tarball, or install as a dependency
 * — is not an error; there is simply nothing to configure.
 */
const { execFileSync } = require('node:child_process');

try {
	execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' });
} catch {
	process.exit(0);
}

try {
	execFileSync('git', ['config', 'core.hooksPath', '.githooks'], {
		stdio: 'ignore',
	});
} catch {
	// A read-only or unusual git config is not worth failing an install over;
	// CI enforces the same rule regardless.
}
