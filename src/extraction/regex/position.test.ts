import { describe, expect, it } from 'vitest';
import { createPositionIndex } from './position';

describe('createPositionIndex', () => {
	const text = 'first\nsecond\n\nfourth';
	const index = createPositionIndex(text);

	it('maps offset 0 to line 1 column 1', () => {
		expect(index.positionAt(0)).toEqual({ line: 1, column: 1 });
	});

	it('maps positions within a line', () => {
		expect(index.positionAt(2)).toEqual({ line: 1, column: 3 });
	});

	it('maps the first character after a newline to the next line', () => {
		expect(index.positionAt(6)).toEqual({ line: 2, column: 1 });
	});

	it('handles empty lines', () => {
		expect(index.positionAt(13)).toEqual({ line: 3, column: 1 });
		expect(index.positionAt(14)).toEqual({ line: 4, column: 1 });
	});

	it('clamps offsets past the end', () => {
		expect(index.positionAt(999)).toEqual({ line: 4, column: 7 });
	});

	it('clamps negative offsets to the start', () => {
		expect(index.positionAt(-5)).toEqual({ line: 1, column: 1 });
	});

	it('handles CRLF text (column includes the CR)', () => {
		const crlf = createPositionIndex('ab\r\ncd');
		expect(crlf.positionAt(4)).toEqual({ line: 2, column: 1 });
	});
});
