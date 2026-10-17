# regex-le

Find every regular expression in a codebase and report which of them can be
driven into catastrophic backtracking, with the input that proves it: the
review of a pull request that adds a validator, the CI gate on a service
that matches user input, the audit before a regex reaches a hot path.

```bash
npx regex-le src/
npx regex-le --all . > patterns.jsonl
cat validate.py | npx regex-le --stdin
```

The command it installs is `regex-le`, the same command line as the Rust
crate [`regex-le`](https://crates.io/crates/regex-le), and it behaves
identically: same flags, same walk, same verdicts, same witnesses, same
output, same exit codes. Install whichever toolchain you already have.

## What it reads

JavaScript and TypeScript literals and `RegExp` constructors, and the call
sites Python, Rust, Go, Java, Ruby, PHP and C# write a pattern at. A
pattern in a comment or a string is prose, not code, and is not reported.
Directories are walked the way ripgrep walks them: `.gitignore`, `.ignore`
and hidden files are respected unless you pass `--no-ignore` or `--hidden`.

**Your pattern is never run.** A pattern is reported only when an input was
found that demonstrably drives it into backtracking, and that input is
reported with it as the witness, so the finding can be checked. A pattern
this cannot read, such as one with a backreference or lookaround, is
reported as undecided, never as safe.

## Output

stdout carries one JSON report per file whenever it is piped or redirected,
and nothing when it is a terminal. stderr lists every finding.

```text
$ regex-le src
src/app.js:1:14  /(a+)+b/  [high] exponential backtracking: 2000000 steps on 41 characters, against 229328 on 20  witness "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\0"
src/check.py:2:1  /(\w+\s?)*$/  [high] exponential backtracking: 2000000 steps on 41 characters, against 360385 on 20  witness "0000000000000000000000000000000000000000\0"
2 findings in 2 files
```

`--all` reports every pattern, not only the vulnerable ones. Columns count
UTF-16 code units, as an editor does.

A text file that is not UTF-8, or that cannot be opened, is named on stderr
and carried in its report as `skipped`. A binary file is counted and not
reported.

## Exit codes

- **0**: nothing vulnerable.
- **1**: at least one finding.
- **2**: the question was malformed, a directory could not be walked, or a
  pattern could not be judged.

## For agents

`regex-le mcp` serves the Model Context Protocol on stdio with two tools:
`extract_patterns` for a document's text and `regex_le_lint` for files and
directories. Hosts that want the document tool alone can install
[`regex-le-mcp`](https://www.npmjs.com/package/regex-le-mcp).

`regex-le --help` lists every option.

MIT licensed. Part of [letools](https://letools.dev/tools/regex-le).
