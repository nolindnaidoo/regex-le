//! The tree a real repository actually contains, run against the built
//! binary.
//!
//! Not a fixture directory: Windows cannot check in a FIFO, a symlink
//! loop or a mode-000 file, so the tree is built at runtime and each case
//! the platform cannot express is skipped **by name** on stderr. A
//! skipped case is never reported as a pass.
//!
//! Every case asserts the same floor first: the process does not panic,
//! does not hang, and exits 0, 1 or 2 — never a signal. That floor is
//! the whole point. A scan that dies on `SIGABRT` half way through a
//! tree has no exit code for a pipeline to read and no report for a
//! person to read, and the file that did it is the one file nobody
//! looked at.

use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

const BINARY: &str = env!("CARGO_BIN_EXE_regex-le");
static COUNTER: AtomicUsize = AtomicUsize::new(0);

/// Long enough that a slow shared runner is not mistaken for a hang, and
/// short enough that a hang is caught rather than sat through.
const DEADLINE: Duration = Duration::from_secs(60);

/// A vulnerable pattern, so every document below holds a value the crate
/// should find and a clean read is distinguishable from an empty one.
const FINDING: &str = "const email = /(\\w+)+@/g;\n";

struct Tree {
    root: PathBuf,
}

impl Tree {
    fn new(name: &str) -> Self {
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "regex-le-hazards-{name}-{}-{unique}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("a temporary directory");
        Self {
            root: std::fs::canonicalize(&root).expect("a canonical directory"),
        }
    }

    fn path(&self) -> &Path {
        &self.root
    }

    fn write(&self, relative: &str, bytes: &[u8]) -> PathBuf {
        let target = self.root.join(relative);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).expect("a parent directory");
        }
        std::fs::write(&target, bytes).expect("a file");
        target
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        // A mode-000 file left behind would make the next run fail for a
        // reason that has nothing to do with the code under test.
        #[cfg(unix)]
        restore_permissions(&self.root);
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[cfg(unix)]
fn restore_permissions(root: &Path) {
    use std::os::unix::fs::PermissionsExt as _;
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let _ = std::fs::set_permissions(entry.path(), std::fs::Permissions::from_mode(0o644));
    }
}

struct Run {
    /// `None` when the process was killed by a signal — the failure this
    /// whole file exists to catch.
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

/// Run the binary and come back with what it said, or fail naming the
/// case that hung.
///
/// stdout and stderr are drained on their own threads: polling for exit
/// while the child fills a pipe buffer is its own deadlock, and a test
/// that hangs for the wrong reason teaches nothing.
fn run(case: &str, args: &[&str]) -> Run {
    let mut child = Command::new(BINARY)
        .args(args)
        // Never inherited: a hazard case must not be able to block on a
        // terminal that is not there.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap_or_else(|error| panic!("{case}: the binary runs: {error}"));

    let mut out = child.stdout.take().expect("stdout is piped");
    let mut err = child.stderr.take().expect("stderr is piped");
    let stdout = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = out.read_to_end(&mut buffer);
        buffer
    });
    let stderr = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = err.read_to_end(&mut buffer);
        buffer
    });

    let started = Instant::now();
    let status = loop {
        match child.try_wait().expect("the child is waitable") {
            Some(status) => break status,
            None if started.elapsed() > DEADLINE => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("{case}: still running after {DEADLINE:?} — a hang, not a slow runner");
            }
            None => std::thread::sleep(Duration::from_millis(10)),
        }
    };

    Run {
        code: status.code(),
        stdout: String::from_utf8_lossy(&stdout.join().expect("the reader finishes")).into_owned(),
        stderr: String::from_utf8_lossy(&stderr.join().expect("the reader finishes")).into_owned(),
    }
}

/// The floor every case shares: an answer, not a signal, and one of the
/// three exit codes SPEC.md documents.
fn survives(case: &str, args: &[&str]) -> Run {
    let outcome = run(case, args);
    let Some(code) = outcome.code else {
        panic!(
            "{case}: killed by a signal rather than exiting. stderr:\n{}",
            outcome.stderr
        );
    };
    assert!(
        (0..=2).contains(&code),
        "{case}: exit {code} is not one of 0, 1, 2. stderr:\n{}",
        outcome.stderr
    );
    outcome
}

fn reports(outcome: &Run) -> Vec<serde_json::Value> {
    outcome
        .stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("stdout carries only JSON"))
        .collect()
}

/// Whether the report names this file at all. A binary file has no line;
/// everything else does, including one that could not be read.
fn reported(outcome: &Run, name: &str) -> Option<serde_json::Value> {
    reports(outcome).into_iter().find(|report| {
        report["file"]
            .as_str()
            .is_some_and(|file| file.ends_with(name))
    })
}

/// What a file should be to the scan once it has been read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Shape {
    /// Text, read, and the value in it found.
    Found,
    /// Text, read, and holding nothing to find.
    Empty,
    /// Never a text candidate: no report line, no say in `--strict`.
    Binary,
    /// Looked like text and could not be read: a `skipped` diagnostic,
    /// and `--strict` turns it back into exit 2.
    Undecodable,
    /// Read, and holding a pattern this could not judge: an `incomplete`
    /// diagnostic and exit 2, because reporting nothing found for a scan
    /// that gave up would overstate coverage.
    Refused,
}

fn content_hazards() -> Vec<(&'static str, Vec<u8>, Shape)> {
    let finding = FINDING.as_bytes();
    vec![
        (
            "a-utf8-bom.js",
            [b"\xef\xbb\xbf".as_slice(), finding].concat(),
            Shape::Found,
        ),
        (
            "b-crlf.js",
            FINDING.replace('\n', "\r\n").into_bytes(),
            Shape::Found,
        ),
        (
            "c-lone-cr.js",
            FINDING.replace('\n', "\r").into_bytes(),
            Shape::Found,
        ),
        (
            "d-no-trailing-newline.js",
            FINDING.trim_end().as_bytes().to_vec(),
            Shape::Found,
        ),
        ("e-empty.js", Vec::new(), Shape::Empty),
        (
            "f-whitespace-only.js",
            b"  \t\n \n\t \n".to_vec(),
            Shape::Empty,
        ),
        (
            // A NUL in the first 8 KB is how ripgrep decides a file was
            // never text, and how this decides.
            "g-nul-byte.js",
            [finding, b"\x00 trailing".as_slice()].concat(),
            Shape::Binary,
        ),
        (
            // Latin-1: bytes a String cannot hold, with no NUL among
            // them, so it looked like text and still could not be read.
            "h-invalid-utf8.js",
            [finding, b"// caf\xe9\n".as_slice()].concat(),
            Shape::Undecodable,
        ),
        (
            // Every other byte is NUL, so this is binary by the same
            // rule — the reader learns it was skipped from the count on
            // stderr rather than from a report line.
            "i-utf16le-bom.js",
            [b"\xff\xfe".as_slice(), &utf16le(FINDING)].concat(),
            Shape::Binary,
        ),
        (
            "j-emoji-before-the-value.js",
            format!("const flag = \"\u{1f3af}\"; {FINDING}").into_bytes(),
            Shape::Found,
        ),
        (
            // One line of a megabyte. The slash-versus-division walk
            // looks backwards from every candidate slash, so this is
            // where a quadratic reader stops finishing.
            "k-one-megabyte-line.js",
            format!("{}\n{FINDING}", "/".repeat(1_000_000)).into_bytes(),
            Shape::Found,
        ),
        (
            "l-one-hundred-thousand-lines.js",
            format!("{FINDING}{}", "const x = 1;\n".repeat(100_000)).into_bytes(),
            Shape::Found,
        ),
        (
            // The regression: `regress` parses by recursive descent, and
            // a pattern this deep used to overflow the stack and abort
            // the process. A refusal is an answer; `SIGABRT` is not.
            "m-pattern-nested-ten-thousand-deep.py",
            format!(
                "P = re.compile(r\"{}a{}\")\n",
                "(".repeat(10_000),
                ")".repeat(10_000)
            )
            .into_bytes(),
            Shape::Refused,
        ),
        (
            "n-pattern-of-ten-thousand-alternations.py",
            format!("P = re.compile(r\"{}\")\n", vec!["a"; 10_000].join("|")).into_bytes(),
            Shape::Refused,
        ),
    ]
}

fn utf16le(text: &str) -> Vec<u8> {
    text.encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<u8>>()
}

/// Each hazard alone, so a failure names one file rather than a tree.
#[test]
fn every_content_hazard_is_answered_rather_than_survived() {
    for (name, bytes, shape) in content_hazards() {
        let tree = Tree::new("content");
        tree.write(name, &bytes);
        let root = tree.path().to_string_lossy().to_string();
        let outcome = survives(name, &["--all", &root]);

        let line = reported(&outcome, name);
        match shape {
            Shape::Binary => {
                assert!(line.is_none(), "{name}: a binary file gets no report line");
                assert!(
                    outcome.stderr.contains("1 binary file skipped"),
                    "{name}: counted rather than silent. stderr:\n{}",
                    outcome.stderr
                );
                // A PNG is not a failure to read, so `--strict` leaves
                // it alone — otherwise the flag exits 2 on every
                // repository with an icon in it.
                let strict = survives(name, &["--strict", &root]);
                assert_eq!(strict.code, Some(0), "{name}: --strict is left alone");
            }
            Shape::Undecodable => {
                let line = line.unwrap_or_else(|| panic!("{name}: no report line"));
                assert_eq!(
                    line["diagnostics"][0]["code"], "skipped",
                    "{name}: named rather than vanished"
                );
                let strict = survives(name, &["--strict", &root]);
                assert_eq!(strict.code, Some(2), "{name}: --strict sees it");
            }
            Shape::Found => {
                let line = line.unwrap_or_else(|| panic!("{name}: no report line"));
                assert_eq!(
                    line["summary"]["findings"], 1,
                    "{name}: the value in it was not found"
                );
            }
            Shape::Empty => {
                let line = line.unwrap_or_else(|| panic!("{name}: no report line"));
                assert_eq!(line["summary"]["findings"], 0, "{name}");
            }
            Shape::Refused => {
                let line = line.unwrap_or_else(|| panic!("{name}: no report line"));
                assert_eq!(
                    line["diagnostics"][0]["code"], "incomplete",
                    "{name}: a scan that gave up says so"
                );
                assert_eq!(outcome.code, Some(2), "{name}: a refusal fails the run");
            }
        }
    }
}

/// Three invisible bytes that Notepad, Excel and a PowerShell redirect
/// all add. They must not move a single column, or the two frontends
/// read the same file differently the moment anything on Windows saves
/// it.
#[test]
fn a_byte_order_mark_does_not_move_the_reported_column() {
    let tree = Tree::new("bom");
    tree.write("plain.js", FINDING.as_bytes());
    tree.write(
        "marked.js",
        &[b"\xef\xbb\xbf".as_slice(), FINDING.as_bytes()].concat(),
    );
    let outcome = survives("bom", &["--all", &tree.path().to_string_lossy()]);

    let plain = reported(&outcome, "plain.js").expect("a report line");
    let marked = reported(&outcome, "marked.js").expect("a report line");
    assert_eq!(
        plain["patterns"], marked["patterns"],
        "the mark changed the answer"
    );
}

/// Exit 2 means the *question* was malformed. One unreadable file in
/// fifty thousand is not a malformed question, and a tool that said
/// otherwise never got run in CI at all.
#[test]
fn only_a_malformed_question_exits_two() {
    let tree = Tree::new("exit-two");
    tree.write("ok.js", FINDING.as_bytes());
    tree.write("notes.txt", b"caf\xe9 is not UTF-8");
    tree.write("logo.png", b"\x89PNG\r\n\x1a\n\x00\x00");
    let root = tree.path().to_string_lossy().to_string();

    assert_eq!(
        survives("unreadable files", &["--all", &root]).code,
        Some(1),
        "an unreadable file is reported, not a refusal"
    );
    assert_eq!(
        survives("an unknown flag", &["--sever", &root]).code,
        Some(2)
    );
    assert_eq!(
        survives("a path that does not exist", &[&format!("{root}/nope")]).code,
        Some(2)
    );
}

/// The filesystem half. Each case the running platform cannot express
/// says so by name rather than passing quietly.
#[test]
fn the_walk_survives_every_filesystem_hazard() {
    let tree = Tree::new("filesystem");
    tree.write("real.js", FINDING.as_bytes());
    tree.write("with spaces.js", FINDING.as_bytes());
    tree.write("ünïcode.js", FINDING.as_bytes());
    tree.write("🎯.js", FINDING.as_bytes());
    // A directory wearing a file's name. The walk must read the type,
    // not the extension.
    std::fs::create_dir_all(tree.path().join("config.json")).expect("a directory");

    symlinks(&tree);
    let fifo = fifo(&tree);
    let denied = permission_denied(&tree);
    let long_path = long_path(&tree);

    let root = tree.path().to_string_lossy().to_string();
    let outcome = survives("the whole hazardous tree", &["--all", &root]);

    for name in ["real.js", "with spaces.js", "ünïcode.js", "🎯.js"] {
        let line = reported(&outcome, name).unwrap_or_else(|| panic!("{name}: no report line"));
        assert_eq!(line["summary"]["findings"], 1, "{name}");
    }
    assert!(
        reported(&outcome, "config.json").is_none(),
        "a directory named config.json was read as a file"
    );

    if denied {
        let strict = survives("a permission-denied file", &["--strict", &root]);
        assert_eq!(strict.code, Some(2), "an unreadable file reaches --strict");
    }
    if let Some(path) = long_path {
        let named = survives("a path over 260 characters", &["--all", &path]);
        assert_eq!(named.code, Some(1), "{}", named.stderr);
    }
    if let Some(path) = fifo {
        // Named explicitly rather than walked to: the walk skips
        // anything that is not a file, so a FIFO only reaches the scan
        // when someone asks for it, and it must not block there.
        let named = survives("a FIFO named explicitly", &["--all", &path]);
        assert!(
            named.code.is_some_and(|code| (0..=2).contains(&code)),
            "a FIFO must answer rather than block"
        );
    }
}

/// A symlink to a file, a broken one, and a loop. Links are never
/// followed — one out of the tree would have the scan reading files the
/// caller did not point it at — so the assertion is that the walk
/// finishes, not that they appear.
fn symlinks(tree: &Tree) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::symlink;
        let _ = symlink("real.js", tree.path().join("link.js"));
        let _ = symlink("nowhere.js", tree.path().join("broken.js"));
        let _ = symlink("loop-b", tree.path().join("loop-a"));
        let _ = symlink("loop-a", tree.path().join("loop-b"));
    }
    #[cfg(not(unix))]
    {
        let _ = tree;
        eprintln!("SKIPPED symlinks: creating one on Windows needs a privilege CI does not grant");
    }
}

/// A FIFO blocks its reader until a writer arrives, which is the shape
/// of a hang. Windows has no `mkfifo`.
fn fifo(tree: &Tree) -> Option<String> {
    #[cfg(unix)]
    {
        let path = tree.path().join("pipe.js");
        // Made by the tool that exists for it: `unsafe` is forbidden
        // crate-wide, so calling `mkfifo(2)` directly is not on offer.
        let made = Command::new("mkfifo")
            .arg(path.as_os_str())
            .status()
            .is_ok_and(|status| status.success());
        if !made {
            eprintln!("SKIPPED a FIFO: mkfifo is not available here");
            return None;
        }
        Some(path.to_string_lossy().into_owned())
    }
    #[cfg(not(unix))]
    {
        let _ = tree;
        eprintln!("SKIPPED a FIFO: Windows has no named pipe in the filesystem namespace");
        None
    }
}

/// A file the process may not read. Skipped when the process can read it
/// anyway, which is what running as root looks like.
fn permission_denied(tree: &Tree) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let path = tree.write("denied.js", FINDING.as_bytes());
        if std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).is_err() {
            eprintln!("SKIPPED a permission-denied file: the mode would not take");
            return false;
        }
        if std::fs::read(&path).is_ok() {
            eprintln!("SKIPPED a permission-denied file: this user reads mode 000 (root?)");
            let _ = std::fs::remove_file(&path);
            return false;
        }
        true
    }
    #[cfg(not(unix))]
    {
        let _ = tree;
        eprintln!("SKIPPED a permission-denied file: a mode-000 file is a POSIX idea");
        false
    }
}

/// A path over 260 characters — the length Windows refuses without long
/// paths enabled, and the one place the three platforms genuinely differ.
fn long_path(tree: &Tree) -> Option<String> {
    let nested: PathBuf = (0..20).map(|level| format!("d{level:02}")).collect();
    let name = format!("{}.js", "n".repeat(180));
    let relative = nested.join(name);
    let target = tree.path().join(&relative);
    if let Some(parent) = target.parent()
        && std::fs::create_dir_all(parent).is_err()
    {
        eprintln!("SKIPPED a path over 260 characters: the directories would not be created");
        return None;
    }
    if std::fs::write(&target, FINDING.as_bytes()).is_err() {
        eprintln!(
            "SKIPPED a path over 260 characters: this filesystem refuses one \
             (Windows without long paths enabled)"
        );
        return None;
    }
    assert!(
        target.to_string_lossy().chars().count() > 260,
        "the long path is not long"
    );
    Some(target.to_string_lossy().into_owned())
}
