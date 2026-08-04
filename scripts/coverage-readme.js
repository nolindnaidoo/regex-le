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

const total = JSON.parse(fs.readFileSync(summaryPath, 'utf8')).total;
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// Test count: every `it(` / `test(` across the unit suites. Approximate by
// construction, so it is reported as a file+case count rather than a precise
// claim about assertions.
function countTests(dir) {
	let files = 0;
	let cases = 0;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			const sub = countTests(p);
			files += sub.files;
			cases += sub.cases;
		} else if (entry.name.endsWith('.test.ts')) {
			files += 1;
			const src = fs.readFileSync(p, 'utf8');
			cases += (src.match(/^\s*(?:it|test)(?:\.\w+)?\s*\(/gm) || []).length;
		}
	}
	return { files, cases };
}

const { files, cases } = countTests(path.join(root, 'src'));
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

Generated from \`coverage/coverage-summary.json\` by
\`scripts/coverage-readme.js\`; CI fails if this section drifts from a fresh
run. Reproduce with \`bun run test:coverage\`.
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

if (process.argv.includes('--check')) {
	if (next !== readme) {
		console.error(
			`README testing section is out of date for ${pkg.name}. Run \`bun run coverage:readme\` and commit the result.`,
		);
		process.exit(1);
	}
	console.log(`README testing section is current for ${pkg.name}.`);
	process.exit(0);
}

fs.writeFileSync(readmePath, next);
console.log(
	`README testing section updated for ${pkg.name}: ${pct(total.statements)}% statements, ${cases} test cases.`,
);
