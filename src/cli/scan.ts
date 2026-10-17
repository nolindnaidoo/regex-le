/**
 * One file end to end, as the Rust CLI's `scan.rs` does it: extract every
 * pattern, give each its ReDoS verdict, and keep the ones at or past the
 * threshold. No pattern is ever run.
 */
import { readFileSync } from 'node:fs';
import { sep } from 'node:path';
import { extractRegexPatternsOrRefuse } from '../extraction/regex/extractPatterns';
import { detectReDoS } from '../extraction/regex/redos';
import { resolveFormat } from '../mcp/fileType';
import type { ScanOptions } from './args';
import { rustDebug } from './debug';
import { decodeUtf8OrThrow, rustIoMessage, withoutBom } from './ioError';

export interface Pattern {
	readonly pattern: string;
	readonly flags: string;
	readonly line: number;
	readonly column: number;
	readonly match: string;
	readonly redos: {
		readonly detected: boolean;
		readonly severity: 'low' | 'medium' | 'high';
		readonly reason: string;
		readonly witness?: string;
	};
}

export interface Diagnostic {
	readonly severity: string;
	readonly code: string;
	readonly message: string;
}

export interface FileReport {
	readonly file: string;
	readonly patterns: readonly Pattern[];
	readonly diagnostics: readonly Diagnostic[];
	readonly summary: { readonly patterns: number; readonly findings: number };
}

/** A file's report, or null when it is not text at all: counted, not reported. */
export function scanFile(
	path: string,
	options: ScanOptions,
): FileReport | null {
	const file = reportedPath(path);
	const language = resolveFormat(undefined, file);
	let bytes: Buffer;
	try {
		bytes = readFileSync(path);
	} catch (error) {
		return skipped(file, rustIoMessage(error));
	}
	if (bytes.subarray(0, 8192).includes(0)) return null;
	let content: string;
	try {
		content = decodeUtf8OrThrow(bytes);
	} catch {
		return skipped(file, 'not UTF-8 text');
	}
	return scanContent(withoutBom(content), file, language, options);
}

function skipped(file: string, message: string): FileReport {
	return report(file, [], [{ severity: 'warning', code: 'skipped', message }], {
		threshold: 'medium',
		all: true,
	});
}

export function scanContent(
	content: string,
	file: string,
	language: string | undefined,
	options: ScanOptions,
): FileReport {
	let found: ReturnType<typeof extractRegexPatternsOrRefuse>;
	try {
		found = extractRegexPatternsOrRefuse(content, language);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return report(
			file,
			[],
			[{ severity: 'error', code: 'incomplete', message }],
			options,
		);
	}
	const patterns = found.map((item) => {
		const verdict = detectReDoS(item.pattern, item.flags);
		return Object.freeze({
			pattern: item.pattern,
			flags: item.flags,
			line: item.line,
			column: item.column,
			match: item.match,
			redos: Object.freeze({
				detected: verdict.detected,
				severity: verdict.severity,
				reason: verdict.reason,
				...(verdict.witness === undefined ? {} : { witness: verdict.witness }),
			}),
		});
	});
	return report(file, patterns, [], options);
}

function report(
	file: string,
	patterns: readonly Pattern[],
	diagnostics: readonly Diagnostic[],
	options: ScanOptions,
): FileReport {
	const counted = patterns.filter((each) =>
		atOrAbove(each.redos.severity, options.threshold),
	);
	const reported = options.all ? patterns : counted;
	return Object.freeze({
		file,
		patterns: Object.freeze(reported),
		diagnostics: Object.freeze(diagnostics),
		summary: Object.freeze({
			patterns: reported.length,
			findings: counted.length,
		}),
	});
}

function atOrAbove(
	severity: string,
	threshold: ScanOptions['threshold'],
): boolean {
	return threshold === 'high' ? severity === 'high' : severity !== 'low';
}

/** `/` on Windows, as the crate spells a path in its report. */
export function reportedPath(path: string): string {
	return sep === '/' ? path : path.split(sep).join('/');
}

/** 0 nothing vulnerable, 1 a finding, 2 could not answer. */
export function exitCode(
	reports: readonly FileReport[],
	strict: boolean,
): number {
	const any = (test: (diagnostic: Diagnostic) => boolean) =>
		reports.some((each) => each.diagnostics.some(test));
	if (any((diagnostic) => diagnostic.severity === 'error')) return 2;
	if (strict && any((diagnostic) => diagnostic.code === 'skipped')) return 2;
	return reports.some((each) => each.summary.findings > 0) ? 1 : 0;
}

/** The one-line projection of a pattern, with its witness when it has one. */
export function describe(file: FileReport, pattern: Pattern): string {
	const witness =
		pattern.redos.witness === undefined
			? ''
			: `  witness ${rustDebug(pattern.redos.witness)}`;
	return `${file.file}:${pattern.line}:${pattern.column}  /${pattern.pattern}/${pattern.flags}  [${pattern.redos.severity}] ${pattern.redos.reason}${witness}`;
}
