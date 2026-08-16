import { describe, expect, it } from 'vitest';
import { extractRegexPatterns } from './extractPatterns';
import { detectReDoS } from './redos';

const patterns = (text: string, languageId?: string): readonly string[] =>
	extractRegexPatterns(text, languageId).map((found) => found.pattern);

describe('per-language regex literals', () => {
	// The seven regressions this whole language pass exists for: a
	// textbook catastrophic-backtracking pattern in each grammar, found
	// and flagged high. The trailing `b` is what makes it one — `(a+)+`
	// alone succeeds on any input holding an `a` and never backtracks.
	const NESTED: ReadonlyArray<readonly [string, string]> = [
		['python', 'BAD = re.compile(r"(a+)+b")'],
		['rust', 'let bad = Regex::new(r"(a+)+b");'],
		['go', 'var bad = regexp.MustCompile(`(a+)+b`)'],
		['java', 'Pattern.compile("(a+)+b");'],
		['ruby', 'BAD = /(a+)+b/'],
		['php', "preg_match('/(a+)+b/', $s);"],
		['csharp', 'var bad = new Regex(@"(a+)+b");'],
	];

	for (const [languageId, text] of NESTED) {
		it(`finds and flags (a+)+b in ${languageId}`, () => {
			const found = extractRegexPatterns(text, languageId);
			expect(found).toHaveLength(1);
			expect(found[0]?.pattern).toBe('(a+)+b');

			const verdict = detectReDoS('(a+)+b', '');
			expect(verdict.severity).toBe('high');
			// A finding that cannot be checked is an opinion.
			expect(verdict.witness).toBeTruthy();
		});
	}

	it('reads a raw string verbatim and unescapes a quoted one', () => {
		expect(patterns('re.compile(r"\\d+")', 'python')).toEqual(['\\d+']);
		expect(patterns('re.compile("\\\\d+")', 'python')).toEqual(['\\d+']);
		expect(patterns('regexp.Compile("\\\\d+")', 'go')).toEqual(['\\d+']);
	});

	// Rust's raw strings take any number of hashes, so the closing
	// delimiter has to match the opening one rather than the first quote
	// it meets.
	it('closes a rust raw string on its own hashes', () => {
		expect(patterns('Regex::new(r#"a"b+"#)', 'rust')).toEqual(['a"b+']);
		expect(patterns('Regex::new(r##"a"#b+"##)', 'rust')).toEqual(['a"#b+']);
	});

	// PHP writes the delimiters and the modifiers inside the string, and
	// the modifiers are dropped rather than reported as flags a
	// JavaScript engine would refuse.
	it('strips php delimiters and drops its modifiers', () => {
		const found = extractRegexPatterns(
			"preg_replace('#(a+)+#ix', '', $s);",
			'php',
		);
		expect(found[0]?.pattern).toBe('(a+)+');
		expect(found[0]?.flags).toBe('');
		expect(patterns("preg_match('{^[a-z]+$}', $s);", 'php')).toEqual([
			'^[a-z]+$',
		]);
	});

	// The static methods take the subject first, so reading argument one
	// as the pattern would report a variable name.
	it('reads the c# pattern argument, not the subject', () => {
		expect(patterns('Regex.IsMatch(input, @"(a+)+")', 'csharp')).toEqual([
			'(a+)+',
		]);
		expect(patterns('Regex.Replace("abc", "\\\\s+", "")', 'csharp')).toEqual([
			'\\s+',
		]);
	});
});

describe('the language selects the forms', () => {
	// Only the three grammars with a bare literal are asked the
	// slash-versus-division question at all, so a Python path stops
	// reading as a pattern.
	it('does not read a python path as a pattern', () => {
		const text = '#!/usr/bin/env python\nROOT = "/var/log/app.log"\n';
		expect(patterns(text, 'python')).toEqual([]);
		expect(patterns(text).length).toBeGreaterThan(0);
	});

	it('scans only the named language forms', () => {
		expect(patterns("new RegExp('a+b', 'g')", 'python')).toEqual([]);
		expect(patterns('re.compile(r"(a+)+")', 'go')).toEqual([]);
	});

	// An unrecognised language is not a refusal: it means every form.
	it('scans every form when the language is unknown or absent', () => {
		expect(patterns('re.compile(r"(a+)+")', 'kotlin')).toEqual(['(a+)+']);
		expect(patterns('re.compile(r"(a+)+")')).toEqual(['(a+)+']);
	});

	it('keeps division out of ruby too', () => {
		expect(patterns('ratio = a / b / 2', 'ruby')).toEqual([]);
		expect(patterns("BUILT = Regexp.new('(a|ab)+')", 'ruby')).toEqual([
			'(a|ab)+',
		]);
	});
});

describe('patterns javascript cannot parse', () => {
	// Ordinary Python: reported as written and judged on its shape,
	// rather than dismissed as a syntax error.
	it('reports a python named group and still flags its shape', () => {
		const found = extractRegexPatterns(
			're.compile(r"(?P<w>\\w+)+@")',
			'python',
		);
		expect(found).toHaveLength(1);
		expect(found[0]?.pattern).toBe('(?P<w>\\w+)+@');
		expect(detectReDoS(found[0]?.pattern ?? '', '').severity).toBe('high');
	});

	it('still drops a real syntax error', () => {
		expect(patterns('re.compile(r"a{2,1}")', 'python')).toEqual([]);
		expect(patterns('re.compile(r"")', 'python')).toEqual([]);
	});
});
