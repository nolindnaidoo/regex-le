#!/usr/bin/env node
/**
 * Conventional-commit gate.
 *
 * One implementation, two callers: the `commit-msg` hook checks the message
 * being written, and CI checks every subject in a pushed range. A hook alone is
 * skippable with `--no-verify`, and CI alone only tells you after the fact.
 *
 *   node scripts/commit-lint.js --file .git/COMMIT_EDITMSG
 *   node scripts/commit-lint.js --range <base>..<head>
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const TYPES = [
	'feat',
	'fix',
	'docs',
	'test',
	'ci',
	'build',
	'chore',
	'refactor',
	'perf',
	'revert',
];

const SUBJECT = new RegExp(
	`^(${TYPES.join('|')})(\\([a-z0-9._-]+\\))?!?: .+`,
);
const MAX_SUBJECT = 72;

// Past tense reads like a changelog entry rather than an instruction to the
// tree; the convention is imperative mood.
const PAST_TENSE = /^(\w+)(\([^)]*\))?!?: (added|fixed|updated|removed|changed|refactored|renamed|moved|deleted|created|improved|bumped)\b/i;

/** Problems with one commit subject, empty when it conforms. */
function check(subject) {
	const problems = [];
	if (!subject.trim()) return ['empty subject'];
	// A merge commit's subject is generated, not written by a person. The three
	// forms git itself writes are only half of them: on a pull_request event
	// actions/checkout builds "Merge <sha> into <sha>", which matched none of
	// them, so this gate failed every pull request on a commit nobody authored.
	if (subject.startsWith('Merge ')) return [];

	if (!SUBJECT.test(subject)) {
		problems.push(
			`must start with one of ${TYPES.join(', ')} followed by ": "`,
		);
	}
	if (subject.length > MAX_SUBJECT) {
		problems.push(`subject is ${subject.length} chars, limit is ${MAX_SUBJECT}`);
	}
	if (subject.endsWith('.')) {
		problems.push('subject must not end with a period');
	}
	if (PAST_TENSE.test(subject)) {
		problems.push('use the imperative mood ("add", not "added")');
	}
	return problems;
}

function report(subject, problems) {
	console.error(`\n  ✗ ${subject}`);
	for (const p of problems) console.error(`      ${p}`);
}

function fail() {
	console.error(
		`\n  Format: <type>(<scope>)?: <imperative summary>\n` +
			`  Types:  ${TYPES.join(', ')}\n` +
			`  Example: fix: report a rejected edit instead of announcing a count\n`,
	);
	process.exit(1);
}

const [flag, value] = process.argv.slice(2);

if (flag === '--file') {
	const message = fs.readFileSync(value, 'utf8');
	// Comment lines are stripped by git before the commit is created.
	const subject = message
		.split('\n')
		.find((l) => l.trim() && !l.startsWith('#'));
	const problems = check(subject ?? '');
	if (problems.length === 0) process.exit(0);
	report(subject ?? '', problems);
	fail();
}

if (flag === '--range') {
	let subjects = [];
	try {
		subjects = execFileSync('git', ['log', '--format=%s', value], {
			encoding: 'utf8',
		})
			.split('\n')
			.filter(Boolean);
	} catch {
		// A force push or an initial push leaves no comparable range; there is
		// nothing to check rather than something to fail on.
		console.log('  no comparable commit range — skipping');
		process.exit(0);
	}

	const bad = subjects
		.map((s) => ({ subject: s, problems: check(s) }))
		.filter((r) => r.problems.length > 0);

	if (bad.length === 0) {
		console.log(`  ${subjects.length} commit(s) conform`);
		process.exit(0);
	}
	for (const r of bad) report(r.subject, r.problems);
	fail();
}

console.error('usage: commit-lint.js --file <path> | --range <base>..<head>');
process.exit(2);
