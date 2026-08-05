/**
 * The result a ReDoS scan reports when the scan did not run.
 *
 * Both commands built this object inline in an `else`, which is how the same
 * three fields came to exist in three places.
 */
export const NO_REDOS_FINDING = Object.freeze({
	detected: false,
	severity: 'low' as const,
	reason: '',
});
