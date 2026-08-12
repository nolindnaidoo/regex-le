/**
 * Which language's regex spellings a document can hold.
 *
 * `determineLanguage` takes VS Code language ids and nothing else,
 * because that is what the editor hands the extension. Widening for a
 * caller that holds a filename or a loose alias happens in
 * `src/mcp/fileType.ts`, at the boundary where such callers arrive.
 *
 * **The language is a hint, never a gate.** A document nothing
 * recognises is scanned for every form rather than refused: a caller who
 * cannot name the language should still get answers, and that is also
 * what this extractor did before it knew languages existed.
 */

export type Language =
	| 'javascript'
	| 'typescript'
	| 'python'
	| 'rust'
	| 'go'
	| 'java'
	| 'ruby'
	| 'php'
	| 'csharp';

/** The language ids the extractor has forms for. */
export const SUPPORTED_FORMATS: readonly Language[] = Object.freeze([
	'javascript',
	'typescript',
	'python',
	'rust',
	'go',
	'java',
	'ruby',
	'php',
	'csharp',
] as const);

/**
 * Resolve a VS Code language id, or undefined when there is no set of
 * forms for it — which means "scan for all of them", not "refuse".
 */
export function determineLanguage(
	languageId: string | undefined,
): Language | undefined {
	if (languageId === undefined) {
		return undefined;
	}
	const known = SUPPORTED_FORMATS.find((format) => format === languageId);
	return known;
}

/**
 * Whether a bare `/…/` can be a regex in this grammar.
 *
 * Three languages have the literal; everywhere else a regex is written
 * at a call site. That matters because deciding whether a slash opens a
 * regex or divides is a *guess* — see `isRegexContext` — and a guess
 * made in a language with no regex literal is all cost and no finding:
 * every path in a Python file reads as a pattern.
 */
export function hasSlashLiterals(language: Language): boolean {
	return (
		language === 'javascript' ||
		language === 'typescript' ||
		language === 'ruby'
	);
}
