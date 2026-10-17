import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
	extractRegexPatterns,
	extractRegexPatternsOrRefuse,
	tooComplex,
} from '../extraction/regex/extractPatterns';
import {
	isWithinParserLimits,
	MAX_ALTERNATION_BRANCHES,
	MAX_GROUP_DEPTH,
} from '../extraction/regex/heuristics';
import { TOOLS } from '../mcp/tools';
import { parse } from './args';
import { serve } from './mcp';
import { run } from './run';
import {
	exitCode,
	type FileReport,
	describe as line,
	scanContent,
} from './scan';
import { FLAGS, USAGE } from './usage';

const MEDIUM = { threshold: 'medium', all: false } as const;
const deep = (depth: number) => `${'('.repeat(depth)}a${')'.repeat(depth)}`;

describe('usage', () => {
	it('names every flag the parser accepts, and no other', () => {
		const named = new Set(
			USAGE.split(/\s+/)
				.filter((word) => word.startsWith('--'))
				.map((word) => word.replace(/[,.:;]+$/, ''))
				.filter((word) => word !== '--version' && word !== '--help'),
		);
		expect([...named].sort()).toEqual([...FLAGS].sort());
	});
});

describe('parse', () => {
	it('refuses what the crate refuses, in its words', () => {
		expect(() => parse(['--severity'])).toThrow('--severity needs a level');
		expect(() => parse(['--severity', 'low', 'x'])).toThrow(
			'low is not a threshold: every pattern has a verdict',
		);
		expect(() => parse(['--severity', 'HIGH', 'x'])).toThrow(
			'HIGH is not a severity; one of: high, medium',
		);
		expect(() => parse(['--test', 'x'])).toThrow(
			'--test is not an option. Try --help.',
		);
		expect(() => parse(['--stdin', 'x'])).toThrow('takes no file arguments');
		expect(parse(['constructor']).inputs).toEqual(['constructor']);
	});
});

describe('the parser bounds', () => {
	it('are inclusive, as the crate holds them', () => {
		expect(isWithinParserLimits(deep(MAX_GROUP_DEPTH))).toBe(true);
		expect(isWithinParserLimits(deep(MAX_GROUP_DEPTH + 1))).toBe(false);
		const branches = (count: number) => 'a|'.repeat(count);
		expect(isWithinParserLimits(branches(MAX_ALTERNATION_BRANCHES))).toBe(true);
		expect(isWithinParserLimits(branches(MAX_ALTERNATION_BRANCHES + 1))).toBe(
			false,
		);
	});

	it('count a class as nesting and its brackets as literals', () => {
		expect(isWithinParserLimits(`[(]+${'(]+'.repeat(1_000)}`)).toBe(false);
		expect(isWithinParserLimits('[(]+[)]+'.repeat(2_000))).toBe(true);
		expect(isWithinParserLimits('\\('.repeat(1_000))).toBe(true);
	});

	it('refuse a constructor argument past them and drop a bare literal', () => {
		const call = `new RegExp('${deep(300)}')`;
		expect(() => extractRegexPatternsOrRefuse(call, 'javascript')).toThrow(
			tooComplex('constructor'),
		);
		expect(extractRegexPatterns(call, 'javascript')).toEqual([]);
		expect(
			extractRegexPatternsOrRefuse(`x = /${deep(300)}/;`, 'javascript'),
		).toEqual([]);
	});

	it('make the shared tool answer incomplete rather than clean', async () => {
		const tool = TOOLS.find(
			(candidate) => candidate.name === 'extract_patterns',
		);
		const answer = (await tool?.handler({
			content: `re.compile("${deep(300)}")`,
			format: 'python',
		})) as { ok: boolean; diagnostics: { code: string; message: string }[] };
		expect(answer.ok).toBe(false);
		expect(answer.diagnostics).toEqual([
			{ severity: 'error', code: 'incomplete', message: tooComplex('python') },
		]);
	});
});

describe('scanContent', () => {
	it('writes the crate field order, with the witness', () => {
		const report = scanContent(
			'const r = /(a+)+b/;',
			'a.js',
			'javascript',
			MEDIUM,
		);
		expect(Object.keys(report)).toEqual([
			'file',
			'patterns',
			'diagnostics',
			'summary',
		]);
		const pattern = report.patterns[0];
		expect(Object.keys(pattern ?? {})).toEqual([
			'pattern',
			'flags',
			'line',
			'column',
			'match',
			'redos',
		]);
		expect(pattern?.redos.witness).toBeDefined();
	});

	it('widens the report under --all without changing the finding count', () => {
		const text = 'const a = /(a+)+b/;\nconst b = /^x$/;';
		const counted = scanContent(text, 'a.js', 'javascript', MEDIUM);
		const all = scanContent(text, 'a.js', 'javascript', {
			...MEDIUM,
			all: true,
		});
		expect(counted.summary).toEqual({ patterns: 1, findings: 1 });
		expect(all.summary).toEqual({ patterns: 2, findings: 1 });
	});

	it('describes a witness as Rust quotes it', () => {
		const report = scanContent(
			'const r = /(a+)+b/;',
			'a.js',
			'javascript',
			MEDIUM,
		);
		const pattern = report.patterns[0];
		if (!pattern) throw new Error('no pattern');
		expect(line(report, pattern)).toMatch(/ {2}witness "a+\\0"$/);
	});
});

describe('exitCode', () => {
	const of = (findings: number, code?: string, severity = 'warning') =>
		({
			file: 'x',
			patterns: [],
			diagnostics: code ? [{ severity, code, message: 'm' }] : [],
			summary: { patterns: 0, findings },
		}) as FileReport;

	it('reports the worst outcome', () => {
		expect(exitCode([of(0)], false)).toBe(0);
		expect(exitCode([of(1)], false)).toBe(1);
		expect(exitCode([of(0, 'skipped')], true)).toBe(2);
		expect(exitCode([of(1), of(0, 'incomplete', 'error')], false)).toBe(2);
	});
});

describe('run', () => {
	const io = (input: Uint8Array) => {
		const out: string[] = [];
		const err: string[] = [];
		return {
			out,
			err,
			io: {
				stdout: (text: string) => out.push(text),
				stderr: (text: string) => err.push(text),
				stdoutIsTerminal: false,
				readStdin: async () => input,
				version: '9.9.9',
			},
		};
	};

	it('refuses a constructor it cannot judge with exit 2, naming why', async () => {
		const { err, io: streams } = io(Buffer.from(`new RegExp('${deep(300)}')`));
		expect(await run(['--stdin'], streams)).toBe(2);
		expect(err.join('')).toBe(
			`<stdin>: ${tooComplex('constructor')}\n0 findings in 1 file\n`,
		);
	});

	it('answers --version only as the first argument', async () => {
		const { out, io: streams } = io(Buffer.alloc(0));
		expect(await run(['-V'], streams)).toBe(0);
		expect(out.join('')).toBe('regex-le 9.9.9\n');
	});
});

describe('mcp', () => {
	it('sorts every key, as a serde_json Value does', async () => {
		const written: string[] = [];
		const request = {
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: 'extract_patterns', arguments: { content: '/(a+)+b/' } },
		};
		await serve(
			Readable.from([Buffer.from(`${JSON.stringify(request)}\n`)]),
			(reply) => written.push(reply),
			'9.9.9',
		);
		expect(
			written[0]?.startsWith('{"id":1,"jsonrpc":"2.0","result":{"content":'),
		).toBe(true);
	});
});
