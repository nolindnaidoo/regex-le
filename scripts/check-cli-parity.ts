/**
 * Requires the npm command line to behave exactly as the Rust one does.
 *
 * Both install a command named `regex-le`, so a person or a CI step cannot tell
 * which one they have. This is a different contract from
 * `check-extraction-parity.ts`, which holds the extension's engine equal to
 * the crate's: here the whole terminal surface is compared, the walk, the
 * patterns and their verdicts and witnesses, the exit codes, stdout and
 * stderr byte for byte, and every reply `regex-le mcp` writes, byte for byte
 * too.
 *
 * Every case runs both binaries over one generated tree with stdout piped,
 * which is how a script sees them. `--version` is compared too: every surface
 * carries one version, and two binaries of one name disagreeing about it is
 * the first thing a person comparing them would see.
 *
 * Run: bun run build:cli && cargo build --locked --manifest-path crate/Cargo.toml
 *      bun scripts/check-cli-parity.ts
 */
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmdirSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const RUST =
	process.env.REGEX_LE_BIN ??
	join(
		ROOT,
		'crate',
		'target',
		'debug',
		`regex-le${process.platform === 'win32' ? '.exe' : ''}`,
	);
const NODE_CLI = join(ROOT, 'cli', 'cli.js');
/**
 * Node, by name, not `process.execPath`: this script runs under Bun, and the
 * package is run by Node wherever `npx` runs it. Bun's errors are not Node's.
 */
const NODE = process.env.NODE_BIN ?? 'node';

interface Case {
	readonly args: readonly string[];
	readonly stdin?: string | Buffer;
}

interface Outcome {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

for (const [label, path] of [
	['the Rust binary', RUST],
	['cli/cli.js', NODE_CLI],
] as const) {
	if (!existsSync(path)) {
		console.error(`FAIL: ${label} is missing at ${path}. Build it first.`);
		process.exit(1);
	}
}

const tree = mkdtempSync(join(tmpdir(), 'regex-le-cli-parity-'));
const created: string[] = [];
const dirs: string[] = [tree];

function dir(relative: string): void {
	mkdirSync(join(tree, relative));
	dirs.push(join(tree, relative));
}

function file(relative: string, content: string | Buffer): void {
	writeFileSync(join(tree, relative), content);
	created.push(join(tree, relative));
}

function link(relative: string, target: string): void {
	// Windows grants symlinks to administrators and developer mode only, and
	// both binaries then see the same tree without the link.
	try {
		symlinkSync(target, join(tree, relative));
	} catch {
		return;
	}
	created.push(join(tree, relative));
}

const canLock = process.platform !== 'win32' && process.getuid?.() !== 0;

const DEEP = `${'('.repeat(300)}a${')'.repeat(300)}`;
const WIDE = Array.from({ length: 5_002 }, (_, at) => `w${at}`).join('|');

const JS = [
	'const evil = /(a+)+b/g;',
	'const safe = /^[a-z0-9_-]{3,16}$/i;',
	'const email = /^([a-zA-Z0-9_.+-])+@(([a-zA-Z0-9-])+\\.)+([a-zA-Z0-9]{2,4})+$/;',
	'const alt = new RegExp("(x|x)*y");',
	"const raw = new RegExp(String.raw`(\\d+)*$`, 'u');",
	'const division = total / count / 2;',
	'// a comment with /(a+)+$/ is prose, not code',
	"const str = 'a string with /(b+)+c/ in it';",
	'const back = /(a)\\1+$/;',
	'const look = /(?=a+)+b/;',
	'const dup = /(a+)+b/g;',
	'emoji 🎯 then const e = /(é+)+$/u;',
	'',
].join('\n');

function build(): void {
	dir('repo');
	dir('repo/.git');
	file('repo/.gitignore', 'ignored.js\nbuild/\n');
	file('repo/.ignore', 'dot-ignored.js\n');
	file('repo/app.js', JS);
	file('repo/app.ts', JS);
	file('repo/script.py', 'import re\nre.compile(r"(\\w+\\s?)*$")\nre.match("(a|aa)+$", s)\n# re.compile(r"(x+)+y")\n');
	file('repo/lib.rs', 'let re = Regex::new(r"^(a+)+$").unwrap();\n');
	file('repo/main.go', 'var re = regexp.MustCompile(`(b|b)*c`)\n');
	file('repo/App.java', 'Pattern p = Pattern.compile("(c+)+d");\n');
	file('repo/app.rb', 're = /(d+)+e/\nRegexp.new("(e|e)*f")\n');
	file('repo/app.php', "<?php preg_match('/(f+)+g/i', $s);\n");
	file('repo/App.cs', 'var r = new Regex(@"(g+)+h");\nRegex.IsMatch(s, "(h|h)*i");\n');
	file('repo/notes.md', 'In prose, /(a+)+b/ is just text.\n');
	file('repo/unknown.xyz', 'const r = /(z+)+y/;\n');
	file('repo/crlf.js', 'const a = /(a+)+b/;\r\nconst b = /x/;\r\n');
	file('repo/bom.js', '\uFEFFconst a = /(a+)+b/;\n');
	file('repo/empty.js', '');
	file('repo/deep.js', `const r = new RegExp('${DEEP}');\n`);
	file('repo/deep-literal.js', `const r = /${DEEP}/;\n`);
	file('repo/wide.py', `re.compile("${WIDE}")\n`);
	file('repo/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x0d]));
	file('repo/latin1.js', Buffer.from([0x2f, 0x61, 0x2f, 0x20, 0xe9, 0x0a]));
	file('repo/ignored.js', 'const r = /(i+)+j/;\n');
	file('repo/dot-ignored.js', 'const r = /(j+)+k/;\n');
	file('repo/.hidden.js', 'const r = /(k+)+l/;\n');
	dir('repo/build');
	file('repo/build/out.js', 'const r = /(l+)+m/;\n');
	dir('repo/nested');
	file('repo/nested/.gitignore', 'local.js\n');
	file('repo/nested/local.js', 'const r = /(m+)+n/;\n');
	file('repo/nested/kept.js', 'const r = /(n+)+o/;\n');
	file('repo/ünïcode.js', 'const r = /(ü+)+ö/u;\n');
	link('repo/linked.js', 'app.js');
	link('repo/linked-dir', 'nested');
	dir('loose');
	file('loose/plain.js', 'const r = /(o+)+p/;\n');
	dir('many');
	file('many/big.js', `${JS}`.repeat(400));
	if (canLock) {
		file('repo/locked.js', 'const r = /(p+)+q/;\n');
		chmodSync(join(tree, 'repo', 'locked.js'), 0o000);
		dir('closed');
		dir('closed/shut');
		file('closed/shut/inside.js', 'x\n');
		file('closed/open.js', 'const r = /(q+)+r/;\n');
		chmodSync(join(tree, 'closed', 'shut'), 0o000);
	}
}

function cases(): readonly Case[] {
	const repo = join(tree, 'repo');
	const at = (name: string) => join(repo, name);
	const corpus = join(ROOT, 'crate', 'fixtures', 'documents');
	return [
		{ args: ['--help'] },
		{ args: ['-h'] },
		{ args: ['--version'] },
		{ args: ['-V'] },
		{ args: [repo, '--help'] },
		{ args: [] },
		{ args: [repo] },
		{ args: [`${repo}/`] },
		{ args: ['repo'] },
		{ args: ['./repo/nested/'] },
		{ args: [repo, '--all'] },
		{ args: [repo, '--hidden'] },
		{ args: [repo, '--no-ignore'] },
		{ args: [repo, '--hidden', '--no-ignore', '--all'] },
		{ args: [repo, '--strict'] },
		{ args: [repo, '--severity', 'high'] },
		{ args: [repo, '--severity', 'medium', '--all'] },
		{ args: [repo, '--severity', 'low'] },
		{ args: [repo, '--severity', 'HIGH'] },
		{ args: [repo, '--severity', '--all'] },
		{ args: [repo, '--severity'] },
		{ args: [repo, '--test'] },
		{ args: [repo, '-'] },
		{ args: [at('app.js'), '--all'] },
		{ args: [at('app.ts'), at('script.py'), at('lib.rs'), at('main.go'), '--all'] },
		{ args: [at('App.java'), at('app.rb'), at('app.php'), at('App.cs'), '--all'] },
		{ args: [at('notes.md'), at('unknown.xyz'), '--all'] },
		{ args: [at('crlf.js'), at('bom.js'), at('empty.js')] },
		{ args: [at('deep.js')] },
		{ args: [at('deep-literal.js'), '--all'] },
		{ args: [at('wide.py')] },
		{ args: [at('deep.js'), at('app.js')] },
		{ args: [at('logo.png'), at('latin1.js')] },
		{ args: [at('latin1.js'), '--strict'] },
		{ args: [at('logo.png'), '--strict'] },
		{ args: [at('ignored.js'), at('.hidden.js'), at('dot-ignored.js')] },
		{ args: [at('app.js'), at('app.js')] },
		{ args: [at('nested'), at('nested/kept.js')] },
		{ args: [at('linked.js')] },
		{ args: [at('linked-dir')] },
		{ args: [at('ünïcode.js'), '--all'] },
		{ args: [join(tree, 'loose')] },
		{ args: [join(tree, 'many')] },
		...(canLock
			? [
					{ args: [join(tree, 'closed')] },
					{ args: [at('locked.js')] },
					{ args: [at('locked.js'), '--strict'] },
				]
			: []),
		{ args: [join(tree, 'missing')] },
		{ args: [repo, join(tree, 'missing')] },
		{ args: ['--stdin'] },
		{ args: ['--stdin', repo] },
		{ args: ['--stdin', '--all'], stdin: JS },
		{ args: ['--stdin'], stdin: `\uFEFF${JS}` },
		{ args: ['--stdin'], stdin: `const r = new RegExp('${DEEP}');` },
		{ args: ['--stdin'], stdin: Buffer.from([0x2f, 0xff, 0x2f, 0x0a]) },
		{ args: ['--stdin'], stdin: '' },
		{ args: [corpus] },
		{ args: [corpus, '--all', '--hidden', '--no-ignore'] },
		{ args: [join(ROOT, 'src', 'extraction', 'regex', '__fixtures__'), '--all'] },
	];
}

function run(command: readonly string[], testCase: Case): Outcome {
	const [program, ...rest] = command as [string, ...string[]];
	const result = spawnSync(program, [...rest, ...testCase.args], {
		input: testCase.stdin ?? '',
		cwd: tree,
		maxBuffer: 256 * 1024 * 1024,
	});
	return {
		status: result.status,
		stdout: result.stdout.toString('utf8'),
		stderr: result.stderr.toString('utf8'),
	};
}

function compareCli(): string[] {
	const failures: string[] = [];
	for (const testCase of cases()) {
		const rust = run([RUST], testCase);
		const node = run([NODE, NODE_CLI], testCase);
		for (const field of ['status', 'stdout', 'stderr'] as const) {
			if (rust[field] === node[field]) continue;
			failures.push(
				`regex-le ${testCase.args.join(' ')}\n  ${field} differs\n` +
					describeDifference(String(rust[field]), String(node[field])),
			);
		}
	}
	return failures;
}

function mcpLines(): readonly string[] {
	const repo = join(tree, 'repo');
	let id = 0;
	const request = (method: string, params?: unknown) =>
		JSON.stringify({
			jsonrpc: '2.0',
			id: ++id,
			method,
			...(params === undefined ? {} : { params }),
		});
	const call = (name: string, args?: unknown) =>
		request('tools/call', args === undefined ? { name } : { name, arguments: args });
	const extract = (args: Record<string, unknown>) => call('extract_patterns', args);
	const lint = (args: Record<string, unknown>) => call('regex_le_lint', args);
	return [
		request('initialize', { protocolVersion: '2024-11-05' }),
		JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
		request('tools/list'),
		request('ping'),
		request('resources/list'),
		request('tools/call'),
		request('tools/call', { arguments: {} }),
		request('tools/call', null),
		call('no_such_tool', {}),
		JSON.stringify({ jsonrpc: '2.0', id: 'text-id', method: 'ping' }),
		JSON.stringify({ jsonrpc: '2.0', id: null, method: 'ping' }),
		JSON.stringify({ jsonrpc: '2.0', id: { b: 1, a: [2] }, method: 'ping' }),
		JSON.stringify({ id: 77, method: 'ping' }),
		JSON.stringify({ jsonrpc: '2.0', id: 78 }),
		'not json',
		'',
		'   ',
		'[1, 2]',
		`${request('ping')}\r`,
		extract({ content: JS }),
		extract({ content: JS, format: 'typescript', maxResults: 2 }),
		extract({ content: 'import re\nre.compile(r"(a+)+$")', filename: 'x.py' }),
		extract({ content: 'x', format: 'kotlin' }),
		extract({ content: `const r = new RegExp('${DEEP}');`, format: 'javascript' }),
		extract({ content: `re.compile("${WIDE}")`, format: 'python' }),
		extract({ content: JS, maxResults: 0 }),
		extract({ content: 7 }),
		extract({}),
		call('extract_patterns', null),
		lint({ path: repo }),
		lint({ paths: [repo, join(tree, 'loose')], all: true }),
		lint({ path: repo, hidden: true, ignored: true, severity: 'high' }),
		lint({ path: repo, severity: 'low' }),
		lint({ path: repo, severity: 'extreme' }),
		lint({ path: repo, severity: 3 }),
		lint({ path: join(repo, 'app.js'), hidden: 'yes' }),
		lint({ paths: [] }),
		lint({ paths: [3] }),
		lint({ path: 3, paths: [join(repo, 'notes.md')] }),
		lint({}),
		lint({ path: join(tree, 'missing') }),
		...(canLock ? [lint({ path: join(tree, 'closed') })] : []),
	];
}

function serve(command: readonly string[], input: string | Buffer): Outcome {
	const [program, ...rest] = command as [string, ...string[]];
	const result = spawnSync(program, [...rest, 'mcp'], { input, cwd: tree });
	return {
		status: result.status,
		stdout: result.stdout.toString('utf8'),
		stderr: result.stderr.toString('utf8'),
	};
}

function compareMcp(): string[] {
	const failures: string[] = [];
	const lines = mcpLines();
	const sessions: readonly (readonly [string, string | Buffer])[] = [
		['the whole session', `${lines.join('\n')}\n`],
		['a last line with no newline', lines[3] as string],
		[
			'a line that is not UTF-8',
			Buffer.concat([
				Buffer.from(`${lines[3]}\n`),
				Buffer.from([0x7b, 0xff, 0x7d, 0x0a]),
				Buffer.from(`${lines[3]}\n`),
			]),
		],
	];
	for (const [label, input] of sessions) {
		const rust = serve([RUST], input);
		const node = serve([NODE, NODE_CLI], input);
		for (const field of ['status', 'stdout', 'stderr'] as const) {
			if (rust[field] === node[field]) continue;
			failures.push(
				`regex-le mcp, ${label}\n  ${field} differs\n` +
					describeDifference(String(rust[field]), String(node[field])),
			);
		}
	}
	return failures;
}

/** The first differing line, which is the one worth reading in a long output. */
function describeDifference(rust: string, node: string): string {
	const left = rust.split('\n');
	const right = node.split('\n');
	const index = left.findIndex((line, at) => line !== right[at]);
	const at = index === -1 ? left.length : index;
	const clip = (line: string | undefined) =>
		line === undefined || line.length <= 2000 ? line : `${line.slice(0, 2000)}…`;
	return `  line ${at + 1}\n  rust: ${clip(left[at])}\n  node: ${clip(right[at])}`;
}

function cleanUp(): void {
	const unlock: readonly (readonly [string, number])[] = [
		[join(tree, 'repo', 'locked.js'), 0o600],
		[join(tree, 'closed', 'shut'), 0o700],
	];
	for (const [path, mode] of unlock) if (existsSync(path)) chmodSync(path, mode);
	for (const path of created) unlinkSync(path);
	for (const path of [...dirs].reverse()) rmdirSync(path);
}

build();
let failures: string[];
try {
	failures = [...compareCli(), ...compareMcp()];
} finally {
	cleanUp();
}

if (failures.length > 0) {
	console.error(failures.join('\n\n'));
	console.error(`\nFAIL: ${failures.length} difference(s) between the npm and Rust CLIs`);
	process.exit(1);
}
console.log(
	`OK: the npm CLI matches the Rust CLI on ${cases().length} commands and ${mcpLines().length} MCP lines`,
);
