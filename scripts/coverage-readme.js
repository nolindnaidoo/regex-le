#!/usr/bin/env node
// Regenerate the README's Testing section from the last coverage run.
//
// The pre-2.0 READMEs carried hand-written test counts and coverage numbers.
// They drifted from reality and became claims rather than facts, which is why
// the rehab deleted them. This writes the same information from
// coverage/coverage-summary.json instead, and `--check` fails when the README
// no longer matches a fresh run — so the numbers cannot silently go stale.
//
//   node scripts/coverage-readme.js          rewrite the block
//   node scripts/coverage-readme.js --check  exit 1 if out of date
const fs = require('node:fs');
const path = require('node:path');

const START = '<!-- coverage:start -->';
const END = '<!-- coverage:end -->';

const root = path.resolve(__dirname, '..');
const summaryPath = path.join(root, 'coverage', 'coverage-summary.json');
const readmePath = path.join(root, 'README.md');

if (!fs.existsSync(summaryPath)) {
	console.error(
		'coverage/coverage-summary.json not found — run `bun run test:coverage` first.',
	);
	process.exit(1);
}

// A summary older than the code it describes makes both modes lie: the rewrite
// reproduces stale numbers, and --check then compares the README against the
// same stale file and reports it current. That is how a green local gate and a
// red CI run happened — CI always runs coverage fresh.
function newestSourceTime(dir) {
	let newest = 0;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === '__snapshots__' || entry.name === '__fixtures__') continue;
		const full = path.join(dir, entry.name);
		const time = entry.isDirectory()
			? newestSourceTime(full)
			: fs.statSync(full).mtimeMs;
		if (time > newest) newest = time;
	}
	return newest;
}

if (newestSourceTime(path.join(root, 'src')) > fs.statSync(summaryPath).mtimeMs) {
	console.error(
		'coverage/coverage-summary.json is older than src/ — run `bun run test:coverage` first.',
	);
	process.exit(1);
}

const total = JSON.parse(fs.readFileSync(summaryPath, 'utf8')).total;
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// Test counts come from the run, not from a regex over the source.
//
// They used to be counted by matching `it(` / `test(` per line, which counts a
// table-driven `it.each(CASES)(...)` as one case while it runs as many. Every
// README in the fleet understated itself as a result — by between 21 and 105
// cases — and `--check` then enforced the wrong number exactly. A gate that is
// precise about a figure nobody can reproduce is worse than no figure: the
// reader runs the suite, sees a different number, and learns that the README is
// decorative. (No sibling is named here on purpose: the fleet check normalises
// a repo's own name away, so naming two of them gives one file three different
// shapes and reports drift that is not there.)
const resultsPath = path.join(root, 'coverage', 'test-results.json');
if (!fs.existsSync(resultsPath)) {
	console.error(
		'coverage/test-results.json not found — run `bun run test:coverage` first.',
	);
	process.exit(1);
}

const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
const cases = results.numTotalTests;
const files = results.testResults.length;

// `numTotalTestSuites` counts describe blocks, not files; the file count is the
// length of testResults. Both are asserted here rather than trusted, because a
// reporter shape change would otherwise write `undefined` into the README.
if (!Number.isInteger(cases) || !Number.isInteger(files)) {
	console.error(
		'coverage/test-results.json has no numTotalTests / testResults — the vitest JSON reporter shape changed.',
	);
	process.exit(1);
}
const pct = (m) => m.pct.toFixed(2);

const block = `${START}
| Metric | Coverage |
| --- | --- |
| Statements | ${pct(total.statements)}% |
| Branches | ${pct(total.branches)}% |
| Functions | ${pct(total.functions)}% |
| Lines | ${pct(total.lines)}% |

${cases} test cases across ${files} files, plus an integration suite that runs
in a real VS Code extension host and an end-to-end test that installs the
built \`.vsix\` into a clean profile.

Generated from a real run — \`coverage/coverage-summary.json\` and
\`coverage/test-results.json\` — by \`scripts/coverage-readme.js\`; CI fails if
this section drifts. Reproduce with \`bun run test:coverage\`, and the case
count is the one vitest prints.
${END}`;

const readme = fs.readFileSync(readmePath, 'utf8');
const startIdx = readme.indexOf(START);
const endIdx = readme.indexOf(END);

if (startIdx === -1 || endIdx === -1) {
	console.error(
		`README.md is missing the ${START} / ${END} markers — add them under a "## Testing" heading.`,
	);
	process.exit(1);
}

const next =
	readme.slice(0, startIdx) + block + readme.slice(endIdx + END.length);

// Coverage percentages are not bit-identical across environments — v8
// attributes a little differently depending on timing, and a worker-thread
// test that is terminated mid-run varies by fractions of a point. Comparing
// the rendered text exactly makes CI fail on ~0.1pp of noise, so --check
// compares numerically with a tolerance instead. The point of the gate is to
// catch a README that claims 93% when the truth is 82%, or 289 tests when
// there are 142 — not to police the second decimal place.
const TOLERANCE_PP = 1;

function readMetrics(text) {
	const metrics = {};
	for (const name of ['Statements', 'Branches', 'Functions', 'Lines']) {
		const m = text.match(new RegExp(`\\|\\s*${name}\\s*\\|\\s*([\\d.]+)%\\s*\\|`));
		if (m) metrics[name] = Number.parseFloat(m[1]);
	}
	const counts = text.match(/(\d+) test cases across (\d+) files/);
	if (counts) {
		metrics.cases = Number.parseInt(counts[1], 10);
		metrics.files = Number.parseInt(counts[2], 10);
	}
	return metrics;
}

if (process.argv.includes('--check')) {
	const committed = readMetrics(readme.slice(startIdx, endIdx));
	const fresh = readMetrics(block);
	const problems = [];

	// Test counts come from source and are deterministic — exact match.
	for (const key of ['cases', 'files']) {
		if (committed[key] !== fresh[key]) {
			problems.push(`${key}: README says ${committed[key]}, actual is ${fresh[key]}`);
		}
	}
	for (const key of ['Statements', 'Branches', 'Functions', 'Lines']) {
		const a = committed[key];
		const b = fresh[key];
		if (a === undefined || Math.abs(a - b) > TOLERANCE_PP) {
			problems.push(
				`${key}: README says ${a ?? '(missing)'}%, actual is ${b.toFixed(2)}%`,
			);
		}
	}

	if (problems.length > 0) {
		console.error(`README testing section is out of date for ${pkg.name}:`);
		for (const p of problems) console.error(`  ${p}`);
		console.error('Run `bun run coverage:readme` and commit the result.');
		process.exit(1);
	}
	console.log(
		`README testing section is current for ${pkg.name} (within ${TOLERANCE_PP}pp).`,
	);
	process.exit(0);
}

fs.writeFileSync(readmePath, next);
console.log(
	`README testing section updated for ${pkg.name}: ${pct(total.statements)}% statements, ${cases} test cases.`,
);
