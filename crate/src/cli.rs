//! The terminal surface.
//!
//! stdout is always protocol — one JSON report per line, one line per
//! file. stderr is always for the human, and is a projection of the same
//! reports rather than parallel prose.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::ExitCode;

use crate::detect::redos::Severity;
use crate::scan::{self, FileReport, ScanOptions};
use crate::walk::{self, WalkOptions};

const USAGE: &str = "usage: regex-le [options] <file|dir>...
       regex-le [options] --stdin
       regex-le mcp
       regex-le --version | --help

Finds every regular expression in a tree and reports which of them can be
driven into catastrophic backtracking. Nothing is executed: the verdict
comes from the shape of the pattern text, never from running it.

It flags shapes; it cannot prove a pattern safe. A pattern it does not
recognise may still backtrack badly on adversarial input.

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
question was malformed.";

/// Every flag the parser accepts. Held equal to the flags named in USAGE
/// by a test, and consulted at runtime so the list is what the parser
/// actually honours.
const FLAGS: [&str; 6] = [
    "--severity",
    "--all",
    "--stdin",
    "--strict",
    "--hidden",
    "--no-ignore",
];

/// The thresholds `--severity` accepts. `low` is deliberately absent:
/// every pattern has a verdict, so a `low` threshold fails on every file
/// that contains a regex at all.
const THRESHOLDS: [&str; 2] = ["high", "medium"];

#[derive(Debug)]
struct Options {
    /// Fail the run if any file could not be read.
    strict: bool,
    inputs: Vec<PathBuf>,
    stdin: bool,
    scan: ScanOptions,
    walk: WalkOptions,
}

pub(crate) fn run() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();

    if let Some(first) = args.first() {
        match first.as_str() {
            "mcp" => return crate::mcp::serve(),
            "--help" | "-h" => {
                println!("{USAGE}");
                return ExitCode::SUCCESS;
            }
            "--version" | "-V" => {
                println!("regex-le {}", env!("CARGO_PKG_VERSION"));
                return ExitCode::SUCCESS;
            }
            _ => {}
        }
    }

    match execute(&args) {
        Ok(code) => ExitCode::from(code),
        Err(message) => {
            eprintln!("regex-le: {message}");
            ExitCode::from(2)
        }
    }
}

fn execute(args: &[String]) -> Result<u8, String> {
    let options = parse(args)?;
    let (reports, binary) = if options.stdin {
        (vec![scan_stdin(options.scan)?], 0)
    } else {
        let walked = walk::collect(&options.inputs, &options.walk)?;
        let reports: Vec<FileReport> = walked
            .files
            .iter()
            .filter_map(|target| scan::scan_file(target, options.scan))
            .collect();
        let binary = walked.files.len() - reports.len();
        (reports, binary)
    };

    let mut stdout = std::io::stdout().lock();
    for report in &reports {
        let line = serde_json::to_string(report).expect("a report serializes");
        writeln!(stdout, "{line}")
            .map_err(|error| format!("could not write the report: {error}"))?;
    }
    drop(stdout);

    summarise(&reports, binary);
    Ok(scan::exit_code(&reports, options.strict))
}

fn scan_stdin(options: ScanOptions) -> Result<FileReport, String> {
    let mut content = String::new();
    std::io::stdin()
        .read_to_string(&mut content)
        .map_err(|error| format!("could not read stdin: {error}"))?;
    // A document arriving on a pipe has no name and no language, so
    // every form is scanned for. It is still a document read off a disk
    // somewhere, so the byte-order mark goes the same way it does for a
    // file read: leaving it in shifted every column on the first line by
    // one, which made `cat x.js | regex-le --stdin` and `regex-le x.js`
    // report different positions for the same pattern.
    Ok(scan::scan_content(
        scan::without_bom(&content),
        "<stdin>".to_string(),
        None,
        options,
    ))
}

fn parse(args: &[String]) -> Result<Options, String> {
    let mut options = Options {
        inputs: Vec::new(),
        stdin: false,
        strict: false,
        scan: ScanOptions::default(),
        walk: WalkOptions::default(),
    };

    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        // Strict parsing, never a silent default: a typo'd `--all` that
        // quietly did nothing would produce a report the caller believed
        // was complete.
        if arg.starts_with('-') && !FLAGS.contains(&arg.as_str()) {
            return Err(format!("{arg} is not an option. Try --help."));
        }

        match arg.as_str() {
            "--all" => options.scan.all = true,
            "--stdin" => options.stdin = true,
            "--strict" => options.strict = true,
            "--hidden" => options.walk.hidden = true,
            "--no-ignore" => options.walk.respect_ignore = false,
            "--severity" => {
                let value = rest
                    .next()
                    .ok_or_else(|| "--severity needs a level".to_string())?;
                options.scan.threshold = threshold(value)?;
            }
            path => options.inputs.push(PathBuf::from(path)),
        }
    }

    if options.stdin && !options.inputs.is_empty() {
        return Err("reading from stdin takes no file arguments".to_string());
    }
    if !options.stdin && options.inputs.is_empty() {
        return Err("name a file or a directory to scan. Try --help.".to_string());
    }
    Ok(options)
}

fn threshold(value: &str) -> Result<Severity, String> {
    match value {
        "high" => Ok(Severity::High),
        "medium" => Ok(Severity::Medium),
        // Named rather than lumped in with the typos: someone asking for
        // `low` has a reasonable idea, and the refusal says why it is
        // not on offer instead of pretending the word is unknown.
        "low" => Err(
            "low is not a threshold: every pattern has a verdict, so it would fail on any file \
             holding a regex at all. Use --all to see them."
                .to_string(),
        ),
        other => Err(format!(
            "{other} is not a severity; one of: {}",
            THRESHOLDS.join(", ")
        )),
    }
}

/// The human half. Every line restates something already in the JSON —
/// except the binary count, which has no report line by design and is
/// the only place a reader learns the walk covered less than the tree.
fn summarise(reports: &[FileReport], binary: usize) {
    let mut stderr = std::io::stderr().lock();
    let mut findings = 0;

    for report in reports {
        for diagnostic in &report.diagnostics {
            let _ = writeln!(stderr, "{}: {}", report.file, diagnostic.message);
        }
        for pattern in &report.patterns {
            let _ = writeln!(stderr, "{}", scan::describe(report, pattern));
        }
        findings += report.summary.findings;
    }

    let binary_note = if binary == 0 {
        String::new()
    } else {
        format!(
            ", {} skipped",
            plural(binary, "binary file", "binary files")
        )
    };
    let _ = writeln!(
        stderr,
        "{} in {}{binary_note}",
        plural(findings, "finding", "findings"),
        plural(reports.len(), "file", "files")
    );
}

fn plural(count: usize, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_documented_flag_is_parsed_and_the_reverse() {
        let mut documented: Vec<&str> = USAGE
            .split_whitespace()
            .filter(|word| word.starts_with("--"))
            .map(|word| word.trim_end_matches([',', '.', ':', ';']))
            .filter(|word| !matches!(*word, "--version" | "--help"))
            .collect();
        documented.sort_unstable();
        documented.dedup();

        let mut implemented = FLAGS.to_vec();
        implemented.sort_unstable();
        assert_eq!(documented, implemented);
    }

    #[test]
    fn the_parser_accepts_every_flag_it_lists() {
        for flag in FLAGS {
            let args: Vec<String> = match flag {
                "--severity" => vec![flag.into(), "high".into(), "x".into()],
                "--stdin" => vec![flag.into()],
                _ => vec![flag.into(), "x".into()],
            };
            assert!(parse(&args).is_ok(), "{flag}");
        }
    }

    /// Every threshold the usage text offers is one the parser takes.
    #[test]
    fn every_documented_threshold_is_accepted() {
        for level in THRESHOLDS {
            assert!(threshold(level).is_ok(), "{level}");
            assert!(USAGE.contains(level), "{level} is undocumented");
        }
    }

    #[test]
    fn an_unknown_flag_is_refused_rather_than_ignored() {
        let error = parse(&["--sever".into(), "x".into()]).expect_err("a refusal");
        assert!(error.contains("--sever"), "{error}");
    }

    #[test]
    fn low_is_refused_with_its_reason() {
        let error = threshold("low").expect_err("a refusal");
        assert!(error.contains("--all"), "{error}");
        assert!(!USAGE.contains("low"), "the usage text offers low");
    }

    #[test]
    fn an_unknown_severity_is_refused_by_name() {
        let error = threshold("critical").expect_err("a refusal");
        assert!(error.contains("critical"), "{error}");
    }

    /// The tester half is not here, and no flag may suggest it is.
    #[test]
    fn no_flag_offers_to_run_a_pattern() {
        for attempt in ["--test", "--match", "--input", "--timeout", "--fix"] {
            assert!(
                parse(&[attempt.into(), "x".into()]).is_err(),
                "{attempt} was accepted"
            );
        }
    }

    #[test]
    fn naming_nothing_is_refused() {
        assert!(parse(&[]).is_err());
    }

    #[test]
    fn stdin_and_file_arguments_together_are_refused() {
        assert!(parse(&["--stdin".into(), "x".into()]).is_err());
    }

    #[test]
    fn the_default_threshold_is_medium() {
        let options = parse(&["x".into()]).expect("options");
        assert_eq!(options.scan.threshold, Severity::Medium);
    }

    #[test]
    fn the_usage_text_states_it_proves_nothing_safe() {
        assert!(USAGE.contains("cannot prove"), "the scope is unstated");
        for code in ["0", "1", "2"] {
            assert!(USAGE.contains(code), "exit code {code} is undocumented");
        }
    }
}
