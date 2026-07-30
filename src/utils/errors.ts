/**
 * Redact user directories and credential-shaped fragments from messages
 * before they reach notifications or logs.
 */
export function sanitizeErrorMessage(message: string): string {
	return message
		.replace(/\/Users\/[^/]+\//g, '/Users/***/')
		.replace(/\/home\/[^/]+\//g, '/home/***/')
		.replace(/C:\\Users\\[^\\]+\\/g, 'C:\\Users\\***\\')
		.replace(/password[=:]\s*[^\s]+/gi, 'password=***')
		.replace(/token[=:]\s*[^\s]+/gi, 'token=***')
		.replace(/key[=:]\s*[^\s]+/gi, 'key=***');
}
