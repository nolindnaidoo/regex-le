import { describe, expect, it } from 'vitest';
import { _createDocument } from '../__mocks__/vscode';
import { CONFIG_DEFAULTS } from '../config/config';
import type { Configuration } from '../types';
import { checkOutputSafety, handleSafetyChecks } from './safety';

const config = (overrides: Partial<Configuration> = {}): Configuration =>
	Object.freeze({ ...CONFIG_DEFAULTS, ...overrides });

describe('handleSafetyChecks', () => {
	it('passes small ordinary files', () => {
		const result = handleSafetyChecks(
			_createDocument({ content: 'hello' }) as never,
			config(),
		);
		expect(result.proceed).toBe(true);
		expect(result.warnings).toHaveLength(0);
	});

	it('blocks files over the size threshold', () => {
		const result = handleSafetyChecks(
			_createDocument({ content: 'x'.repeat(2000) }) as never,
			config({ safetyFileSizeWarnBytes: 1000 }),
		);
		expect(result.proceed).toBe(false);
		expect(result.message).toContain('exceeds safety threshold');
	});

	it('warns about very long files without blocking', () => {
		const result = handleSafetyChecks(
			_createDocument({ content: 'line\n'.repeat(10_001) }) as never,
			config({ safetyFileSizeWarnBytes: 1_000_000 }),
		);
		expect(result.proceed).toBe(true);
		expect(result.warnings[0]).toContain('lines');
	});

	it('warns about binary content', () => {
		const result = handleSafetyChecks(
			_createDocument({ content: 'ab\x00cd' }) as never,
			config(),
		);
		expect(result.proceed).toBe(true);
		expect(result.warnings[0]).toContain('binary');
	});

	it('skips every check when safety is disabled', () => {
		const result = handleSafetyChecks(
			_createDocument({ content: 'x'.repeat(2000) }) as never,
			config({ safetyEnabled: false, safetyFileSizeWarnBytes: 1000 }),
		);
		expect(result.proceed).toBe(true);
	});
});

describe('checkOutputSafety', () => {
	it('passes small outputs', () => {
		expect(checkOutputSafety(['a', 'b'], config()).proceed).toBe(true);
	});

	it('blocks outputs over the line threshold', () => {
		const lines = Array.from({ length: 101 }, (_, i) => String(i));
		const result = checkOutputSafety(
			lines,
			config({ safetyLargeOutputLinesThreshold: 100 }),
		);
		expect(result.proceed).toBe(false);
		expect(result.message).toContain('Output size');
	});

	it('skips the check when safety is disabled', () => {
		const lines = Array.from({ length: 101 }, (_, i) => String(i));
		const result = checkOutputSafety(
			lines,
			config({ safetyEnabled: false, safetyLargeOutputLinesThreshold: 100 }),
		);
		expect(result.proceed).toBe(true);
	});
});
