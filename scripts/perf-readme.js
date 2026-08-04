#!/usr/bin/env node
// Render the README's Performance section from benchmark-results.json.
//
// Unlike the coverage section this is NOT checked in CI: throughput is
// machine-specific, so a hosted runner would fail it for reasons that say
// nothing about the code. The host is printed alongside the numbers instead,
// so a reader knows what produced them and can reproduce it.
//
//   bun run benchmark        measure, writing benchmark-results.json
//   bun run perf:readme      render the section
const fs = require('node:fs');
const path = require('node:path');

const START = '<!-- performance:start -->';
const END = '<!-- performance:end -->';

const root = path.resolve(__dirname, '..');
const dataPath = path.join(root, 'benchmark-results.json');
const readmePath = path.join(root, 'README.md');

if (!fs.existsSync(dataPath)) {
	console.error('benchmark-results.json not found — run `bun run benchmark` first.');
	process.exit(1);
}

const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const mb = (bytes) => `${(bytes / 1_048_576).toFixed(2)} MB`;
const num = (n) => n.toLocaleString('en-US');

const rows = data.results
	.map((r) => {
		// A case that legitimately finds nothing has no items/sec. Printing "0/sec"
		// is how the pre-2.0 README ended up with a nonsense row; MB/sec is the
		// honest figure for scan rate either way.
		const rate = r.perSecond === null || r.perSecond === undefined
			? '—'
			: `${num(r.perSecond)}/sec`;
		return `| ${r.label} | ${mb(r.bytes)} | ${num(r.extracted)} | ${r.ms} ms | ${rate} | ${r.mbPerSecond} MB/s |`;
	})
	.join('\n');

const block = `${START}
| Input | Size | Found | Time | Rate | Scan speed |
| --- | --- | --- | --- | --- | --- |
${rows}

Median of ${data.runs} runs after warmup, on ${data.host}. Inputs are generated
by \`scripts/benchmark.ts\` rather than checked in, so the sizes above are
exactly what was measured. Reproduce with \`bun run benchmark\`.

These are machine-specific and are not asserted in CI — a benchmark that gates
a build only tells you how busy the runner was.
${END}`;

const readme = fs.readFileSync(readmePath, 'utf8');
const startIdx = readme.indexOf(START);
const endIdx = readme.indexOf(END);

if (startIdx === -1 || endIdx === -1) {
	console.error(`README.md is missing the ${START} / ${END} markers.`);
	process.exit(1);
}

fs.writeFileSync(
	readmePath,
	readme.slice(0, startIdx) + block + readme.slice(endIdx + END.length),
);
console.log(
	`README performance section updated for ${pkg.name}: ${data.results.length} cases.`,
);
