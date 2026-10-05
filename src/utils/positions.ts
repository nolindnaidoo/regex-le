/**
 * A report with the positions taken out.
 *
 * Each command builds its report once, positions included, because building
 * it means running the patterns. The screen and the clipboard are then each
 * asked separately whether they want positions, so the version without is
 * derived here from the one text and the two cannot drift apart.
 *
 * Only whole position lines and the position prefix of an extracted pattern
 * are removed. A pattern that happens to contain `12:3` is left alone: the
 * prefix is recognised by the tab after it, which Extract writes and a
 * pattern on its own line never starts with.
 */
const POSITION_LINE = /^(?:\*\*Line:\*\* \d+| {3}Line \d+, Column \d+)$/;
const POSITION_PREFIX = /^\d+:\d+\t/;

export function withoutPositions(text: string): string {
	return text
		.split('\n')
		.filter((line) => !POSITION_LINE.test(line))
		.map((line) => line.replace(POSITION_PREFIX, ''))
		.join('\n');
}

/** The text as written, or without its positions. */
export function positioned(text: string, keep: boolean): string {
	return keep ? text : withoutPositions(text);
}
