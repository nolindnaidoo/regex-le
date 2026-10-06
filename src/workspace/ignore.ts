/**
 * `.gitignore` rules, read the way git reads them.
 *
 * The editor's file search does not apply them, so a folder scan that trusted
 * it read build output and caches before it read source. This file is the
 * same in every extension of the family and names none of them.
 *
 * What is implemented is the documented pattern format: comments and blank
 * lines, `!` to re-include, a trailing `/` for directories only, a leading or
 * inner `/` to anchor to the file's own directory, `*`, `?`, `[...]` and
 * `**`. A file under an ignored directory stays ignored whatever a later rule
 * says, as in git. Not read: the global excludes file and `.git/info/exclude`,
 * which describe one machine rather than the project.
 */

interface Rule {
	readonly matches: RegExp;
	readonly negated: boolean;
	readonly directoryOnly: boolean;
}

/** The rules of one `.gitignore`, and the directory they are relative to. */
export interface IgnoreFile {
	/** Absolute path of the directory holding the file, without a trailing slash. */
	readonly base: string;
	readonly rules: readonly Rule[];
}

export function parseIgnoreFile(base: string, content: string): IgnoreFile {
	const rules: Rule[] = [];
	for (const raw of content.split(/\r?\n/)) {
		const rule = parseLine(raw);
		if (rule !== undefined) rules.push(rule);
	}
	return { base: base.replace(/\/+$/, ''), rules };
}

function parseLine(raw: string): Rule | undefined {
	// Trailing spaces are dropped unless escaped; a leading `#` is a comment
	// unless escaped.
	let line = raw.replace(/(?<!\\)\s+$/, '');
	if (line === '' || line.startsWith('#')) return undefined;
	const negated = line.startsWith('!');
	if (negated) line = line.slice(1);
	if (line.startsWith('\\#') || line.startsWith('\\!')) line = line.slice(1);
	const directoryOnly = line.endsWith('/');
	if (directoryOnly) line = line.slice(0, -1);
	if (line === '') return undefined;
	// A slash at the start or in the middle ties the pattern to this
	// directory. Without one it matches at any depth beneath it.
	const anchored = line.includes('/');
	if (line.startsWith('/')) line = line.slice(1);
	const body = toRegExp(line);
	if (body === undefined) return undefined;
	return {
		matches: new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`),
		negated,
		directoryOnly,
	};
}

/** The pattern as a regular expression source, or undefined when it cannot be read. */
function toRegExp(pattern: string): string | undefined {
	let out = '';
	let at = 0;
	while (at < pattern.length) {
		const char = pattern[at] as string;
		if (char === '*' && pattern[at + 1] === '*') {
			const startsSegment = at === 0 || pattern[at - 1] === '/';
			if (startsSegment && pattern[at + 2] === '/') {
				out += '(?:.*/)?';
				at += 3;
			} else {
				out += '.*';
				at += 2;
			}
		} else if (char === '*') {
			out += '[^/]*';
			at += 1;
		} else if (char === '?') {
			out += '[^/]';
			at += 1;
		} else if (char === '[') {
			const close = pattern.indexOf(']', at + 2);
			if (close === -1) {
				out += '\\[';
				at += 1;
			} else {
				const inside = pattern.slice(at + 1, close).replace(/\\/g, '\\\\');
				out += `[${inside.startsWith('!') ? `^${inside.slice(1)}` : inside}]`;
				at = close + 1;
			}
		} else if (char === '\\' && at + 1 < pattern.length) {
			out += escapeRegExp(pattern[at + 1] as string);
			at += 2;
		} else {
			out += escapeRegExp(char);
			at += 1;
		}
	}
	try {
		new RegExp(out);
		return out;
	} catch {
		return undefined;
	}
}

function escapeRegExp(char: string): string {
	return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether git would ignore this file, given every `.gitignore` that applies.
 *
 * Each directory on the way down is asked first: once one is ignored the file
 * is, and nothing beneath can bring it back. Within one question the last
 * matching rule wins, and a deeper file's rules come after a shallower one's.
 */
export function createIgnore(
	files: readonly IgnoreFile[],
): (absolutePath: string) => boolean {
	const ordered = [...files].sort((a, b) => a.base.length - b.base.length);
	const directories = new Map<string, boolean>();

	const decide = (path: string, isDirectory: boolean): boolean => {
		let ignored = false;
		for (const file of ordered) {
			if (!path.startsWith(`${file.base}/`)) continue;
			const relative = path.slice(file.base.length + 1);
			for (const rule of file.rules) {
				if (rule.directoryOnly && !isDirectory) continue;
				if (rule.matches.test(relative)) ignored = !rule.negated;
			}
		}
		return ignored;
	};

	const directoryIgnored = (path: string): boolean => {
		const known = directories.get(path);
		if (known !== undefined) return known;
		const slash = path.lastIndexOf('/');
		const result =
			(slash > 0 && directoryIgnored(path.slice(0, slash))) ||
			decide(path, true);
		directories.set(path, result);
		return result;
	};

	return (absolutePath) => {
		const slash = absolutePath.lastIndexOf('/');
		if (slash > 0 && directoryIgnored(absolutePath.slice(0, slash)))
			return true;
		return decide(absolutePath, false);
	};
}
