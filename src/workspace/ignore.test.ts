import { describe, expect, it } from 'vitest';
import { createIgnore, parseIgnoreFile } from './ignore';

function ignoring(content: string, base = '/repo') {
	return createIgnore([parseIgnoreFile(base, content)]);
}

describe('a .gitignore', () => {
	it('skips comments and blank lines, and matches a bare name at any depth', () => {
		const ignored = ignoring('# build\n\nnode_modules\n*.log\n');
		expect(ignored('/repo/node_modules/a/index.js')).toBe(true);
		expect(ignored('/repo/packages/x/node_modules/b.js')).toBe(true);
		expect(ignored('/repo/logs/today.log')).toBe(true);
		expect(ignored('/repo/src/index.ts')).toBe(false);
	});

	it('anchors a pattern with a leading or an inner slash to its own directory', () => {
		const ignored = ignoring('/dist\ndocs/build\n');
		expect(ignored('/repo/dist/a.js')).toBe(true);
		expect(ignored('/repo/packages/dist/a.js')).toBe(false);
		expect(ignored('/repo/docs/build/x.html')).toBe(true);
		expect(ignored('/repo/other/docs/build/x.html')).toBe(false);
	});

	it('applies a trailing slash to directories only', () => {
		const ignored = ignoring('cache/\n');
		expect(ignored('/repo/cache/x')).toBe(true);
		expect(ignored('/repo/src/cache')).toBe(false);
	});

	it('re-includes with !, but never beneath an ignored directory', () => {
		const ignored = ignoring('*.env\n!example.env\nbuild/\n!build/keep.txt\n');
		expect(ignored('/repo/prod.env')).toBe(true);
		expect(ignored('/repo/example.env')).toBe(false);
		expect(ignored('/repo/build/keep.txt')).toBe(true);
	});

	it('reads *, ?, [..] and ** as git does', () => {
		const ignored = ignoring('a/**/z\nfile?.txt\n[abc].md\n**/tmp\nlogs/**\n');
		expect(ignored('/repo/a/z')).toBe(true);
		expect(ignored('/repo/a/b/c/z')).toBe(true);
		expect(ignored('/repo/file1.txt')).toBe(true);
		expect(ignored('/repo/file10.txt')).toBe(false);
		expect(ignored('/repo/a.md')).toBe(true);
		expect(ignored('/repo/d.md')).toBe(false);
		expect(ignored('/repo/x/y/tmp/f')).toBe(true);
		expect(ignored('/repo/logs/deep/er.txt')).toBe(true);
		// `*` does not cross a slash.
		expect(ignoring('/src/*.js')('/repo/src/lib/a.js')).toBe(false);
	});

	it('treats an escaped # or ! as the character, and a dot as a dot', () => {
		const ignored = ignoring('\\#notes\n\\!important\n.next\n');
		expect(ignored('/repo/#notes')).toBe(true);
		expect(ignored('/repo/!important')).toBe(true);
		expect(ignored('/repo/.next/cache/x')).toBe(true);
		expect(ignored('/repo/xnext/cache/x')).toBe(false);
	});

	it('lets a deeper file override a shallower one, within its own directory', () => {
		const ignored = createIgnore([
			parseIgnoreFile('/repo', '*.json\n'),
			parseIgnoreFile('/repo/fixtures', '!*.json\n'),
		]);
		expect(ignored('/repo/a.json')).toBe(true);
		expect(ignored('/repo/fixtures/a.json')).toBe(false);
	});

	it('leaves alone what is outside its directory', () => {
		expect(ignoring('*', '/repo/sub')('/repo/other/a')).toBe(false);
	});
});
