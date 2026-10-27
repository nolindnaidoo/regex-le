/**
 * stdout and stderr as the crate treats them, and the exit after them.
 *
 * The crate writes every report to stdout before any of the listing on
 * stderr. A reader that closes stdout early fails the run with one line on
 * stderr and exit 2, and the listing never follows. One that closes stderr
 * early loses only the listing, and the run finishes as it would have.
 */
import { rustIoMessage } from './ioError';

export interface Output {
	/** False once the pipe is full, as the stream's own `write` answers. */
	readonly stdout: (text: string) => boolean;
	readonly stderr: (text: string) => void;
	/**
	 * Exit once both streams have drained. `refusal` is what the crate says
	 * before the OS error when stdout failed, or null where it says nothing,
	 * as its MCP server does.
	 */
	readonly exit: (code: number, refusal: string | null) => void;
}

export function crateOutput(
	name: string,
	stdout: NodeJS.WritableStream = process.stdout,
	stderr: NodeJS.WritableStream = process.stderr,
	exit: (code: number) => void = process.exit,
): Output {
	let failure: unknown = null;
	const fail = (error: unknown) => {
		failure ??= error;
	};
	stdout.on('error', fail);
	stderr.on('error', () => {});

	return Object.freeze({
		stdout: (text: string) =>
			failure === null && stdout.write(text, (error) => error && fail(error)),
		// Queued behind every report already written, so nothing reaches stderr
		// ahead of stdout, and nothing at all once stdout has failed.
		stderr: (text: string) => {
			stdout.write('', (error) => {
				if (error) fail(error);
				if (failure === null) stderr.write(text);
			});
		},
		exit: (code: number, refusal: string | null) => {
			exitWhenDrained([stdout, stderr], () => {
				if (failure === null) return exit(code);
				if (refusal === null) return exit(2);
				stderr.write(`${name}: ${refusal}: ${rustIoMessage(failure)}\n`, () =>
					exit(2),
				);
			});
		},
	});
}

/**
 * `process.exit` drops whatever a pipe has not yet taken, and on macOS and
 * Windows stdout and stderr are pipes that write asynchronously. Waiting on
 * stdout alone cut off the end of the stderr listing and its summary line
 * whenever the reader was slower than the writer. The streams drain in
 * order, because draining stdout is what releases the stderr queued behind
 * it.
 */
export function exitWhenDrained(
	streams: readonly NodeJS.WritableStream[],
	then: () => void,
): void {
	const [first, ...rest] = streams;
	if (first === undefined) {
		then();
		return;
	}
	first.write('', () => exitWhenDrained(rest, then));
}
