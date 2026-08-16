/**
 * ReDoS (Regular Expression Denial of Service) detection.
 *
 * **Demonstrated, not inferred.** A shape rule — nested quantifiers,
 * star height, overlapping alternation — scored 6 of 20 against patterns
 * whose behaviour was measured rather than assumed, and an automaton
 * scored 10: both flagged `^[a-z0-9]+(?:-[a-z0-9]+)*$`, which is safe
 * because every iteration must eat a `-` the inner class cannot produce,
 * and both missed `(.*a){20}`, which is not. A separator forcing the
 * split is a fact about strings, so no test on syntax settles it.
 *
 * `decide` asks the question that does settle it — is there an input
 * that makes this blow up — and answers with that input. Nothing is
 * reported here that was not shown, and every finding carries the
 * `witness` that shows it.
 *
 * **Silence is not a clearance.** A pattern this cannot read comes back
 * as undecided with the reason named, never as safe.
 */

import { decide } from './ambiguity';
import { isWellFormed } from './heuristics';

export interface ReDoSResult {
	readonly detected: boolean;
	readonly severity: 'low' | 'medium' | 'high';
	readonly reason: string;
	/**
	 * The input that demonstrates the blow-up.
	 *
	 * **This is the finding.** A severity is an opinion; a string that
	 * takes the pattern from forty steps to two million is a receipt, and
	 * it is what makes the report checkable by whoever reads it.
	 */
	readonly witness?: string | undefined;
}

/**
 * Screen a pattern for catastrophic backtracking.
 */
export function detectReDoS(pattern: string, flags: string): ReDoSResult {
	// An invalid pattern is a syntax error, not a ReDoS finding. Saying
	// otherwise would put a security verdict on a typo. The judge is
	// `isWellFormed` rather than `new RegExp` because this scan reads
	// patterns from every language the extractor finds one in, and
	// JavaScript is the only engine here: a Python named group would
	// otherwise come back as a syntax error on working code.
	if (!isWellFormed(pattern, flags)) {
		return Object.freeze({
			detected: false,
			severity: 'low',
			reason: 'Pattern is invalid',
		});
	}

	const decision = decide(pattern);
	// **A refusal, not a clearance.** A backreference or a lookaround is
	// not a regular language, so this construction cannot answer for it
	// either way, and saying "no finding" would read as safe.
	if (decision.kind === 'undecided') {
		return Object.freeze({
			detected: false,
			severity: 'low',
			reason: `not decided: ${decision.reason}`,
		});
	}
	if (decision.kind === 'clean') {
		return Object.freeze({
			detected: false,
			severity: 'low',
			reason: 'no input was found that drives this into backtracking',
		});
	}

	const characters = Array.from(decision.witness).length;
	return Object.freeze({
		detected: true,
		severity: 'high',
		reason: `exponential backtracking: ${decision.high} steps on ${characters} characters, against ${decision.low} on ${Math.floor(characters / 2)}`,
		witness: decision.witness,
	});
}
