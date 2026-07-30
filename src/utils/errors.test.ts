import { describe, expect, it } from 'vitest';
import { sanitizeErrorMessage } from './errors';

describe('sanitizeErrorMessage', () => {
	it('redacts macOS home directories', () => {
		expect(sanitizeErrorMessage('ENOENT /Users/alice/project/x')).toBe(
			'ENOENT /Users/***/project/x',
		);
	});

	it('redacts Linux home directories', () => {
		expect(sanitizeErrorMessage('/home/bob/secret/f')).toBe(
			'/home/***/secret/f',
		);
	});

	it('redacts Windows user directories', () => {
		expect(sanitizeErrorMessage('C:\\Users\\carol\\x')).toBe(
			'C:\\Users\\***\\x',
		);
	});

	it('redacts credential-shaped fragments', () => {
		expect(sanitizeErrorMessage('failed: password=hunter2')).toBe(
			'failed: password=***',
		);
		expect(sanitizeErrorMessage('token: abc123')).toBe('token=***');
		expect(sanitizeErrorMessage('apikey=xyz')).toBe('apikey=***');
	});

	it('leaves ordinary messages untouched', () => {
		expect(sanitizeErrorMessage('parse failed at line 3')).toBe(
			'parse failed at line 3',
		);
	});
});
