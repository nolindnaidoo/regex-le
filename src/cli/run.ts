/**
 * The terminal surface, as the Rust CLI's `cli.rs` runs it.
 *
 * stdout is protocol: one JSON report per line whenever something is reading
 * it, and nothing when it is a terminal, because the stderr listing already
 * shows every finding a person reads there.
 */
import { type Cli, parse } from './args';
import { decodeUtf8OrThrow, rustIoMessage, withoutBom } from './ioError';
import {
	describe,
	exitCode,
	type FileReport,
	scanContent,
	scanFile,
} from './scan';
import { USAGE } from './usage';
import { collect } from './walk';

export interface RunIo {
	readonly stdout: (text: string) => void;
	readonly stderr: (text: string) => void;
	readonly stdoutIsTerminal: boolean;
	readonly readStdin: () => Promise<Uint8Array>;
	readonly version: string;
}

export async function run(args: readonly string[], io: RunIo): Promise<number> {
	const first = args[0];
	if (first === '--help' || first === '-h') {
		io.stdout(`${USAGE}\n`);
		return 0;
	}
	if (first === '--version' || first === '-V') {
		io.stdout(`regex-le ${io.version}\n`);
		return 0;
	}
	try {
		return await execute(parse(args), io);
	} catch (error) {
		io.stderr(
			`regex-le: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		return 2;
	}
}

async function execute(cli: Cli, io: RunIo): Promise<number> {
	let reports: FileReport[];
	let binary = 0;
	if (cli.stdin) {
		let content: string;
		try {
			content = decodeUtf8OrThrow(await io.readStdin());
		} catch (error) {
			throw new Error(`could not read stdin: ${rustIoMessage(error)}`);
		}
		reports = [
			scanContent(withoutBom(content), '<stdin>', undefined, cli.scan),
		];
	} else {
		const files = collect(cli.inputs, cli.walk);
		reports = [];
		for (const file of files) {
			const scanned = scanFile(file, cli.scan);
			if (scanned) reports.push(scanned);
		}
		binary = files.length - reports.length;
	}

	if (!io.stdoutIsTerminal) {
		io.stdout(reports.map((each) => `${JSON.stringify(each)}\n`).join(''));
	}
	io.stderr(summary(reports, binary));
	return exitCode(reports, cli.strict);
}

export function summary(
	reports: readonly FileReport[],
	binary: number,
): string {
	const lines: string[] = [];
	let findings = 0;
	for (const each of reports) {
		for (const diagnostic of each.diagnostics)
			lines.push(`${each.file}: ${diagnostic.message}`);
		for (const pattern of each.patterns) lines.push(describe(each, pattern));
		findings += each.summary.findings;
	}
	const binaryNote =
		binary === 0
			? ''
			: `, ${plural(binary, 'binary file', 'binary files')} skipped`;
	lines.push(
		`${plural(findings, 'finding', 'findings')} in ${plural(reports.length, 'file', 'files')}${binaryNote}`,
	);
	return `${lines.join('\n')}\n`;
}

function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}
