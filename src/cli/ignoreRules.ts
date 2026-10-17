/**
 * The ignore rules ripgrep's `ignore` crate applies, which the Rust CLI walks
 * with: `.ignore` and `.gitignore` per directory, `.git/info/exclude`, and the
 * global excludes file.
 *
 * Precedence is the crate's, not git's. Every `.ignore` in the chain is asked
 * before any `.gitignore`, deepest directory first, and the first one with an
 * opinion decides; then the repository's exclude file; then the global one.
 * A `.gitignore`, the exclude file and the global file only count inside a git
 * repository, while `.ignore` counts anywhere.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import ignore, { type Ignore } from 'ignore';

export interface DirectoryRules {
	readonly dir: string;
	readonly dotIgnore: Ignore | null;
	readonly gitIgnore: Ignore | null;
}

export interface RepositoryRules {
	readonly root: string;
	readonly exclude: Ignore | null;
	readonly global: Ignore | null;
}

type Verdict = 'ignored' | 'kept' | 'silent';

export function rulesFor(dir: string, inRepository: boolean): DirectoryRules {
	return Object.freeze({
		dir,
		dotIgnore: load(join(dir, '.ignore')),
		gitIgnore: inRepository ? load(join(dir, '.gitignore')) : null,
	});
}

/** The nearest directory at or above `dir` holding a `.git`, if any. */
export function repositoryRoot(dir: string): string | null {
	if (existsSync(join(dir, '.git'))) return dir;
	const parent = dirname(dir);
	if (parent === dir) return null;
	return repositoryRoot(parent);
}

export function repositoryRules(root: string): RepositoryRules {
	return Object.freeze({
		root,
		exclude: load(join(root, '.git', 'info', 'exclude')),
		global: globalExcludes(),
	});
}

/**
 * Whether `path` is ignored, given the rule files from the walk root's
 * ancestors down to the directory holding it, shallowest first.
 */
export function isIgnored(
	path: string,
	isDir: boolean,
	chain: readonly DirectoryRules[],
	repository: RepositoryRules | null,
): boolean {
	const deepestFirst = [...chain].reverse();
	const verdicts: Verdict[] = [
		firstOpinion(
			deepestFirst.map((rules) => [rules.dir, rules.dotIgnore] as const),
			path,
			isDir,
		),
		firstOpinion(
			deepestFirst.map((rules) => [rules.dir, rules.gitIgnore] as const),
			path,
			isDir,
		),
	];
	if (repository) {
		verdicts.push(verdict(repository.exclude, repository.root, path, isDir));
		verdicts.push(verdict(repository.global, repository.root, path, isDir));
	}
	return verdicts.find((found) => found !== 'silent') === 'ignored';
}

function firstOpinion(
	sources: readonly (readonly [string, Ignore | null])[],
	path: string,
	isDir: boolean,
): Verdict {
	for (const [dir, rules] of sources) {
		const found = verdict(rules, dir, path, isDir);
		if (found !== 'silent') return found;
	}
	return 'silent';
}

function verdict(
	rules: Ignore | null,
	base: string,
	path: string,
	isDir: boolean,
): Verdict {
	if (!rules) return 'silent';
	const relativePath = relative(base, path);
	if (!relativePath || relativePath.startsWith('..')) return 'silent';
	const posix = relativePath.split(sep).join('/');
	const result = rules.test(isDir ? `${posix}/` : posix);
	if (result.ignored) return 'ignored';
	if (result.unignored) return 'kept';
	return 'silent';
}

function load(file: string): Ignore | null {
	const text = readText(file);
	if (text === null) return null;
	return ignore({ allowRelativePaths: true }).add(text);
}

/**
 * An ignore file that cannot be read is no rules at all, which is what the
 * crate does with one: a walk does not fail because a `.gitignore` is
 * unreadable, and the files it would have excluded are read instead.
 */
function readText(file: string): string | null {
	try {
		if (!statSync(file).isFile()) return null;
		return readFileSync(file, 'utf8');
	} catch {
		return null;
	}
}

/**
 * `core.excludesFile` from the user's git configuration, else git's default
 * location. Parsed rather than asked of `git`, as the crate does, so the walk
 * works where git is not installed.
 */
function globalExcludes(): Ignore | null {
	const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
	const configured = [
		join(homedir(), '.gitconfig'),
		join(configHome, 'git', 'config'),
	]
		.map(excludesFileIn)
		.find((found): found is string => Boolean(found));
	return load(configured ?? join(configHome, 'git', 'ignore'));
}

function excludesFileIn(configFile: string): string | null {
	const text = readText(configFile);
	if (text === null) return null;
	let inCore = false;
	let found: string | null = null;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		const section = /^\[\s*([^\]\s"]+)[^\]]*\]/.exec(line);
		if (section) inCore = (section[1] ?? '').toLowerCase() === 'core';
		const entry = inCore ? /^excludesfile\s*=\s*(.+)$/i.exec(line) : null;
		if (entry) found = expandHome(unquote((entry[1] ?? '').trim()));
	}
	return found;
}

function unquote(value: string): string {
	return value.replace(/^"(.*)"$/, '$1');
}

function expandHome(value: string): string {
	if (!value.startsWith('~/')) return value;
	return join(homedir(), value.slice(2));
}
