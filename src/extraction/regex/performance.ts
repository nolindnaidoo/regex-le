import type { PerformanceMetrics, RegexPerformanceScore } from '../../types';

/**
 * Calculate performance score for a regex pattern
 * Returns a score from 0-100 where higher is better
 */
export function calculatePerformanceScore(
	metrics: PerformanceMetrics,
	inputSize: number,
): RegexPerformanceScore {
	// Complexity score (based on pattern complexity indicators)
	const complexityScore = calculateComplexityScore(metrics);

	// Execution time score (lower is better)
	const executionTimeScore = calculateExecutionTimeScore(
		metrics.duration,
		inputSize,
	);

	// Memory usage score (lower is better)
	const memoryScore = calculateMemoryScore(metrics.memoryUsage);

	// Overall score is weighted average
	const overall =
		complexityScore * 0.4 + executionTimeScore * 0.35 + memoryScore * 0.25;

	const description = getPerformanceDescription(
		overall,
		complexityScore,
		executionTimeScore,
	);

	return Object.freeze({
		overall: Math.round(overall),
		complexity: Math.round(complexityScore),
		executionTime: Math.round(executionTimeScore),
		memoryUsage: Math.round(memoryScore),
		description,
	});
}

/**
 * Calculate complexity score based on performance metrics
 */
function calculateComplexityScore(metrics: PerformanceMetrics): number {
	// Simple heuristic: duration relative to input size
	const throughput = metrics.inputSize / metrics.duration;

	// Normalize throughput to 0-100 scale
	// Higher throughput = better score
	let score = (throughput / 1000) * 100; // Assuming 1000 chars/ms is excellent
	score = Math.max(0, Math.min(100, score));

	return score;
}

/**
 * Calculate execution time score
 */
function calculateExecutionTimeScore(
	duration: number,
	inputSize: number,
): number {
	// Score based on duration per character
	const msPerChar = duration / inputSize;

	// Lower ms per char is better
	// < 0.01ms per char = 100
	// > 1ms per char = 0
	let score = 100 - msPerChar * 100;
	score = Math.max(0, Math.min(100, score));

	return score;
}

/**
 * Calculate memory usage score
 */
function calculateMemoryScore(memoryUsage: number): number {
	// For now, assume lower memory is better
	// This is simplified - actual memory usage would need proper measurement
	if (memoryUsage === 0) {
		return 100; // No measurement available
	}

	// Normalize to 0-100 scale (assuming < 1MB is excellent)
	const mb = memoryUsage / (1024 * 1024);
	let score = 100 - mb * 10;
	score = Math.max(0, Math.min(100, score));

	return score;
}

/**
 * Get performance description
 */
function getPerformanceDescription(
	overall: number,
	_complexity: number,
	_executionTime: number,
): string {
	if (overall >= 80) {
		return 'Excellent performance';
	}
	if (overall >= 60) {
		return 'Good performance';
	}
	if (overall >= 40) {
		return 'Moderate performance';
	}
	if (overall >= 20) {
		return 'Poor performance - consider optimization';
	}
	return 'Very poor performance - pattern likely needs redesign';
}

/**
 * Estimate regex complexity from pattern string
 */
export function estimatePatternComplexity(pattern: string): {
	readonly score: number;
	readonly factors: readonly string[];
} {
	const factors: string[] = [];
	let complexity = 0;

	// Count quantifiers
	const quantifierCount = (pattern.match(/[*?+{]/g) || []).length;
	if (quantifierCount > 10) {
		factors.push('Many quantifiers');
		complexity += quantifierCount * 2;
	}

	// Count alternations
	const alternationCount = (pattern.match(/\|/g) || []).length;
	if (alternationCount > 5) {
		factors.push('Many alternations');
		complexity += alternationCount * 3;
	}

	// Check for nested groups
	const nestedGroupDepth = calculateNestedDepth(pattern);
	if (nestedGroupDepth > 3) {
		factors.push('Deeply nested groups');
		complexity += nestedGroupDepth * 5;
	}

	// Check for lookaheads/lookbehinds
	const hasLookaround = /\(\?[!=<>]/.test(pattern);
	if (hasLookaround) {
		factors.push('Lookaround assertions');
		complexity += 10;
	}

	// Normalize to 0-100 scale
	const score = Math.min(100, complexity);

	return Object.freeze({
		score,
		factors: Object.freeze(factors),
	});
}

/**
 * Calculate maximum nesting depth of parentheses, skipping escaped
 * parens and character classes.
 */
function calculateNestedDepth(pattern: string): number {
	let maxDepth = 0;
	let currentDepth = 0;
	let inClass = false;

	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === '\\') {
			i++;
			continue;
		}
		if (inClass) {
			if (char === ']') {
				inClass = false;
			}
			continue;
		}
		if (char === '[') {
			inClass = true;
			continue;
		}
		if (char === '(') {
			currentDepth++;
			maxDepth = Math.max(maxDepth, currentDepth);
			continue;
		}
		if (char === ')') {
			currentDepth = Math.max(0, currentDepth - 1);
		}
	}

	return maxDepth;
}
