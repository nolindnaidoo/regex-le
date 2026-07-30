/**
 * Enhanced error handling utilities
 * Provides sophisticated error categorization, recovery, and user feedback
 */

export type ErrorCategory =
	| 'parse'
	| 'validation'
	| 'safety'
	| 'operational'
	| 'file-system'
	| 'configuration';

export interface EnhancedError {
	readonly category: ErrorCategory;
	readonly originalError: Error;
	readonly message: string;
	readonly userFriendlyMessage: string;
	readonly userMessage: string;
	readonly suggestion: string;
	readonly recoverable: boolean;
	readonly severity: 'low' | 'medium' | 'high';
	readonly timestamp: Date;
}

export interface ErrorRecoveryOptions {
	readonly retryable: boolean;
	readonly maxRetries: number;
	readonly retryDelay: number;
	readonly fallbackAction?: () => Promise<void>;
	readonly userAction?: string;
}

export interface ErrorSummary {
	readonly totalErrors: number;
	readonly severity: {
		readonly low: number;
		readonly medium: number;
		readonly high: number;
	};
	readonly recoverableErrors: number;
	readonly nonRecoverableErrors: number;
}

/**
 * Create an enhanced error with categorization and user-friendly messaging
 */
export function createEnhancedError(
	error: Error,
	category: ErrorCategory,
	context?: Record<string, unknown>,
	options?: {
		recoverable?: boolean;
		severity?: 'low' | 'medium' | 'high';
		suggestion?: string;
	},
): EnhancedError {
	const userFriendlyMessage = getUserFriendlyMessage(
		error,
		category,
		context?.filepath as string,
	);
	const suggestion = options?.suggestion || getErrorSuggestion(error, category);
	const recoverable =
		options?.recoverable ?? isRecoverableError(error, category);
	const severity = options?.severity || 'medium';

	return Object.freeze({
		category,
		originalError: error,
		message: error.message,
		userFriendlyMessage,
		userMessage: userFriendlyMessage,
		suggestion,
		recoverable,
		severity,
		timestamp: new Date(),
	});
}

/**
 * Determine if an error is recoverable
 */
function isRecoverableError(error: Error, category: ErrorCategory): boolean {
	// Parse errors are usually recoverable with user input
	if (category === 'parse') {
		return true;
	}

	// Validation errors are recoverable
	if (category === 'validation') {
		return true;
	}

	// Safety errors are recoverable with override
	if (category === 'safety') {
		return true;
	}

	// File system errors depend on the specific error
	if (category === 'file-system') {
		const message = error.message.toLowerCase();
		// Permission errors are not recoverable
		if (message.includes('permission') || message.includes('eacces')) {
			return false;
		}
		// File not found is not recoverable
		if (message.includes('enoent') || message.includes('not found')) {
			return false;
		}
		return true;
	}

	// Configuration errors are recoverable
	if (category === 'configuration') {
		return true;
	}

	// Operational errors vary
	return false;
}

/**
 * Get user-friendly error message
 */
function getUserFriendlyMessage(
	error: Error,
	category: ErrorCategory,
	filepath?: string,
): string {
	const sanitizedPath = filepath ? sanitizePath(filepath) : undefined;

	if (category === 'parse') {
		return `Failed to parse content${sanitizedPath ? ` from ${sanitizedPath}` : ''}`;
	}

	if (category === 'validation') {
		return `Validation failed${sanitizedPath ? ` for ${sanitizedPath}` : ''}`;
	}

	if (category === 'safety') {
		return `Safety check failed: ${error.message}`;
	}

	if (category === 'file-system') {
		return `File system error${sanitizedPath ? ` for ${sanitizedPath}` : ''}`;
	}

	if (category === 'configuration') {
		return `Configuration error: ${error.message}`;
	}

	return `Operation failed: ${error.message}`;
}

/**
 * Get error suggestion based on category
 */
function getErrorSuggestion(_error: Error, category: ErrorCategory): string {
	if (category === 'parse') {
		return 'Check the file format and try again';
	}

	if (category === 'validation') {
		return 'Verify the input meets requirements';
	}

	if (category === 'safety') {
		return 'Consider adjusting safety thresholds in settings';
	}

	if (category === 'file-system') {
		return 'Check file permissions and path';
	}

	if (category === 'configuration') {
		return 'Review extension settings';
	}

	return 'Try the operation again';
}

/**
 * Sanitize file paths to prevent information leakage
 * Removes sensitive directories like home paths, usernames, etc.
 */
export function sanitizePath(filepath: string): string {
	// Remove home directory references
	let sanitized = filepath.replace(/\/Users\/[^/]+/g, '~');
	sanitized = sanitized.replace(/\/home\/[^/]+/g, '~');
	sanitized = sanitized.replace(/C:\\Users\\[^\\]+/g, '~');

	// Remove workspace-specific prefixes if very long
	const parts = sanitized.split('/');
	if (parts.length > 5) {
		return `.../${parts.slice(-3).join('/')}`;
	}

	return sanitized;
}

/**
 * Create error handler
 */
export interface ErrorHandler {
	handle(
		error: Error,
		category: ErrorCategory,
		context?: Record<string, unknown>,
	): EnhancedError;
}

export function createErrorHandler(): ErrorHandler {
	return Object.freeze({
		handle(
			error: Error,
			category: ErrorCategory,
			context?: Record<string, unknown>,
		): EnhancedError {
			return createEnhancedError(error, category, context);
		},
	});
}

/**
 * Create error logger
 */
export interface ErrorLogger {
	log(error: EnhancedError): void;
}

export function createErrorLogger(): ErrorLogger {
	return Object.freeze({
		log(error: EnhancedError): void {
			// In production, this would log to an output channel or telemetry
			console.error(
				`[${error.category}] ${error.message}`,
				error.originalError,
			);
		},
	});
}

/**
 * Create error notifier
 */
export interface ErrorNotifier {
	notify(error: EnhancedError): void;
}

export function createErrorNotifier(): ErrorNotifier {
	return Object.freeze({
		notify(error: EnhancedError): void {
			// Notifier would be injected in real implementation
			console.warn(`Error: ${error.userMessage}`);
		},
	});
}

/**
 * Create performance error
 */
export function createPerformanceError(
	operation: string,
	duration: number,
	threshold: number,
): EnhancedError {
	const error = new Error(
		`Operation "${operation}" exceeded performance threshold (${duration}ms > ${threshold}ms)`,
	);

	return createEnhancedError(
		error,
		'operational',
		{
			operation,
			duration,
			threshold,
		},
		{
			recoverable: true,
			severity: 'medium',
			suggestion:
				'Consider processing smaller files or adjusting performance settings',
		},
	);
}

/**
 * Create error summary from array of errors
 */
export function createErrorSummary(
	errors: readonly EnhancedError[],
): ErrorSummary {
	const severityCounts = {
		low: 0,
		medium: 0,
		high: 0,
	};

	let recoverableCount = 0;
	let nonRecoverableCount = 0;

	for (const error of errors) {
		severityCounts[error.severity]++;
		if (error.recoverable) {
			recoverableCount++;
		} else {
			nonRecoverableCount++;
		}
	}

	return Object.freeze({
		totalErrors: errors.length,
		severity: Object.freeze(severityCounts),
		recoverableErrors: recoverableCount,
		nonRecoverableErrors: nonRecoverableCount,
	});
}
