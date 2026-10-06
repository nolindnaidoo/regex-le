import * as vscode from 'vscode';
import { excludeGlobs } from './defaults';
import { createIgnore, type IgnoreFile, parseIgnoreFile } from './ignore';

/**
 * Reading many files from disk, for a command that runs over a folder or the
 * whole workspace.
 *
 * This file is the same in every extension of the family and names none of
 * them: what to do with a file's text is the caller's business. What is here
 * is what must not differ between them — which files are read, in what order,
 * what is skipped and how that is counted.
 */

export interface ScanLimits {
	/** Globs of the files to read, relative to the root. */
	readonly patterns: readonly string[];
	/** Globs of the files to leave out, on top of the built-in ones. */
	readonly excludes: readonly string[];
	/** Leave out the built-in list: dependency folders, build output, caches. */
	readonly useDefaultExcludes: boolean;
	/** Leave out files whose extension says they are not text. */
	readonly skipBinaryFiles: boolean;
	/** Globs of files to read whatever the excludes and `.gitignore` say. */
	readonly alwaysInclude: readonly string[];
	/** The most files one scan reads. */
	readonly maxFiles: number;
	/** A file larger than this is not read. Undefined reads any size. */
	readonly maxFileBytes: number | undefined;
	/** Leave out what the project's `.gitignore` files leave out. */
	readonly respectGitignore: boolean;
}

export interface ScannedFile {
	readonly uri: vscode.Uri;
	/** The path as a report shows it: relative to the folder that was scanned. */
	readonly file: string;
	readonly text: string;
}

/** What a scan did, so a report can say what it did not look at. */
export interface ScanSummary {
	/** Files whose text was handed to the caller. */
	readonly read: number;
	/** Files left unread for being over the size limit. */
	readonly tooLarge: number;
	/** Files left unread for not being UTF-8 text, or not being readable. */
	readonly notText: number;
	/** More files matched than `maxFiles` allows. */
	readonly fileLimitReached: boolean;
	/** Files a `.gitignore` left out. */
	readonly ignored: number;
	/** The caller asked to stop before the last file. */
	readonly stoppedEarly: boolean;
	readonly cancelled: boolean;
}

/**
 * The files a scan would read, in a stable order.
 *
 * `findFiles` promises no order, so two scans of one tree would list files
 * differently. The comparison is plain rather than `localeCompare`: the order
 * must not change with the editor's display language.
 *
 * Nothing is capped until the ignore rules have been applied. Capping first
 * spent the whole limit on build output that was about to be thrown away.
 */
export async function listFiles(
	root: vscode.Uri | undefined,
	limits: ScanLimits,
): Promise<{
	files: vscode.Uri[];
	fileLimitReached: boolean;
	ignored: number;
}> {
	const globs = excludeGlobs({
		userExcludes: limits.excludes,
		useDefaults: limits.useDefaultExcludes,
		skipBinaryFiles: limits.skipBinaryFiles,
	});
	const exclude = globs.length === 0 ? undefined : `{${globs.join(',')}}`;
	let ignoredCount = 0;
	const roots =
		root === undefined
			? (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri)
			: [root];
	const seen = new Set<string>();
	const out: vscode.Uri[] = [];
	for (const base of roots) {
		const ignored = limits.respectGitignore
			? createIgnore(await ignoreFilesFor(base, exclude))
			: undefined;
		for (const pattern of limits.patterns) {
			for (const uri of await vscode.workspace.findFiles(
				new vscode.RelativePattern(base, pattern),
				exclude,
			)) {
				const key = uri.toString();
				if (seen.has(key)) continue;
				seen.add(key);
				if (ignored?.(comparable(uri.path))) {
					ignoredCount++;
					continue;
				}
				out.push(uri);
			}
		}
	}
	// Asked for by name, so read whatever left them out above. A path that
	// was counted as ignored and is wanted is read, and uncounted.
	const wanted = new Set(out.map((uri) => uri.toString()));
	for (const base of roots) {
		for (const pattern of limits.alwaysInclude) {
			for (const uri of await vscode.workspace.findFiles(
				new vscode.RelativePattern(base, pattern),
				null,
			)) {
				const key = uri.toString();
				if (wanted.has(key)) continue;
				wanted.add(key);
				if (seen.has(key)) ignoredCount--;
				out.push(uri);
			}
		}
	}
	out.sort((a, b) => (a.path < b.path ? -1 : Number(a.path > b.path)));
	return {
		files: out.slice(0, limits.maxFiles),
		fileLimitReached: out.length > limits.maxFiles,
		ignored: ignoredCount,
	};
}

/**
 * Every `.gitignore` that says something about the files under `base`: the
 * ones beneath it, and the ones above it up to the top of its repository.
 */
async function ignoreFilesFor(
	base: vscode.Uri,
	exclude: string | undefined,
): Promise<IgnoreFile[]> {
	const found: vscode.Uri[] = await vscode.workspace.findFiles(
		new vscode.RelativePattern(base, '**/.gitignore'),
		exclude,
	);
	// Upwards from the folder. The repository's top is where `.git` is, and
	// rules above that belong to something else.
	let directory = base;
	for (let level = 0; level < MAX_ANCESTORS; level++) {
		if (level > 0) found.push(vscode.Uri.joinPath(directory, '.gitignore'));
		if (await exists(vscode.Uri.joinPath(directory, '.git'))) break;
		const parent = vscode.Uri.joinPath(directory, '..');
		if (parent.path === directory.path) break;
		directory = parent;
	}

	const files: IgnoreFile[] = [];
	for (const uri of found) {
		try {
			const text = decodeText(await vscode.workspace.fs.readFile(uri));
			if (text === undefined) continue;
			files.push(
				parseIgnoreFile(
					comparable(uri.path.slice(0, uri.path.lastIndexOf('/'))),
					text,
				),
			);
		} catch {
			// Most directories on the way up have no .gitignore.
		}
	}
	return files;
}

const MAX_ANCESTORS = 32;

async function exists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

/**
 * A file's text, or undefined when it is not UTF-8 text.
 *
 * Read as bytes and decoded here rather than opened as a document: an editor
 * will open a binary or a UTF-16 file as something, and results read out of a
 * mis-decode are invented.
 */
export function decodeText(bytes: Uint8Array): string | undefined {
	if (bytes.includes(0)) return undefined;
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
}

/**
 * Hand each readable file's text to `each`, in order.
 *
 * `each` returns false to stop the scan, which is how a caller enforces a
 * limit on its own results.
 */
export async function scanFiles(
	root: vscode.Uri | undefined,
	files: readonly vscode.Uri[],
	limits: ScanLimits,
	token: vscode.CancellationToken,
	onProgress: (done: number, total: number) => void,
	each: (file: ScannedFile) => boolean | undefined,
): Promise<Omit<ScanSummary, 'fileLimitReached' | 'ignored'>> {
	let read = 0;
	let tooLarge = 0;
	let notText = 0;
	for (const [index, uri] of files.entries()) {
		if (token.isCancellationRequested) {
			return { read, tooLarge, notText, stoppedEarly: false, cancelled: true };
		}
		if (index % 50 === 0) onProgress(index, files.length);

		let text: string | undefined;
		try {
			if (
				limits.maxFileBytes !== undefined &&
				(await vscode.workspace.fs.stat(uri)).size > limits.maxFileBytes
			) {
				tooLarge++;
				continue;
			}
			text = decodeText(await vscode.workspace.fs.readFile(uri));
		} catch {
			// A file that could not be read was not examined, and is counted
			// with the others nothing could be read from.
			text = undefined;
		}
		if (text === undefined) {
			notText++;
			continue;
		}

		read++;
		const file = labelOf(root, uri);
		if (each({ uri, file, text }) === false) {
			return {
				read,
				tooLarge,
				notText,
				stoppedEarly: index < files.length - 1,
				cancelled: false,
			};
		}
	}
	return { read, tooLarge, notText, stoppedEarly: false, cancelled: false };
}

/** A folder that was picked is the reader's frame of reference, wherever the workspace is. */
function labelOf(root: vscode.Uri | undefined, uri: vscode.Uri): string {
	if (root !== undefined) {
		// A folder can arrive with a slash on the end, and a file's path never
		// has two in a row.
		const base = root.path.replace(/\/+$/, '');
		if (comparable(uri.path).startsWith(`${comparable(base)}/`))
			return uri.path.slice(base.length + 1);
	}
	return vscode.workspace.asRelativePath(uri, false);
}

/**
 * A path with its Windows drive letter in one case.
 *
 * The same folder arrives as `/C:/...` from a path that was picked and as
 * `/c:/...` from the file search, and compared as written they are two
 * places: no file was under the folder it was found in.
 */
function comparable(path: string): string {
	return /^\/[A-Za-z]:/.test(path)
		? `/${(path[1] as string).toLowerCase()}${path.slice(2)}`
		: path;
}

/** The lines a report adds for whatever a scan left unread. Empty when it read everything. */
export function unreadNotes(
	summary: ScanSummary,
	limits: ScanLimits,
	settings: string,
): string[] {
	const notes: string[] = [];
	// What was never looked at, so a filtered scan is not read as a full one.
	const left: string[] = [];
	if (limits.useDefaultExcludes)
		left.push(
			vscode.l10n.t('dependency folders, build output, caches and lockfiles'),
		);
	if (limits.skipBinaryFiles)
		left.push(vscode.l10n.t('images, fonts, archives and other binary files'));
	if (limits.respectGitignore)
		left.push(
			vscode.l10n.t('{0} file(s) ignored by .gitignore', summary.ignored),
		);
	if (left.length > 0)
		notes.push(
			vscode.l10n.t(
				'Not read: {0}. The {1} settings change this.',
				left.join('; '),
				settings,
			),
		);
	if (summary.fileLimitReached) {
		notes.push(
			vscode.l10n.t(
				'More files matched than the limit of {0}. The rest were not read.',
				limits.maxFiles,
			),
		);
	}
	if (summary.stoppedEarly) {
		notes.push(
			vscode.l10n.t(
				'The results limit was reached. The rest of the files were not read.',
			),
		);
	}
	if (summary.tooLarge > 0) {
		notes.push(
			vscode.l10n.t(
				'{0} file(s) larger than the safety limit were not read.',
				summary.tooLarge,
			),
		);
	}
	if (summary.notText > 0) {
		notes.push(
			vscode.l10n.t(
				'{0} file(s) that are not UTF-8 text were not read.',
				summary.notText,
			),
		);
	}
	return notes;
}
