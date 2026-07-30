import { beforeEach, describe, expect, it } from 'vitest';
import {
	_outputChannels,
	_resetMockState,
	_setConfig,
} from '../__mocks__/vscode';
import { createTelemetry } from './telemetry';

describe('telemetry', () => {
	beforeEach(() => {
		_resetMockState();
	});

	it('is a no-op when disabled (default)', () => {
		const telemetry = createTelemetry();
		telemetry.event('ignored');
		expect(_outputChannels()).toHaveLength(0);
	});

	it('creates the channel lazily on first event when enabled', () => {
		_setConfig('regex-le.telemetryEnabled', true);
		const telemetry = createTelemetry();
		expect(_outputChannels()).toHaveLength(0);

		telemetry.event('first');
		expect(_outputChannels()).toHaveLength(1);
		expect(_outputChannels()[0]?.name).toContain('Telemetry');
	});

	it('logs events with timestamp and properties', () => {
		_setConfig('regex-le.telemetryEnabled', true);
		const telemetry = createTelemetry();
		telemetry.event('test-event', { key: 'value', count: 123 });

		const line = _outputChannels()[0]?._lines[0] ?? '';
		expect(line).toContain('test-event');
		expect(line).toContain('"key":"value"');
		expect(line).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
	});

	it('logs events without properties', () => {
		_setConfig('regex-le.telemetryEnabled', true);
		const telemetry = createTelemetry();
		telemetry.event('simple');
		expect(_outputChannels()[0]?._lines[0]).toContain('simple');
	});

	it('stops logging when disabled at runtime', () => {
		_setConfig('regex-le.telemetryEnabled', true);
		const telemetry = createTelemetry();
		telemetry.event('while-enabled');
		expect(_outputChannels()[0]?._lines).toHaveLength(1);

		_setConfig('regex-le.telemetryEnabled', false);
		telemetry.event('while-disabled');
		expect(_outputChannels()[0]?._lines).toHaveLength(1);
	});

	it('dispose is safe with and without a channel', () => {
		const disabled = createTelemetry();
		expect(() => disabled.dispose()).not.toThrow();

		_setConfig('regex-le.telemetryEnabled', true);
		const enabled = createTelemetry();
		enabled.event('creates-channel');
		expect(() => enabled.dispose()).not.toThrow();
	});
});
