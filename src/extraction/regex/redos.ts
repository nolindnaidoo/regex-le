/**
 * ReDoS (Regular Expression Denial of Service) detection
 * Detects potentially vulnerable regex patterns that could cause catastrophic backtracking
 */

export interface ReDoSResult {
	readonly detected: boolean;
	readonly severity: 'low' | 'medium' | 'high';
	readonly reason: string;
	readonly vulnerableGroups?: readonly string[] | undefined;
}

/**
 * Check if a regex pattern is vulnerable to ReDoS
 */
export function detectReDoS(pattern: string, flags: string): ReDoSResult {
	// Common ReDoS patterns
	const dangerousPatterns = [
		// Nested quantifiers
		/(\w+)*(\w+)*(\w+)*/,
		/(\w*)*(\w*)*(\w*)*/,
		/(\w+)+(\w+)+(\w+)+/,

		// Exponential backtracking patterns
		/(.*)*/,
		/(.+)*/,
		/(.*)+/,
		/(.+)+/,

		// Nested alternations
		/(a|a)*/,
		/(a+)+/,
		/(a*)*/,

		// Repetition with overlap
		/(\w+\s*)*/,
		/(\d+\s*)*/,
	];

	try {
		// Test pattern compilation first
		new RegExp(pattern, flags);

		// Check for nested quantifiers (basic detection)
		const nestedQuantifierPattern = /\([^)]*\)[*?+{]|\*[*?+{]/;
		if (nestedQuantifierPattern.test(pattern.replace(/\\/g, ''))) {
			// Check for specific dangerous patterns
			for (const dangerousPattern of dangerousPatterns) {
				if (pattern.includes(dangerousPattern.source.replace(/\\/g, ''))) {
					return Object.freeze({
						detected: true,
						severity: 'high',
						reason:
							'Pattern contains nested quantifiers that could cause exponential backtracking',
					});
				}
			}
		}

		// Check for evil regex patterns (simplified)
		if (containsEvilPattern(pattern)) {
			return Object.freeze({
				detected: true,
				severity: 'high',
				reason: 'Pattern matches known ReDoS vulnerability patterns',
			});
		}

		// Check for potentially problematic patterns
		const problematicPattern = /\([^)]+\)[*+]/;
		if (problematicPattern.test(pattern)) {
			// Check if it's within a larger quantifier
			if (/\([^)]*\([^)]+\)[*+][^)]*\)[*+]/.test(pattern)) {
				return Object.freeze({
					detected: true,
					severity: 'medium',
					reason:
						'Pattern contains quantifiers within quantifiers which may cause backtracking issues',
				});
			}
		}

		return Object.freeze({
			detected: false,
			severity: 'low',
			reason: 'No obvious ReDoS vulnerabilities detected',
		});
	} catch {
		// Invalid regex - not a ReDoS issue, but a syntax error
		return Object.freeze({
			detected: false,
			severity: 'low',
			reason: 'Pattern is invalid',
		});
	}
}

/**
 * Check for known "evil regex" patterns
 */
function containsEvilPattern(pattern: string): boolean {
	const evilPatterns = [
		// (a+)+ patterns
		/\(a\+\)\+/,
		// (.*)+ patterns
		/\(\.\*\)\+/,
		// Nested repetitions
		/\([^)]+\+\)\+/,
		/\([^)]+\*\)\*/,
	];

	for (const evilPattern of evilPatterns) {
		if (evilPattern.test(pattern)) {
			return true;
		}
	}

	return false;
}
