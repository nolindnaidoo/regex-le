import { describe, expect, it } from 'vitest';
import { SUPPORTED_FORMATS } from '../extraction/regex/format';
import { ALIASES, resolveFormat } from './fileType';

describe('resolveFormat', () => {
	it('takes an explicit format first, however it is spelled', () => {
		expect(resolveFormat('py', undefined)).toBe('python');
		expect(resolveFormat('.RS', undefined)).toBe('rust');
		expect(resolveFormat(' go ', undefined)).toBe('go');
		expect(resolveFormat('c#', undefined)).toBe('csharp');
	});

	it('falls back to the filename extension', () => {
		expect(resolveFormat(undefined, 'app/main.py')).toBe('python');
		expect(resolveFormat(undefined, 'Program.cs')).toBe('csharp');
		expect(resolveFormat('kotlin', 'a/b/lib.rs')).toBe('rust');
	});

	// Nothing recognised is an answer, not a refusal — the caller scans
	// for every form, which is what this did before it knew languages
	// existed.
	it('returns undefined when nothing recognises the name', () => {
		expect(resolveFormat('kotlin', undefined)).toBeUndefined();
		expect(resolveFormat(undefined, 'notes.md')).toBeUndefined();
		expect(resolveFormat(undefined, 'Makefile')).toBeUndefined();
		expect(resolveFormat(undefined, undefined)).toBeUndefined();
	});

	it('lands every alias on a language the extractor knows', () => {
		for (const [from, to] of Object.entries(ALIASES)) {
			expect(resolveFormat(to, undefined), from).toBeDefined();
		}
	});

	// Every format the schema advertises must resolve, or the tool names
	// something it does not read.
	it('resolves every advertised format', () => {
		for (const format of SUPPORTED_FORMATS) {
			expect(resolveFormat(format, undefined)).toBe(format);
		}
	});
});
