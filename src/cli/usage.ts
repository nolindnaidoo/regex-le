/**
 * The command line's help text and the flags it names.
 *
 * Word for word the Rust CLI's, because both install as `regex-le` and a
 * person reading `--help` cannot tell which one they have.
 * `scripts/check-cli-parity.ts` compares the two outputs, and `cli.test.ts`
 * holds FLAGS equal to the flags this text names.
 */

export const USAGE = `usage: regex-le [options] <file|dir>...
       regex-le [options] --stdin
       regex-le mcp
       regex-le --version | --help

Finds every regular expression in a tree and reports which of them can be
driven into catastrophic backtracking. A pattern is reported only when an
input was found that demonstrably drives it there, and that input is
reported with it as the witness — a finding you can check yourself.

One JSON report per line on stdout when it is piped or redirected, every
finding listed on stderr.

Your pattern is never run. The demonstration walks an automaton built
from the pattern text, under a step budget, and counts.

Silence is not a clearance. A pattern this cannot read — a backreference,
lookaround, syntax it does not parse — is reported as undecided, never as
safe.

Options:
  --severity <level>   high or medium, both accepted and now equivalent:
                       a pattern either has a demonstrated witness or it
                       has none, so there is no middle tier to select.
                       Kept so existing pipelines keep running
                       (default medium)
  --all                report every pattern, not only the vulnerable ones
  --strict             exit 2 if any text file could not be read, rather
                       than reporting it and carrying on. Binary files
                       are counted, never reported, and never counted
                       here
  --stdin              read one document from stdin
  --hidden             walk hidden files and directories too
  --no-ignore          walk files that .gitignore excludes

Exit codes: 0 nothing vulnerable · 1 at least one finding · 2 the
question was malformed.`;

export const FLAGS: readonly string[] = Object.freeze([
	'--severity',
	'--all',
	'--stdin',
	'--strict',
	'--hidden',
	'--no-ignore',
]);
