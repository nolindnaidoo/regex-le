/**
 * A reader that goes away early: both command lines must behave alike.
 *
 * `| head` closes stdout after a few lines, and a reader can close stderr
 * too. The Rust CLI refuses a closed stdout with one line and exit 2, and
 * carries on past a closed stderr. The npm one crashed with a Node stack
 * trace in both cases. This closes each pipe before either binary writes,
 * on every OS CI runs, because the OS error in the refusal is worded per
 * platform and nothing else checks the Windows one.
 *
 * Shared by every repo with an npm command line, and held identical by
 * letools-site's fleet check. `--mcp-only` skips the command-line cases,
 * for a tool whose command line cannot read the shared tree: one that needs
 * the network, or one that reads a set of catalogues rather than files.
 *
 * Run: bun run build:cli && cargo build --locked --manifest-path crate/Cargo.toml
 *      bun scripts/check-cli-pipes.ts [--mcp-only]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const NAME: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name;
const RUST =
	process.env[`${NAME.toUpperCase().replaceAll('-', '_')}_BIN`] ??
	join(ROOT, 'crate', 'target', 'debug', `${NAME}${process.platform === 'win32' ? '.exe' : ''}`);
const NODE = process.env.NODE_BIN ?? 'node';
const NODE_CLI = join(ROOT, 'cli', 'cli.js');

type Closed = 'stdout' | 'stderr';
type Result = { code: number | null; stdout: string; stderr: string };

function run(command: readonly string[], args: readonly string[], closed: Closed, input: string, cwd: string): Promise<Result> {
	return new Promise((resolve) => {
		const [program, ...rest] = command as [string, ...string[]];
		const child = spawn(program, [...rest, ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		child[closed].destroy();
		if (closed !== 'stdout') child.stdout.on('data', (chunk) => (stdout += chunk));
		if (closed !== 'stderr') child.stderr.on('data', (chunk) => (stderr += chunk));
		child.stdin.on('error', () => {});
		child.stdin.end(input);
		const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
		child.on('close', (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

const tree = mkdtempSync(join(tmpdir(), `${NAME}-pipes-`));
const created: string[] = [];
function file(name: string, content: string): void {
	writeFileSync(join(tree, name), content);
	created.push(join(tree, name));
}
// Something every extractor finds, many times over, two dotenv files that
// disagree on every key, and two manifests that disagree on every
// dependency. A report too small to outlast the pipe's buffer can land
// before the close does, and then the case proves nothing.
const line = '#ff0000 /usr/local/bin/tool "a string" 12345 https://a.example/x KEY=value\n';
const manifest = (version: string) =>
	JSON.stringify({
		dependencies: Object.fromEntries(Array.from({ length: 5_000 }, (_, at) => [`dep-${at}`, version])),
	});
mkdirSync(join(tree, 'big'));
mkdirSync(join(tree, 'big', 'other'));
file('big/many.txt', line.repeat(20_000));
file('big/.env.example', Array.from({ length: 20_000 }, (_, at) => `KEY_${at}=v`).join('\n'));
file('big/.env', 'OTHER=1\n');
file('big/package.json', manifest('1'));
file('big/other/package.json', manifest('2'));

const list = (id: number) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' });
const requests = `${Array.from({ length: 300 }, (_, at) => list(at)).join('\n')}\n`;

const cases: { name: string; args: string[]; closed: Closed; input: string; compare: (keyof Result)[] }[] = [
	{ name: 'mcp, stdout closed', args: ['mcp'], closed: 'stdout', input: requests, compare: ['code', 'stderr'] },
];
if (!process.argv.includes('--mcp-only')) {
	cases.unshift(
		{ name: 'stdout closed', args: ['big'], closed: 'stdout', input: '', compare: ['code', 'stderr'] },
		{ name: 'stderr closed', args: ['big'], closed: 'stderr', input: '', compare: ['code', 'stdout'] },
	);
}

const failures: string[] = [];
try {
	for (const testCase of cases) {
		const [rust, node] = await Promise.all([
			run([RUST], testCase.args, testCase.closed, testCase.input, tree),
			run([NODE, NODE_CLI], testCase.args, testCase.closed, testCase.input, tree),
		]);
		// A closed stdout that the crate did not refuse was never written to,
		// and the case proved nothing.
		if (testCase.closed === 'stdout' && rust.code !== 2) {
			failures.push(`${testCase.name}: the Rust CLI exited ${rust.code}, so nothing was written to the closed pipe`);
		}
		for (const field of testCase.compare) {
			if (rust[field] === node[field]) continue;
			const show = (value: unknown) => JSON.stringify(typeof value === 'string' ? value.slice(-400) : value);
			failures.push(`${testCase.name} [${field}]\n  rust: ${show(rust[field])}\n  node: ${show(node[field])}`);
		}
	}
} finally {
	for (const path of created) unlinkSync(path);
	rmdirSync(join(tree, 'big', 'other'));
	rmdirSync(join(tree, 'big'));
	rmdirSync(tree);
}

if (failures.length > 0) {
	console.error(`The two command lines treat a closed pipe differently:\n\n${failures.join('\n\n')}`);
	process.exit(1);
}
console.log(`OK: both command lines treat a closed pipe alike in ${cases.length} cases`);
