/**
 * An operating-system error as Rust's `io::Error` prints it.
 *
 * The Rust CLI names a failed read as `Permission denied (os error 13)`, and
 * those words reach stderr and the JSON report's `skipped` diagnostic. Node
 * prints libuv's text instead (`EACCES: permission denied, open 'x'`), so the
 * two `regex-le` binaries would disagree about the same file. strerror's
 * wording is spelled out for the errors a walk meets; anything else keeps
 * libuv's text, capitalised, which is the closest available without a guess.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const STRERROR: Readonly<Record<string, string>> = Object.freeze({
	ENOENT: 'No such file or directory',
	EACCES: 'Permission denied',
	EPERM: 'Operation not permitted',
	ENOTDIR: 'Not a directory',
	EISDIR: 'Is a directory',
	ELOOP: 'Too many levels of symbolic links',
	ENAMETOOLONG: 'File name too long',
	EBUSY: 'Resource busy',
	EIO: 'Input/output error',
	EPIPE: 'Broken pipe',
});

const INVALID_UTF8 = 'INVALID_UTF8';

/** `std::fs::read_to_string`: the whole file, or a refusal if it is not UTF-8. */
export function readUtf8File(path: string): string {
	return decodeUtf8OrThrow(readFileSync(path));
}

export function decodeUtf8OrThrow(bytes: Uint8Array): string {
	try {
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
			bytes,
		);
	} catch {
		throw Object.assign(new Error('stream did not contain valid UTF-8'), {
			code: INVALID_UTF8,
		});
	}
}

/**
 * Drop a leading byte-order mark. Notepad, Excel and a PowerShell redirect add
 * one, and VS Code strips it before the extension sees a document, so a file
 * read without this reads differently from the same file open in the editor.
 */
export function withoutBom(content: string): string {
	return content.startsWith('\uFEFF') ? content.slice(1) : content;
}

export function rustIoMessage(
	error: unknown,
	platform: NodeJS.Platform = process.platform,
): string {
	const code = codeOf(error);
	// Rust's own wording, which carries no OS error number.
	if (code === INVALID_UTF8) return 'stream did not contain valid UTF-8';
	if (platform === 'win32') {
		const windows = code ? windowsMessage(code, error) : undefined;
		if (windows) return windows;
	}
	const errno = errnoOf(error);
	const text =
		(platform === 'linux' && code && GLIBC[code]) ||
		(code && STRERROR[code]) ||
		libuvText(error);
	if (errno === undefined) return text;
	return `${text} (os error ${errno})`;
}

/** Where glibc's strerror words an error differently from the BSDs'. */
const GLIBC: Readonly<Record<string, string>> = Object.freeze({
	EBUSY: 'Device or resource busy',
});

/**
 * Windows reports its own error code and FormatMessage's sentence, and Rust
 * prints both. libuv has already folded the code into a POSIX name and a
 * negative number of its own (ENOENT is -4058), so the Windows code is
 * recovered from the name: these are the codes libuv folds into each.
 */
const WINDOWS: Readonly<Record<string, readonly [number, string]>> =
	Object.freeze({
		EPERM: [5, 'Access is denied.'],
		EACCES: [5, 'Access is denied.'],
		EISDIR: [5, 'Access is denied.'],
		EBUSY: [
			32,
			'The process cannot access the file because it is being used by another process.',
		],
		ENAMETOOLONG: [206, 'The filename or extension is too long.'],
		ELOOP: [1921, 'The name of the file cannot be resolved by the system.'],
		// A write to a pipe whose reader has closed it: ERROR_NO_DATA.
		EPIPE: [232, 'The pipe is being closed.'],
	});

function windowsMessage(code: string, error: unknown): string | undefined {
	// ERROR_FILE_NOT_FOUND and ERROR_PATH_NOT_FOUND both arrive as ENOENT.
	// Windows says the first when the directory holding the name exists.
	if (code === 'ENOENT') {
		return parentIsDirectory(pathOf(error))
			? 'The system cannot find the file specified. (os error 2)'
			: 'The system cannot find the path specified. (os error 3)';
	}
	const known = WINDOWS[code];
	if (!known) return undefined;
	return `${known[1]} (os error ${known[0]})`;
}

function pathOf(error: unknown): string | undefined {
	const path = (error as { path?: unknown } | null)?.path;
	return typeof path === 'string' ? path : undefined;
}

function parentIsDirectory(path: string | undefined): boolean {
	if (path === undefined) return true;
	try {
		return statSync(dirname(resolve(path))).isDirectory();
	} catch {
		return false;
	}
}

function codeOf(error: unknown): string | undefined {
	if (typeof error !== 'object' || error === null) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === 'string' ? code : undefined;
}

function errnoOf(error: unknown): number | undefined {
	if (typeof error !== 'object' || error === null) return undefined;
	const errno = (error as { errno?: unknown }).errno;
	return typeof errno === 'number' ? Math.abs(errno) : undefined;
}

function libuvText(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const described = message.replace(/^[A-Z]+: /, '').replace(/, \w+ '.*'$/, '');
	return described.charAt(0).toUpperCase() + described.slice(1);
}
