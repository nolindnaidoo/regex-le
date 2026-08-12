/**
 * Resolving a language hint from whatever an agent happens to send.
 *
 * The extractor's own `determineLanguage` accepts VS Code language ids and
 * nothing else, because that is what the editor hands the extension. An agent
 * will send `py`, `.py`, `Python`, or `validate.py` instead. Widening happens
 * here rather than in the extractor, whose behaviour is pinned by the shared
 * corpus.
 */
import type { Language } from '../extraction/regex/format';
import { determineLanguage } from '../extraction/regex/format';

/**
 * Every language id the extractor understands, keyed by what a caller might
 * send.
 *
 * Exported because `crate/fixtures/aliases.json` holds it equal to the Rust
 * crate's table: both MCP servers offer the same `extract_patterns`, so a name
 * one side reads and the other ignores makes them two different tools rather
 * than one. `scripts/check-extraction-parity.ts` checks this side of that.
 */
export const ALIASES: Readonly<Record<string, string>> = Object.freeze({
	javascript: 'javascript',
	javascriptreact: 'javascript',
	js: 'javascript',
	jsx: 'javascript',
	mjs: 'javascript',
	cjs: 'javascript',
	typescript: 'typescript',
	typescriptreact: 'typescript',
	ts: 'typescript',
	tsx: 'typescript',
	mts: 'typescript',
	cts: 'typescript',
	python: 'python',
	py: 'python',
	pyi: 'python',
	pyw: 'python',
	rust: 'rust',
	rs: 'rust',
	go: 'go',
	golang: 'go',
	java: 'java',
	ruby: 'ruby',
	rb: 'ruby',
	rake: 'ruby',
	gemspec: 'ruby',
	php: 'php',
	phtml: 'php',
	csharp: 'csharp',
	cs: 'csharp',
	csx: 'csharp',
	// `c#` is what a model writes when asked to name the language, and it is
	// not a filename extension anything would resolve.
	'c#': 'csharp',
	cake: 'csharp',
});

function normalise(raw: string): string {
	// Tolerate ".PY", " py ", and a bare extension.
	return raw.trim().toLowerCase().replace(/^\./, '');
}

/**
 * Resolve a format hint or a filename to a language the extractor has forms
 * for.
 *
 * Returns undefined when nothing matches, which is an answer rather than a
 * failure: the caller scans for every form, and says so.
 */
export function resolveFormat(
	format: string | undefined,
	filename: string | undefined,
): Language | undefined {
	if (format) {
		const direct = ALIASES[normalise(format)];
		if (direct) return determineLanguage(direct);
	}

	if (filename) {
		const dot = filename.lastIndexOf('.');
		if (dot !== -1) {
			const byExtension = ALIASES[normalise(filename.slice(dot + 1))];
			if (byExtension) return determineLanguage(byExtension);
		}
	}

	return undefined;
}
