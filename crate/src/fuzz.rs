//! A standing net over the pure layer.
//!
//! This crate reads regex literals out of source in nine grammars and
//! judges whether they can be driven into catastrophic backtracking.
//! The irony is the point: **a `ReDoS` scanner can itself be driven
//! into catastrophic backtracking.**
//! The extractor runs `fancy-regex` over whole documents and the
//! slash-versus-division heuristic walks backwards through text, so a
//! megabyte of slashes, ten thousand alternations or a pattern nested a
//! thousand deep are all inputs somebody will eventually feed it — one
//! of them by accident, one of them on purpose.
//!
//! What counts as a failure: a panic, a hang, a slice that lands inside
//! a character, a position outside the document, or a reported pattern
//! carrying a verdict that says it was never a pattern.
//!
//! **Two carve-outs from the testing rules in AGENTS.md, both here and
//! nowhere else.** A fuzzer needs a generator, so this one is seeded and
//! prints its seed — pin it with `REGEX_LE_FUZZ_SEED` and a failure
//! reproduces exactly. A hang is only visible against a clock, so the
//! pathological cases are timed; every bound is an order of magnitude
//! above the measured cost, which catches a hang without flaking on a
//! shared runner.
//!
//! Time-boxed rather than run to convergence: `REGEX_LE_FUZZ_SECONDS`
//! sets the budget per target, defaulting low enough that `cargo test`
//! stays quick. CI gives it sixty seconds.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::time::{Duration, Instant};

use crate::detect::corpus;
use crate::detect::extract::extract_patterns;
use crate::detect::format::Language;
use crate::detect::heuristics;
use crate::detect::redos::detect_redos;

const LANGUAGES: [Option<Language>; 10] = [
    None,
    Some(Language::JavaScript),
    Some(Language::TypeScript),
    Some(Language::Python),
    Some(Language::Rust),
    Some(Language::Go),
    Some(Language::Java),
    Some(Language::Ruby),
    Some(Language::Php),
    Some(Language::CSharp),
];

/// The characters a mutation splices in: the metacharacters that change
/// how a pattern parses, the quotes and brackets that change where a
/// string ends, and a few multi-byte characters, because a slice that
/// lands inside one of those is how the sibling crate learnt about
/// `SIGABRT`.
const INTERESTING: [char; 34] = [
    '(', ')', '[', ']', '{', '}', '|', '*', '+', '?', '\\', '/', '"', '\'', '`', '@', '#', '~',
    '<', '>', ':', ',', '.', '$', '^', '-', '=', ' ', '\n', '\r', '\0', 'é', '🎯', '\u{feff}',
];

/// A seeded generator. Sixteen lines beats a dependency, and a fuzzer
/// whose seed is printed is one whose failure can be reproduced.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*, chosen for being short enough to read.
        let mut state = self.0;
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        self.0 = state;
        state.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    fn below(&mut self, limit: usize) -> usize {
        if limit == 0 {
            return 0;
        }
        (self.next() % limit as u64) as usize
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }
}

/// The budget for one target, and the seed both targets start from.
fn budget() -> Duration {
    let seconds = std::env::var("REGEX_LE_FUZZ_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(2);
    Duration::from_secs(seconds)
}

fn seed() -> u64 {
    std::env::var("REGEX_LE_FUZZ_SEED")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0x5EED_2026_0812)
}

/// Mutate one seed document into something adjacent to it.
///
/// Operations are deliberately blunt: splice an interesting character
/// in, delete a run, duplicate a run, or repeat the whole thing. Each is
/// a shape a real file can have, and repetition is how the pathological
/// cases get reached from an ordinary starting point.
fn mutate(rng: &mut Rng, source: &str) -> String {
    let mut characters: Vec<char> = source.chars().collect();
    let rounds = 1 + rng.below(8);
    for _ in 0..rounds {
        if characters.is_empty() {
            characters.push(*rng.pick(&INTERESTING));
            continue;
        }
        let at = rng.below(characters.len());
        match rng.below(6) {
            0 => characters.insert(at, *rng.pick(&INTERESTING)),
            1 => {
                characters.remove(at);
            }
            2 => characters[at] = *rng.pick(&INTERESTING),
            3 => {
                // Duplicate a run, which is how a document grows a
                // thousand of anything.
                let end = (at + 1 + rng.below(64)).min(characters.len());
                let run: Vec<char> = characters[at..end].to_vec();
                let times = 1 + rng.below(40);
                for _ in 0..times {
                    let insert_at = at.min(characters.len());
                    characters.splice(insert_at..insert_at, run.iter().copied());
                }
            }
            4 => characters.truncate(at),
            _ => {
                let run: Vec<char> = characters[at..].to_vec();
                characters.extend(run);
            }
        }
        // A mutation that runs away costs the whole budget on one case.
        characters.truncate(200_000);
    }
    characters.into_iter().collect()
}

/// Run one case, turning a panic into a failure that names the input.
///
/// Without this a panic inside the detection layer reports a line number
/// in a library and nothing about the document that reached it, which is
/// a red build somebody reruns rather than reads.
fn attempt<T>(label: &str, input: &str, work: impl FnOnce() -> T) -> T {
    let outcome = catch_unwind(AssertUnwindSafe(work));
    outcome.unwrap_or_else(|_| {
        panic!(
            "{label} panicked. seed {}, input ({} chars): {:?}",
            seed(),
            input.chars().count(),
            excerpt(input)
        )
    })
}

/// Enough of the input to recognise it, and not so much that the log is
/// a megabyte of slashes.
fn excerpt(input: &str) -> String {
    let head: String = input.chars().take(200).collect();
    if head.chars().count() < input.chars().count() {
        return format!("{head}… ({} chars total)", input.chars().count());
    }
    head
}

/// Everything a report must be true of, whatever the input was.
fn check_report(input: &str, language: Option<Language>) {
    let Ok(patterns) = attempt("extract_patterns", input, || {
        extract_patterns(input, language)
    }) else {
        // A refusal is a legitimate answer — the scan said it could not
        // finish rather than reporting a clean file.
        return;
    };

    for found in &patterns {
        assert!(
            found.line >= 1 && found.column >= 1,
            "a position outside the document: {}:{} for {:?} in {:?}",
            found.line,
            found.column,
            found.pattern,
            excerpt(input)
        );
        assert!(
            input.contains(found.matched.as_str()),
            "the matched text is not in the document: {:?} in {:?}",
            found.matched,
            excerpt(input)
        );
        // Extraction drops what does not parse, so nothing that reaches
        // a report may carry the verdict that says it never parsed. This
        // is the invariant the JavaScript rendering exists to hold: a
        // Python or Go pattern is judged on its shape, never called a
        // syntax error.
        assert_ne!(
            found.redos.reason,
            "Pattern is invalid",
            "a reported pattern carries the syntax-error verdict: {:?} in {:?}",
            found.pattern,
            excerpt(input)
        );
    }
}

/// The extractor, over mutations of the shared corpus.
#[test]
fn extraction_answers_or_refuses_whatever_it_is_given() {
    let mut rng = Rng(seed());
    let deadline = Instant::now() + budget();
    let seeds = corpus::documents();
    let mut cases = 0_u64;

    while Instant::now() < deadline {
        let (_, source) = rng.pick(seeds);
        let input = mutate(&mut rng, source);
        let language = *rng.pick(&LANGUAGES);
        check_report(&input, language);
        cases += 1;
    }
    eprintln!("extraction: {cases} cases from seed {}", seed());
    assert!(cases > 0, "the budget ran out before a single case");
}

/// The `ReDoS` analyser and the heuristics under it, over mutations of
/// the pattern text rather than of a document.
#[test]
fn the_analyser_answers_whatever_pattern_it_is_given() {
    const PATTERNS: [&str; 12] = [
        "(a+)+",
        "(a|ab)+",
        r"^\d{4}-\d{2}-\d{2}$",
        r"(?P<year>\d{4})",
        "(?i)^[a-z]+$",
        "(?>a+)b",
        "a{2,}+",
        "(?#note)b",
        "[(]+",
        r"\(a+\)+",
        "(?<name>a|b)*",
        "",
    ];
    const FLAGS: [&str; 6] = ["", "g", "gi", "dgimsuvy", "zz", "gg"];

    let mut rng = Rng(seed() ^ 0x9E37_79B9);
    let deadline = Instant::now() + budget();
    let mut cases = 0_u64;

    while Instant::now() < deadline {
        let source = *rng.pick(&PATTERNS);
        let pattern = mutate(&mut rng, source);
        let flags = *rng.pick(&FLAGS);

        let verdict = attempt("detect_redos", &pattern, || detect_redos(&pattern, flags));
        assert!(
            !verdict.reason.is_empty(),
            "a verdict with no reason for {:?}",
            excerpt(&pattern)
        );
        attempt("is_well_formed", &pattern, || {
            heuristics::is_well_formed(&pattern, flags)
        });
        attempt("is_valid_flag_string", &pattern, || {
            heuristics::is_valid_flag_string(&pattern)
        });

        // Offsets are deliberately unaligned: `is_regex_context` slices
        // the text before a candidate slash, and an offset landing
        // inside a multi-byte character is exactly the shape that killed
        // a sibling crate with a signal.
        for _ in 0..4 {
            let offset = rng.below(pattern.len() + 4);
            attempt("is_regex_context", &pattern, || {
                heuristics::is_regex_context(&pattern, offset);
            });
        }
        cases += 1;
    }
    eprintln!("analyser: {cases} cases from seed {}", seed());
    assert!(cases > 0, "the budget ran out before a single case");
}

/// The inputs written on purpose rather than stumbled into: a scanner
/// for catastrophic backtracking that can be made to backtrack
/// catastrophically is the joke that writes itself.
///
/// Every bound below is an order of magnitude above what the shapes
/// actually cost here, so this catches a hang rather than a slow runner.
///
/// The bounds describe the **release** binary, which is what anyone
/// runs. `cargo test` builds unoptimized, and the gap is not small: a
/// megabyte of slashes is 490ms release and 6.4s debug on this machine,
/// and 23.5s on a shared CI runner — enough to fail a 20s bound and
/// claim the scanner hangs when the shipped artifact answers in half a
/// second. `DEBUG_SCALE` keeps the assertion meaningful in both builds
/// rather than deleting it in one; it is deliberately generous, because
/// this test exists to catch a hang, not to measure a runner.
#[cfg(debug_assertions)]
const DEBUG_SCALE: u32 = 8;
#[cfg(not(debug_assertions))]
const DEBUG_SCALE: u32 = 1;

#[test]
fn a_scanner_for_backtracking_cannot_itself_be_made_to_hang() {
    let deep = format!("{}a{}", "(".repeat(20_000), ")".repeat(20_000));
    let cases: [(&str, String, Duration); 12] = [
        (
            "a megabyte of slashes",
            "/".repeat(1_000_000),
            Duration::from_secs(20),
        ),
        (
            "a megabyte of slashes with a division between each",
            "a / b ".repeat(160_000),
            Duration::from_secs(20),
        ),
        (
            "ten thousand alternations in one pattern",
            format!("const p = /({})+/;", vec!["a"; 10_000].join("|")),
            Duration::from_secs(20),
        ),
        (
            "a pattern nested twenty thousand deep",
            format!("const p = /{deep}/;"),
            Duration::from_secs(20),
        ),
        (
            "the same, at a call site",
            format!("P = re.compile(r\"{deep}\")"),
            Duration::from_secs(20),
        ),
        (
            "eight hundred kilobytes on one line",
            "const a = /x/g; const b = total / count; ".repeat(20_000),
            Duration::from_secs(20),
        ),
        (
            "fifty thousand open braces in one group",
            format!("const p = /({})+/;", "{".repeat(50_000)),
            Duration::from_secs(20),
        ),
        (
            "twenty thousand groups at depth one",
            format!("const p = /{}+/;", "(a)".repeat(20_000)),
            Duration::from_secs(20),
        ),
        // A string nobody closes is where a sibling crate spent twenty
        // seconds: every opener queued a re-read of the rest of the
        // file. These forms all end in a lazy or greedy body that has to
        // give up at end of input, five thousand times over on one line.
        (
            "five thousand unterminated Python triple quotes",
            format!("{}\n", r#"re.compile("""x"#.repeat(5_000)),
            Duration::from_secs(20),
        ),
        (
            "five thousand unterminated Rust raw strings",
            format!("{}\n", r#"Regex::new(r#"x"#.repeat(5_000)),
            Duration::from_secs(20),
        ),
        (
            "five thousand unterminated Go backquotes",
            format!("{}\n", "regexp.MustCompile(`x".repeat(5_000)),
            Duration::from_secs(20),
        ),
        (
            "five thousand unterminated constructors",
            format!("{}\n", "new RegExp('x".repeat(5_000)),
            Duration::from_secs(20),
        ),
    ];

    for (name, input, bound) in cases {
        let bound = bound * DEBUG_SCALE;
        let started = Instant::now();
        for language in LANGUAGES {
            check_report(&input, language);
        }
        let elapsed = started.elapsed();
        assert!(
            elapsed <= bound,
            "{name}: {elapsed:?} over every language, past the {bound:?} bound. \
             The scanner can be driven into the shape it exists to warn about."
        );
        eprintln!("{name}: {elapsed:?}");
    }
}
