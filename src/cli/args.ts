/**
 * The command line, parsed as the Rust CLI parses it: strictly, in order, and
 * refusing rather than defaulting.
 */
import { FLAGS } from './usage';

export type Threshold = 'high' | 'medium';

export interface ScanOptions {
	readonly threshold: Threshold;
	readonly all: boolean;
}

export interface WalkOptions {
	readonly hidden: boolean;
	readonly respectIgnore: boolean;
}

export interface Cli {
	readonly strict: boolean;
	readonly inputs: readonly string[];
	readonly stdin: boolean;
	readonly scan: ScanOptions;
	readonly walk: WalkOptions;
}

type Draft = { -readonly [K in keyof Cli]: Cli[K] };

const SWITCHES: Readonly<Record<string, (draft: Draft) => void>> =
	Object.freeze({
		'--all': (draft) => {
			draft.scan = { ...draft.scan, all: true };
		},
		'--stdin': (draft) => {
			draft.stdin = true;
		},
		'--strict': (draft) => {
			draft.strict = true;
		},
		'--hidden': (draft) => {
			draft.walk = { ...draft.walk, hidden: true };
		},
		'--no-ignore': (draft) => {
			draft.walk = { ...draft.walk, respectIgnore: false };
		},
	});

export function parse(args: readonly string[]): Cli {
	const draft: Draft = {
		strict: false,
		inputs: [],
		stdin: false,
		scan: { threshold: 'medium', all: false },
		walk: { hidden: false, respectIgnore: true },
	};

	for (let index = 0; index < args.length; index++) {
		const arg = args[index] as string;
		if (arg.startsWith('-') && !FLAGS.includes(arg)) {
			throw new Error(`${arg} is not an option. Try --help.`);
		}
		if (arg === '--severity') {
			index += 1;
			const value = args[index];
			if (value === undefined) throw new Error('--severity needs a level');
			draft.scan = { ...draft.scan, threshold: threshold(value) };
			continue;
		}
		const toggle = Object.hasOwn(SWITCHES, arg) ? SWITCHES[arg] : undefined;
		if (toggle) {
			toggle(draft);
			continue;
		}
		draft.inputs = [...draft.inputs, arg];
	}

	if (draft.stdin && draft.inputs.length > 0) {
		throw new Error('reading from stdin takes no file arguments');
	}
	if (!draft.stdin && draft.inputs.length === 0) {
		throw new Error('name a file or a directory to scan. Try --help.');
	}
	return Object.freeze(draft);
}

function threshold(value: string): Threshold {
	if (value === 'high' || value === 'medium') return value;
	if (value === 'low') {
		throw new Error(
			'low is not a threshold: every pattern has a verdict, so it would fail on any file holding a regex at all. Use --all to see them.',
		);
	}
	throw new Error(`${value} is not a severity; one of: high, medium`);
}
