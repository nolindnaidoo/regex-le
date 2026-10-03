/**
 * Both servers must define the shared MCP tool identically.
 *
 * The differential compares what the two servers answer. An agent decides what
 * to send by reading the tool's definition — its description and its schema —
 * so two servers that answer alike but describe the tool differently are still
 * two tools. Nothing compared the definitions, and six of the ten had drifted:
 * one described an argument backwards, one described what it returns wrongly,
 * and two offered fewer formats than they accept.
 *
 * Identical in every *-le repo; the fleet check holds the copies equal.
 *
 * Run: bun scripts/check-mcp-definition.ts
 *   MCP_DEFINITION_BIN=<path>  the Rust binary (default: the newest build)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { TOOLS } from '../src/mcp/tools';

const ROOT = join(import.meta.dir, '..');
const NAME = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { name: string }).name;

function binary(): string {
	const chosen = process.env.MCP_DEFINITION_BIN;
	if (chosen) return chosen;
	// Whichever profile this job built. Both exist only on a developer's
	// machine, where the newer one is the one that reflects the source.
	const built = ['release', 'debug']
		.map((profile) => join(ROOT, 'crate', 'target', profile, NAME))
		.filter((path) => existsSync(path))
		.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
	if (built[0] === undefined) {
		throw new Error(`no ${NAME} binary — build it first: cd crate && cargo build --locked`);
	}
	return built[0];
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, item]) => item !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : 1));
	return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}

/** Each field that differs, with both values, so the fix is readable. */
function differences(ours: Record<string, unknown>, theirs: Record<string, unknown>, path: string): string[] {
	const out: string[] = [];
	for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
		const a = ours[key];
		const b = theirs[key];
		if (canonical(a) === canonical(b)) continue;
		const isObject = (v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v);
		if (isObject(a) && isObject(b)) {
			out.push(...differences(a as Record<string, unknown>, b as Record<string, unknown>, `${path}.${key}`));
		} else {
			out.push(`${path}.${key}\n    npm:   ${canonical(a)}\n    crate: ${canonical(b)}`);
		}
	}
	return out;
}

const bin = binary();
const listed = spawnSync(bin, ['mcp'], {
	input: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n',
	encoding: 'utf8',
});
const crateTools =
	(
		JSON.parse(listed.stdout.trim().split('\n')[0] ?? '{}') as {
			result?: { tools?: Record<string, unknown>[] };
		}
	).result?.tools ?? [];

const failures: string[] = [];
for (const tool of TOOLS) {
	const twin = crateTools.find((candidate) => candidate.name === tool.name);
	if (twin === undefined) {
		failures.push(`the crate server does not offer ${tool.name}`);
		continue;
	}
	const ours = { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
	failures.push(...differences(ours, twin, tool.name));
}

if (failures.length > 0) {
	console.error(`The two servers define the shared tool differently (${bin.replace(ROOT, '.')}):\n`);
	for (const failure of failures) console.error(`- ${failure}`);
	process.exit(1);
}
console.log(`OK: both servers define ${TOOLS.map((t) => t.name).join(', ')} identically.`);
