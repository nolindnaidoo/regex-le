/**
 * A string as Rust's `{:?}` writes it, for the refusals that quote what the
 * caller typed.
 *
 * `str`'s Debug escapes the quote and the backslash, names `\t`, `\r`, `\n`
 * and `\0`, and writes `\u{…}` for a combining mark and for anything Rust's
 * printable table leaves out: controls, format characters, separators other
 * than the space, surrogates, private use and unassigned code points. Rust's
 * table follows its own Unicode version, so a code point assigned since can
 * differ; nothing typed on a command line in practice reaches that edge.
 */
const NAMED: Readonly<Record<string, string>> = Object.freeze({
	'"': '\\"',
	'\\': '\\\\',
	'\t': '\\t',
	'\r': '\\r',
	'\n': '\\n',
	'\0': '\\0',
});

const UNPRINTABLE =
	/^(?:[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Grapheme_Extend}]|(?! )\p{Zs})$/u;

export function rustDebug(value: string): string {
	let out = '"';
	for (const char of value) {
		const named = NAMED[char];
		if (named !== undefined) {
			out += named;
			continue;
		}
		out += UNPRINTABLE.test(char)
			? `\\u{${(char.codePointAt(0) as number).toString(16)}}`
			: char;
	}
	return `${out}"`;
}
