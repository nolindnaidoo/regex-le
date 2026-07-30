import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { getConfiguration } from '../config/config';
import { createTelemetry } from './telemetry';

// Mock vscode and config
vi.mock('vscode');
vi.mock('../config/config', () => ({
	getConfiguration: vi.fn(() => ({
		telemetryEnabled: true,
	})),
}));

describe('telemetry', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Reset config mock to default (telemetryEnabled: true)
		// This ensures tests that modify it don't affect subsequent tests
		vi.mocked(getConfiguration).mockReturnValue({
			telemetryEnabled: true,
		} as any);
	});

	describe('createTelemetry', () => {
		it('should create telemetry service', () => {
			const telemetry = createTelemetry();
			expect(telemetry).toBeDefined();
			expect(typeof telemetry.event).toBe('function');
			expect(typeof telemetry.dispose).toBe('function');
		});

		it('should create output channel lazily on first event when enabled', () => {
			const createOutputChannelSpy = vi.mocked(
				vscode.window.createOutputChannel,
			);
			createOutputChannelSpy.mockReturnValue({
				appendLine: vi.fn(),
				dispose: vi.fn(),
			} as any);

			const telemetry = createTelemetry();
			expect(createOutputChannelSpy).not.toHaveBeenCalled();

			telemetry.event('first');
			expect(createOutputChannelSpy).toHaveBeenCalledWith(
				expect.stringContaining('Telemetry'),
			);
			expect(Object.isFrozen(telemetry)).toBe(true);
		});

		it('should log events when enabled', () => {
			const appendLineSpy = vi.fn();
			vi.mocked(vscode.window.createOutputChannel).mockReturnValue({
				appendLine: appendLineSpy,
				dispose: vi.fn(),
			} as any);

			const telemetry = createTelemetry();
			telemetry.event('test-event');

			expect(appendLineSpy).toHaveBeenCalled();
			const call = appendLineSpy.mock.calls[0];
			expect(call?.[0]).toContain('test-event');
			expect(call?.[0]).toContain('['); // timestamp
		});

		it('should include properties in event log', () => {
			const appendLineSpy = vi.fn();
			vi.mocked(vscode.window.createOutputChannel).mockReturnValue({
				appendLine: appendLineSpy,
				dispose: vi.fn(),
			} as any);

			const telemetry = createTelemetry();
			telemetry.event('test-event', { key: 'value', count: 123 });

			expect(appendLineSpy).toHaveBeenCalled();
			const call = appendLineSpy.mock.calls[0];
			expect(call?.[0]).toContain('test-event');
			expect(call?.[0]).toContain('key');
			expect(call?.[0]).toContain('value');
		});

		it('should dispose output channel', () => {
			const disposeSpy = vi.fn();
			vi.mocked(vscode.window.createOutputChannel).mockReturnValue({
				appendLine: vi.fn(),
				dispose: disposeSpy,
			} as any);

			const telemetry = createTelemetry();
			telemetry.event('creates-channel');
			telemetry.dispose();

			expect(disposeSpy).toHaveBeenCalled();
		});

		it('stops logging when telemetry is disabled at runtime', () => {
			const appendLineSpy = vi.fn();
			vi.mocked(vscode.window.createOutputChannel).mockReturnValue({
				appendLine: appendLineSpy,
				dispose: vi.fn(),
			} as any);

			const telemetry = createTelemetry();
			telemetry.event('while-enabled');
			expect(appendLineSpy).toHaveBeenCalledTimes(1);

			vi.mocked(getConfiguration).mockReturnValue({
				telemetryEnabled: false,
			} as any);
			telemetry.event('while-disabled');
			expect(appendLineSpy).toHaveBeenCalledTimes(1);
		});

		it('should handle events without properties', () => {
			const appendLineSpy = vi.fn();
			vi.mocked(vscode.window.createOutputChannel).mockReturnValue({
				appendLine: appendLineSpy,
				dispose: vi.fn(),
			} as any);

			const telemetry = createTelemetry();
			telemetry.event('simple-event');

			expect(appendLineSpy).toHaveBeenCalled();
			const call = appendLineSpy.mock.calls[0];
			expect(call?.[0]).toContain('simple-event');
		});

		it('should format timestamp correctly', () => {
			const appendLineSpy = vi.fn();
			vi.mocked(vscode.window.createOutputChannel).mockReturnValue({
				appendLine: appendLineSpy,
				dispose: vi.fn(),
			} as any);

			const telemetry = createTelemetry();
			telemetry.event('test');

			const call = appendLineSpy.mock.calls[0];
			// Should contain ISO timestamp format
			expect(call?.[0]).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
		});

		it('should not create output channel when telemetry is disabled', async () => {
			const { getConfiguration } = await import('../config/config');
			vi.mocked(getConfiguration).mockReturnValue({
				telemetryEnabled: false,
			} as any);

			const createOutputChannelSpy = vi.mocked(
				vscode.window.createOutputChannel,
			);

			const telemetry = createTelemetry();
			telemetry.event('test'); // Should not error even without channel

			// Channel should not be created
			expect(createOutputChannelSpy).not.toHaveBeenCalled();
		});

		it('should handle multiple events', () => {
			// Reset config mock to ensure telemetry is enabled (no async import needed)
			// The module-level mock already sets telemetryEnabled: true by default
			// beforeEach clears mocks but the module mock should still work
			const appendLineSpy = vi.fn();
			const outputChannel = {
				appendLine: appendLineSpy,
				dispose: vi.fn(),
			};
			const createOutputChannelSpy = vi.mocked(
				vscode.window.createOutputChannel,
			);
			createOutputChannelSpy.mockReturnValue(outputChannel as any);

			const telemetry = createTelemetry();

			telemetry.event('event1');
			telemetry.event('event2', { prop: 'value' });

			expect(appendLineSpy).toHaveBeenCalledTimes(2);
			expect(appendLineSpy.mock.calls[0]?.[0]).toContain('event1');
			expect(appendLineSpy.mock.calls[1]?.[0]).toContain('event2');
		});
	});
});
