/**
 * Generates the cases the hand-written corpus cannot contain — the ones
 * nobody thought of — and requires the two `extract_patterns` servers to
 * answer them identically.
 *
 * **What is being compared, and what is not.** `extract_patterns` is one
 * tool with one name and one schema, offered by two servers: the npm
 * server in `src/mcp/tools.ts` and the crate's in
 * `crate/src/mcp/extract.rs`. An agent asking for it must get the same
 * answer whichever it happens to reach, so a divergence here is a bug in
 * the shared tool.
 *
 * The two *surfaces* are a different matter and are deliberately not
 * compared. The extension is IDE-first — one open buffer, a person
 * reading results in an editor. The CLI is terminal-first — trees, exit
 * codes, piping. The walk, `--severity`, `--all`, `--strict` and JSON
 * Lines exist on one side only because that is what its use case wants,
 * and holding either to the other's shape would make both worse.
 * Deliberate divergences are written down in `crate/SPEC.md`.
 *
 * `scripts/check-extraction-parity.ts` pins the corpus: fixed documents,
 * fixed expectations, both sides. This pins the *agreement* over inputs
 * neither side has seen, which is the check that catches one language
 * name reaching two different extractors.
 *
 * Deterministic: the seed is printed on every run and can be pinned with
 * DIFFERENTIAL_SEED, so a failure reproduces exactly.
 *
 * Run: bun scripts/check-extraction-differential.ts
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { TOOLS } from '../src/mcp/tools';

const ROOT = join(import.meta.dir, '..');
const BINARY =
	process.env.REGEX_LE_BINARY ??
	join(ROOT, 'crate', 'target', 'release', 'regex-le');

/** At least 500, per the CI contract. More costs a second, not a minute. */
const DOCUMENTS = 600;

const SEED = Number(process.env.DIFFERENTIAL_SEED ?? 20260812);

/** A small, fast, fully deterministic generator. No dependency. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * The pattern bank: the shapes the detector exists to catch, the shapes
 * it must not flag, the spellings JavaScript refuses and their own
 * languages use daily, and a few outright syntax errors.
 *
 * None of them carries a quote, a backtick or a newline, so every one
 * can go verbatim into a raw string in any of the nine grammars. The
 * quoted forms are covered separately, below.
 */
const PATTERNS: readonly string[] = [
	// Exponential.
	'(a+)+',
	'([a-z]+)*',
	String.raw`(\w*)+`,
	'((a)*)*',
	'(?:a+)+',
	'(a+)+b',
	String.raw`(\d+)+$`,
	// Overlapping alternation.
	'(a|a)*',
	'(a|ab)+',
	'(x|xy|xyz)*',
	// Ordinary.
	String.raw`^\d{4}-\d{2}-\d{2}$`,
	'[a-z]+',
	'(abc)+',
	'(a+)',
	'(a|b)*',
	String.raw`\s*`,
	'(a{1,3})*',
	'(a{1,})*',
	String.raw`[^/]+`,
	'[(]+',
	String.raw`\(a+\)+`,
	'[a|b]+',
	// The spellings `regress` refuses and Python, Go, Rust, PHP and PCRE
	// write every day. Reporting one of these as `Pattern is invalid`
	// would be a verdict on working code, which is what the JavaScript
	// rendering exists to prevent.
	String.raw`(?P<year>\d{4})`,
	String.raw`(?P<w>\w+)+@`,
	'(?P<a>x)(?P=a)',
	'(?i)^[a-z]+$',
	'(?i)(a+)+',
	'(?im-sx)abc',
	'(?>a+)b',
	'a++',
	'a{2,}+',
	'(?#note)b',
	"(?'name'a)",
	// Syntax errors, which are a syntax error and never a vulnerability.
	'a{2,1}',
	'(',
	'[z-a]',
	// Where JavaScript's character classes are not Rust's. `\w` is ASCII
	// in a JavaScript regex and Unicode in Rust's, and JavaScript's `\s`
	// holds U+FEFF and not U+0085 while Rust's holds the opposite — so
	// the overlap test answers differently for every one of these unless
	// both sides spell the class out.
	'(é|é)*',
	'(\u{feff}a|\u{feff}b)*',
	'(\u{85}a|\u{85}b)*',
	'[é-ü]+',
	'(日|日)*',
];

/**
 * The patterns that are valid in at least one of the languages read here
 * and invalid as JavaScript. A call form must report every one of them,
 * and never with the verdict `Pattern is invalid`. That was the bug the
 * JavaScript rendering fixed, and it must not come back.
 */
const VALID_ELSEWHERE: ReadonlySet<string> = new Set([
	String.raw`(?P<year>\d{4})`,
	String.raw`(?P<w>\w+)+@`,
	'(?P<a>x)(?P=a)',
	'(?i)^[a-z]+$',
	'(?i)(a+)+',
	'(?im-sx)abc',
	'(?>a+)b',
	'a++',
	'a{2,}+',
	'(?#note)b',
	"(?'name'a)",
]);

/** How a pattern is written into a document once it has a call site. */
const WRAPPERS: ReadonlyArray<{
	readonly name: string;
	readonly wrap: (site: string, comment: string) => string;
}> = [
	{ name: 'alone on a line', wrap: (site) => `${site}\n` },
	{
		name: 'after a comment',
		wrap: (site, comment) => `${comment} what the next line does\n${site}\n`,
	},
	{
		name: 'commented out',
		wrap: (site, comment) => `${comment} ${site}\n`,
	},
	{ name: 'mid-line', wrap: (site) => `value = check(${site})\n` },
	{ name: 'indented', wrap: (site) => `\t${site}\n\tmore()\n` },
	{
		name: 'at EOF without a newline',
		wrap: (site, comment) => `${comment} header\n${site}`,
	},
	{ name: 'twice', wrap: (site) => `${site}\n${site}\n` },
	{
		name: 'beside a division and a URL',
		wrap: (site, comment) =>
			`${comment} see https://example.com/docs\nratio = total / count\n${site}\n`,
	},
];

/** A raw-string form cannot hold its own terminator. */
function usableRaw(pattern: string, terminator: string): boolean {
	return !pattern.includes(terminator);
}

/** The JavaScript string-literal escaping a constructor argument needs. */
function escapeForQuotes(pattern: string, quote: string): string {
	return pattern
		.replaceAll('\\', '\\\\')
		.replaceAll(quote, `\\${quote}`)
		.replaceAll('\r', '')
		.replaceAll('\n', '');
}

interface LanguageSpec {
	readonly id: string;
	/** Names an agent might send for this language. */
	readonly hints: readonly string[];
	readonly filenames: readonly string[];
	readonly comment: string;
	readonly sites: ReadonlyArray<(pattern: string) => string | undefined>;
}

const LANGUAGES: readonly LanguageSpec[] = [
	{
		id: 'javascript',
		hints: ['javascript', 'js', '.js', 'mjs'],
		filenames: ['validate.js', 'src/deep/index.mjs'],
		comment: '//',
		sites: [
			(p) => (p.includes('/') ? undefined : `const re = /${p}/g;`),
			(p) => `const re = new RegExp('${escapeForQuotes(p, "'")}');`,
			(p) => `const re = RegExp("${escapeForQuotes(p, '"')}", "i");`,
		],
	},
	{
		id: 'typescript',
		hints: ['typescript', 'ts', 'tsx'],
		filenames: ['validate.ts', 'app/form.tsx'],
		comment: '//',
		sites: [
			(p) => (p.includes('/') ? undefined : `const re: RegExp = /${p}/;`),
			(p) =>
				`const re = new RegExp(\n  '${escapeForQuotes(p, "'")}',\n  'g',\n);`,
		],
	},
	{
		id: 'python',
		hints: ['python', 'py', '.PY', 'pyi'],
		filenames: ['validate.py', 'pkg/parse.pyw'],
		comment: '#',
		sites: [
			(p) => (usableRaw(p, '"') ? `P = re.compile(r"${p}")` : undefined),
			(p) => (usableRaw(p, "'") ? `P = re.search(r'${p}', s)` : undefined),
			(p) => (usableRaw(p, '"') ? `P = re.sub("""${p}""", "", s)` : undefined),
			(p) => `P = re.finditer("${escapeForQuotes(p, '"')}", s)`,
		],
	},
	{
		id: 'rust',
		hints: ['rust', 'rs'],
		filenames: ['validate.rs', 'src/detect/scan.rs'],
		comment: '//',
		sites: [
			(p) => (usableRaw(p, '"') ? `let r = Regex::new(r"${p}");` : undefined),
			(p) =>
				usableRaw(p, '"#')
					? `let r = RegexBuilder::new(r#"${p}"#).build();`
					: undefined,
			(p) => `let r = Regex::new("${escapeForQuotes(p, '"')}");`,
		],
	},
	{
		id: 'go',
		hints: ['go', 'golang'],
		filenames: ['validate.go'],
		comment: '//',
		sites: [
			(p) =>
				usableRaw(p, '`') ? `var re = regexp.MustCompile(\`${p}\`)` : undefined,
			(p) => `var re, err = regexp.Compile("${escapeForQuotes(p, '"')}")`,
			(p) =>
				usableRaw(p, '`')
					? `var re = regexp.MustCompilePOSIX(\`${p}\`)`
					: undefined,
		],
	},
	{
		id: 'java',
		hints: ['java'],
		filenames: ['Validate.java'],
		comment: '//',
		sites: [
			(p) => `Pattern p = Pattern.compile("${escapeForQuotes(p, '"')}");`,
			(p) => `boolean ok = Pattern.matches("${escapeForQuotes(p, '"')}", s);`,
		],
	},
	{
		id: 'ruby',
		hints: ['ruby', 'rb', 'rake', 'gemspec'],
		filenames: ['validate.rb', 'Rakefile.rake'],
		comment: '#',
		sites: [
			(p) => (p.includes('/') ? undefined : `RE = /${p}/`),
			(p) => `RE = Regexp.new('${escapeForQuotes(p, "'")}')`,
			(p) => `RE = Regexp.compile("${escapeForQuotes(p, '"')}")`,
		],
	},
	{
		id: 'php',
		hints: ['php', 'phtml'],
		filenames: ['validate.php', 'view/page.phtml'],
		comment: '//',
		sites: [
			(p) => (p.includes('/') ? undefined : `preg_match('/${p}/i', $s);`),
			(p) => (p.includes('#') ? undefined : `preg_replace('#${p}#', '', $s);`),
			(p) => (p.includes('~') ? undefined : `preg_split('~${p}~u', $s);`),
			(p) =>
				p.includes('}') ? undefined : `preg_grep('{${p}}', $list);`,
		],
	},
	{
		id: 'csharp',
		hints: ['csharp', 'cs', 'c#', 'csx', 'cake'],
		filenames: ['Validate.cs', 'build.cake'],
		comment: '//',
		sites: [
			(p) => (usableRaw(p, '"') ? `var r = new Regex(@"${p}");` : undefined),
			(p) =>
				usableRaw(p, '"')
					? `var ok = Regex.IsMatch(input, @"${p}");`
					: undefined,
			(p) => `var r = new Regex("${escapeForQuotes(p, '"')}");`,
		],
	},
];

interface Case {
	readonly index: number;
	readonly language: string;
	readonly wrapper: string;
	readonly pattern: string;
	readonly hint: string;
	readonly content: string;
	readonly args: Record<string, unknown>;
}

function generate(): Case[] {
	const random = mulberry32(SEED);
	const pick = <T>(items: readonly T[]): T =>
		items[Math.floor(random() * items.length)] as T;

	const cases: Case[] = [];
	let index = 0;
	let attempts = 0;
	while (cases.length < DOCUMENTS && attempts < DOCUMENTS * 20) {
		attempts += 1;
		const language = pick(LANGUAGES);
		const pattern = pick(PATTERNS);
		const site = pick(language.sites)(pattern);
		if (site === undefined) continue;
		const wrapper = pick(WRAPPERS);
		const content = wrapper.wrap(site, language.comment);

		// Every way an agent can name — or fail to name — a language.
		// The optional arguments are part of the shared schema, so they
		// are part of what has to agree.
		const style = Math.floor(random() * 6);
		const args: Record<string, unknown> = { content };
		let hint = 'none';
		if (style === 0) {
			hint = pick(language.hints);
			args.format = hint;
		} else if (style === 1) {
			hint = pick(language.filenames);
			args.filename = hint;
		} else if (style === 2) {
			hint = pick(language.hints);
			args.format = hint;
			args.filename = 'notes.txt';
		} else if (style === 3) {
			hint = 'kotlin';
			args.format = hint;
		} else if (style === 4) {
			hint = pick(language.filenames);
			args.filename = hint;
			args.maxResults = 1;
		}

		cases.push({
			index,
			language: language.id,
			wrapper: wrapper.name,
			pattern,
			hint,
			content,
			args,
		});
		index += 1;
	}
	return cases;
}

/**
 * Whitespace, where `String.prototype.trim` and `\s` are not `str::trim`
 * and Rust's `\s`.
 *
 * JavaScript's whitespace set holds U+FEFF and not U+0085; Unicode's
 * `White_Space` has it exactly the other way round. Every one of these
 * reached a different answer on the two servers until both sides spelled
 * the set out, and a byte-order mark in a file is ordinary rather than
 * exotic — which makes this the least theoretical divergence there is.
 */
function whitespaceCases(from: number): Case[] {
	const BOM = '\u{feff}';
	const NEL = '\u{85}';
	const NBSP = '\u{a0}';
	const written: ReadonlyArray<[string, string, Record<string, unknown>]> = [
		['python', 'P = re.compile(r"(a+)+")\n', { format: `${BOM}python` }],
		['python', 'P = re.compile(r"(a+)+")\n', { format: `${NEL}python` }],
		['python', 'P = re.compile(r"(a+)+")\n', { format: `${NBSP}python` }],
		['python', 'P = re.compile(r"(a+)+")\n', { filename: `${BOM}app.py` }],
		['python', `P = re.compile${BOM}(r"(a+)+")\n`, { format: 'python' }],
		['python', `P = re.compile${NEL}(r"(a+)+")\n`, { format: 'python' }],
		['python', `P = re.compile(${BOM}r"(a+)+")\n`, { format: 'python' }],
		['javascript', `const re = new${BOM}RegExp('(a+)+');\n`, { format: 'js' }],
		['javascript', `const re = RegExp${NEL}('(a+)+');\n`, { format: 'js' }],
		['php', `preg_match('${BOM}(a+)+${BOM}', $s);\n`, { format: 'php' }],
		['php', `preg_match('${NEL}(a+)+${NEL}', $s);\n`, { format: 'php' }],
		['csharp', `var r = Regex.IsMatch(input,${BOM}@"(a+)+");\n`, { format: 'cs' }],
	];
	return written.map(([language, content, args], offset) => ({
		index: from + offset,
		language,
		wrapper: 'written out',
		pattern: '(a+)+',
		hint: JSON.stringify(args),
		content,
		args: { content, ...args },
	}));
}

/**
 * Case folding, which is not length-preserving.
 *
 * `İ` grows a code point when lowercased and `K` (U+212A KELVIN SIGN)
 * shrinks a byte. A sibling crate took offsets from a lowercased copy
 * and applied them to the original, and a slide landing mid-character
 * aborted the process. Nothing here derives an offset from the folded
 * copy — it is only ever a lookup key — and these cases hold that true.
 */
function caseFoldingCases(from: number): Case[] {
	const content = 'P = re.compile(r"(a+)+")\n';
	const names = ['PYTHON', 'Python', 'PY', '.PY', 'İ', '\u{212a}', 'PYTHO\u{212a}', 'py'];
	return names.map((format, offset) => ({
		index: from + offset,
		language: 'python',
		wrapper: 'written out',
		pattern: '(a+)+',
		hint: format,
		content,
		args: { content, format },
	}));
}

/**
 * The quoted forms, pinned rather than sampled: a pattern carrying the
 * other quote character is where a hand-rolled unescaper and a regex
 * replacement most easily part company.
 */
function quotedCases(from: number): Case[] {
	const written: ReadonlyArray<[string, string, string]> = [
		['javascript', String.raw`a"b+`, `const re = new RegExp('a"b+');`],
		['javascript', "a'b+", `const re = new RegExp("a'b+");`],
		['javascript', String.raw`\\d+`, String.raw`const re = new RegExp('\\d+');`],
		['python', String.raw`\\d+`, String.raw`P = re.compile("\\d+")`],
		['rust', 'a"b+', String.raw`let r = Regex::new(r#"a"b+"#);`],
		['csharp', 'a""b+', 'var r = new Regex(@"a""b+");'],
		['go', 'a"b+', 'var re = regexp.MustCompile(`a"b+`)'],
	];
	return written.map(([language, pattern, site], offset) => ({
		index: from + offset,
		language,
		wrapper: 'written out',
		pattern,
		hint: language,
		content: `${site}\n`,
		args: { content: `${site}\n`, format: language },
	}));
}

/** Sort every object key, so a comparison is of the answer, not its order. */
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value === null || typeof value !== 'object') return value;
	const entries = Object.entries(value as Record<string, unknown>).sort(
		([a], [b]) => (a < b ? -1 : 1),
	);
	return Object.fromEntries(entries.map(([key, item]) => [key, canonical(item)]));
}

function show(value: unknown): string {
	return JSON.stringify(canonical(value));
}

/** Ask the crate's server for every case, in one process. */
function askTheCrate(cases: readonly Case[]): Map<number, unknown> {
	if (!existsSync(BINARY)) {
		console.error(
			`The crate's binary is not built: ${BINARY}\n` +
				'Build it with `cargo build --release --locked` in crate/, or point ' +
				'REGEX_LE_BINARY at it.',
		);
		process.exit(1);
	}

	const requests = cases
		.map((testCase) =>
			JSON.stringify({
				jsonrpc: '2.0',
				id: testCase.index,
				method: 'tools/call',
				params: { name: 'extract_patterns', arguments: testCase.args },
			}),
		)
		.join('\n');

	const result = spawnSync(BINARY, ['mcp'], {
		input: `${requests}\n`,
		encoding: 'utf8',
		maxBuffer: 1 << 28,
	});
	if (result.status !== 0) {
		console.error(
			`The crate's MCP server exited ${result.status} (signal ${result.signal}).\n${result.stderr}`,
		);
		process.exit(1);
	}

	const answers = new Map<number, unknown>();
	for (const line of result.stdout.split('\n')) {
		if (line.trim().length === 0) continue;
		const response = JSON.parse(line) as {
			id: number;
			result?: { structuredContent?: unknown };
			error?: unknown;
		};
		if (response.error !== undefined) {
			answers.set(response.id, { protocolError: response.error });
			continue;
		}
		answers.set(response.id, response.result?.structuredContent);
	}
	return answers;
}

async function askTheExtension(testCase: Case): Promise<unknown> {
	const tool = TOOLS.find((candidate) => candidate.name === 'extract_patterns');
	if (!tool) {
		console.error('the extension no longer offers extract_patterns');
		process.exit(1);
	}
	try {
		return await tool.handler({ ...testCase.args });
	} catch (error) {
		return {
			toolError: error instanceof Error ? error.message : String(error),
		};
	}
}

function describe(testCase: Case): string {
	return (
		`case #${testCase.index}  ${testCase.language} · ${testCase.wrapper} · ` +
		`hint ${JSON.stringify(testCase.hint)} · pattern ${JSON.stringify(testCase.pattern)}\n` +
		`  arguments: ${JSON.stringify(testCase.args)}\n` +
		`  document:  ${JSON.stringify(testCase.content)}`
	);
}

const failures: string[] = [];

function fail(message: string): void {
	failures.push(message);
}

const cases = [...generate()];
cases.push(...quotedCases(cases.length));
cases.push(...whitespaceCases(cases.length));
cases.push(...caseFoldingCases(cases.length));

const fromCrate = askTheCrate(cases);
let withPatterns = 0;

for (const testCase of cases) {
	const theirs = fromCrate.get(testCase.index);
	const mine = await askTheExtension(testCase);

	if (show(mine) !== show(theirs)) {
		fail(
			'the shared extract_patterns tool disagrees with itself across the two ' +
				'servers — one tool, one schema, two implementations, so this is a bug ' +
				'in the tool rather than a difference between the surfaces.\n' +
				`${describe(testCase)}\n` +
				`  npm server:   ${show(mine)}\n` +
				`  crate server: ${show(theirs)}`,
		);
		continue;
	}

	const envelopeForCount = mine as {
		data?: { patterns?: readonly unknown[] };
	};
	if ((envelopeForCount.data?.patterns ?? []).length > 0) withPatterns += 1;

	// The standing check: validity is asked of a JavaScript *rendering*
	// while the pattern reported is the source verbatim. A call form
	// carrying a Python or Go spelling must come back reported and
	// judged on its shape, never as a syntax error.
	if (
		!VALID_ELSEWHERE.has(testCase.pattern) ||
		testCase.language === 'javascript' ||
		testCase.language === 'typescript'
	) {
		continue;
	}
	const envelope = mine as {
		data?: { patterns?: ReadonlyArray<{ pattern: string; redos?: { reason: string } }> };
	};
	const found = envelope.data?.patterns ?? [];
	const reported = found.find((item) => item.pattern === testCase.pattern);
	if (reported === undefined) {
		// A commented-out or otherwise unreachable site legitimately
		// finds nothing; only assert when something was found at all.
		if (found.length > 0) {
			fail(
				`a valid ${testCase.language} pattern was replaced by something else in the ` +
					`report.\n${describe(testCase)}\n  reported: ${show(found)}`,
			);
		}
		continue;
	}
	if (reported.redos?.reason === 'Pattern is invalid') {
		fail(
			`a valid ${testCase.language} regex came back as "Pattern is invalid". ` +
				'Validity is asked of a JavaScript rendering for exactly this reason; ' +
				`the rendering has stopped being applied.\n${describe(testCase)}`,
		);
	}
}

console.log(
	`seed ${SEED} · ${cases.length} generated documents · ${withPatterns} found a pattern`,
);

// Two servers agreeing that every document is empty would agree about
// nothing. The floor is deliberately far below what a healthy run
// produces, so it fails when the generator breaks rather than drifting.
const FLOOR = Math.floor(cases.length * 0.5);
if (withPatterns < FLOOR) {
	fail(
		`only ${withPatterns} of ${cases.length} documents produced a pattern, under the ` +
			`floor of ${FLOOR}. The generator is producing documents neither server reads, ` +
			'so the agreement between them proves nothing.',
	);
}

if (failures.length > 0) {
	console.error(`\nExtraction differential FAILED (${failures.length}):\n`);
	for (const failure of failures) {
		console.error(`- ${failure}\n`);
	}
	console.error(
		`Reproduce exactly with DIFFERENTIAL_SEED=${SEED} bun scripts/check-extraction-differential.ts`,
	);
	process.exit(1);
}
console.log(
	'OK: both extract_patterns servers answer every generated document identically.',
);
