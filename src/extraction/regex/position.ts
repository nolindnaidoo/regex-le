/**
 * Offset -> line/column translation backed by a newline-offset index.
 * Build once per document, then every lookup is a binary search — no
 * per-match substring splitting.
 *
 * Lines and columns are 1-based, matching what the commands print.
 */

export interface Position {
	readonly line: number;
	readonly column: number;
}

export interface PositionIndex {
	positionAt(offset: number): Position;
}

export function createPositionIndex(text: string): PositionIndex {
	// lineStarts[i] is the offset of the first character of line i (0-based)
	const lineStarts: number[] = [0];
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10 /* \n */) {
			lineStarts.push(i + 1);
		}
	}

	return Object.freeze({
		positionAt(offset: number): Position {
			const clamped = Math.max(0, Math.min(offset, text.length));
			let low = 0;
			let high = lineStarts.length - 1;
			while (low < high) {
				const mid = Math.ceil((low + high) / 2);
				if ((lineStarts[mid] ?? 0) <= clamped) {
					low = mid;
					continue;
				}
				high = mid - 1;
			}
			return Object.freeze({
				line: low + 1,
				column: clamped - (lineStarts[low] ?? 0) + 1,
			});
		},
	});
}
