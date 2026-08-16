import { describe, expect, it } from 'vitest';
import type { Language } from './format';
import { isProse, proseSpans } from './mask';

/**
 * The bug these pin: comment state was never tracked across lines, so a
 * JSDoc block explaining a dangerous pattern was extracted and judged —
 * documenting a hazard failed the build that documented it. A block
 * comment that opened and closed on one line only looked handled,
 * because the phantom pattern it produced was invalid and got dropped on
 * the way out.
 */

function masked(text: string, language: Language, needle: string): boolean {
	const offset = text.indexOf(needle);
	expect(offset, `the needle ${needle} is in the text`).toBeGreaterThan(-1);
	return isProse(proseSpans(text, language), offset);
}

describe('comments are prose', () => {
	it('masks a line comment and not the line after it', () => {
		const text = '// const bad = /(a+)+b/;\nconst ok = /[a-z]+/;\n';
		expect(masked(text, 'javascript', '/(a+)+b/')).toBe(true);
		expect(masked(text, 'javascript', '/[a-z]+/')).toBe(false);
	});

	it('masks every line a block comment spans', () => {
		const text =
			'/**\n * Example: /(a+)+b/ is dangerous.\n */\nconst ok = /[a-z]+/;\n';
		expect(masked(text, 'javascript', '/(a+)+b/')).toBe(true);
		expect(masked(text, 'javascript', '/[a-z]+/')).toBe(false);
	});

	it('runs an unterminated block comment to the end of the document', () => {
		const text = '/* opened and never closed\nconst bad = /(a+)+b/;\n';
		expect(masked(text, 'javascript', '/(a+)+b/')).toBe(true);
	});

	it('masks a hash comment in python and ruby', () => {
		expect(
			masked('# re.compile(r"(a+)+b")\nGOOD = 1\n', 'python', 're.compile'),
		).toBe(true);
		expect(masked('# /(a+)+b/\nOK = 1\n', 'ruby', '/(a+)+b/')).toBe(true);
	});

	it('masks a ruby block comment', () => {
		const text = '=begin\n/(a+)+b/\n=end\nok = /[a-z]+/\n';
		expect(masked(text, 'ruby', '/(a+)+b/')).toBe(true);
		expect(masked(text, 'ruby', '/[a-z]+/')).toBe(false);
	});
});

describe('a call is code even though its argument is not', () => {
	// The distinction the whole module turns on. Masking every string
	// would delete the extractor; masking every candidate that *starts*
	// in one keeps a real call and drops prose that quotes it.
	it('leaves a real call unmasked and masks only its argument', () => {
		const text = 'GOOD = re.compile(r"[a-z]+")\n';
		expect(masked(text, 'python', 're.compile')).toBe(false);
		expect(masked(text, 'python', '"[a-z]+"')).toBe(true);
	});

	it('masks the calls inside a python docstring', () => {
		const text =
			'"""\nExample: re.compile(r"(a+)+b")\n"""\nGOOD = re.compile(r"[a-z]+")\n';
		expect(masked(text, 'python', 're.compile(r"(a+)+b")')).toBe(true);
		expect(masked(text, 'python', 're.compile(r"[a-z]+")')).toBe(false);
	});
});

describe('strings close where their grammar says they do', () => {
	it('does not let an escaped quote close a string', () => {
		const text = 'const a = "he said \\" /(a+)+b/ ";\nconst ok = /[a-z]+/;\n';
		expect(masked(text, 'javascript', '/(a+)+b/')).toBe(true);
		expect(masked(text, 'javascript', '/[a-z]+/')).toBe(false);
	});

	it('ends an unterminated quote at the line', () => {
		// A typo, not a reason to hide every real pattern below it.
		const text = 'const a = "oops;\nconst ok = /[a-z]+/;\n';
		expect(masked(text, 'javascript', '/[a-z]+/')).toBe(false);
	});

	it('closes a rust raw string on its own hashes', () => {
		const text =
			'let a = r#"say "hi" here"#;\nlet b = Regex::new(r"[a-z]+");\n';
		expect(masked(text, 'rust', '"hi"')).toBe(true);
		expect(masked(text, 'rust', 'Regex::new')).toBe(false);
	});

	it('lets a go backtick string span lines', () => {
		const text = 'var a = `line one\nregexp.MustCompile(`\nvar b = 1\n';
		expect(masked(text, 'go', 'regexp.MustCompile')).toBe(true);
	});

	it('reads a c# verbatim string as one span', () => {
		const text = 'var a = @"C:\\path\\";\nvar r = new Regex(@"[a-z]+");\n';
		expect(masked(text, 'csharp', 'new Regex')).toBe(false);
	});
});

describe('the spans themselves', () => {
	it('masks nothing when the language is unknown', () => {
		// A comment rule guessed from the wrong grammar would drop real
		// patterns rather than phantom ones.
		expect(proseSpans('// const bad = /(a+)+b/;\n', undefined)).toEqual([]);
	});

	it('stays sorted and non-overlapping, which the binary search assumes', () => {
		const text = '// one\nconst a = "two";\n/* three */\nconst b = \'four\';\n';
		const spans = proseSpans(text, 'javascript');
		expect(spans.length).toBeGreaterThanOrEqual(4);
		for (let i = 1; i < spans.length; i++) {
			expect((spans[i - 1] ?? [0, 0])[1]).toBeLessThanOrEqual(
				(spans[i] ?? [0, 0])[0],
			);
		}
	});

	it('does not leak a pattern out of a url in a comment', () => {
		const text = '// see https://example.com/docs/x\nconst ok = /[a-z]+/;\n';
		expect(masked(text, 'javascript', 'https://')).toBe(true);
		expect(masked(text, 'javascript', '/[a-z]+/')).toBe(false);
	});
});
