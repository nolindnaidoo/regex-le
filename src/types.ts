/**
 * Core type definitions for regex-le extension
 */

export interface RegexTestResult {
	readonly success: boolean;
	readonly pattern: string;
	readonly flags: string;
	readonly matches: readonly RegexMatch[];
	readonly errors: readonly ParseError[];
	readonly warnings?: readonly string[] | undefined;
	readonly performance?: PerformanceMetrics | undefined;
}

export interface RegexMatch {
	readonly match: string;
	readonly index: number;
	readonly groups?: readonly RegexGroup[] | undefined;
	readonly line?: number | undefined;
	readonly column?: number | undefined;
}

export interface RegexGroup {
	readonly index: number;
	readonly name?: string | undefined;
	readonly value: string;
	readonly start: number;
	readonly end: number;
}

export interface ParseError {
	readonly type: 'parse-error' | 'validation-error' | 'redos-error';
	readonly message: string;
}

export interface Configuration {
	readonly copyToClipboardEnabled: boolean;
	readonly notificationsLevel: 'all' | 'important' | 'silent';
	readonly openResultsSideBySide: boolean;
	readonly safetyEnabled: boolean;
	readonly safetyFileSizeWarnBytes: number;
	readonly safetyLargeOutputLinesThreshold: number;
	readonly statusBarEnabled: boolean;
	readonly telemetryEnabled: boolean;
	readonly regexRedosDetectionEnabled: boolean;
	readonly regexMaxMatchLimit: number;
}

export interface PerformanceMetrics {
	readonly operation: string;
	readonly startTime: number;
	readonly endTime: number;
	readonly duration: number;
	readonly inputSize: number;
	readonly outputSize: number;
	readonly itemCount: number;
	readonly memoryUsage: number;
	readonly cpuUsage: number;
	readonly warnings: number;
	readonly errors: number;
}

export interface RegexPerformanceScore {
	readonly overall: number;
	readonly complexity: number;
	readonly executionTime: number;
	readonly memoryUsage: number;
	readonly description: string;
}
