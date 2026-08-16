//! Exponential backtracking, decided rather than guessed.
//!
//! **The property is ambiguity, not nesting.** A backtracking engine goes
//! exponential on a loop when one string can be consumed by that loop in
//! more than one way, because every way is a branch it may have to try.
//! `(a+)+` is such a loop — `"aa"` splits as `a|a` or `aa`. `(?:-[a-z]+)*`
//! is not: every iteration must eat a `-` the inner class cannot produce,
//! so the split is forced. Star height is identical in both, which is why
//! a shape test reported the second `high` and missed `(.*a){20}`.
//!
//! **The verdict is a demonstration, not a classification.** The pattern
//! is compiled to an NFA and that NFA is walked the way a backtracking
//! engine walks one — depth-first, every edge in order, a dead end
//! unwound rather than remembered — while the steps are counted. An
//! attack string is built, pumped, and measured at two lengths. A pattern
//! is reported only when a concrete input drove the count past its
//! budget, and that input is reported with it as `witness`.
//!
//! So a finding here is falsifiable: run the witness and watch. Nothing
//! is reported on the strength of how a pattern is shaped, which is what
//! the star-height rule this replaces did — it called `(?:-[a-z]+)*`
//! dangerous, missed `(.*a){20}` entirely, and scored 6 of 20 against
//! measured truth. This scores 20 of 20; `tests/contracts.rs` holds it
//! there against `fixtures/redos-truth.json`, whose `measured` column
//! comes from timing a real engine, not from this code.
//!
//! Three things decide the outcome, and each is a way to be wrong:
//!
//! - **The attack string needs a prefix that reaches the loop.** A loop
//!   behind a literal — `say "([a-z]+)*"` — is never entered by a string
//!   of nothing but the pumped core, and the pattern measures flat.
//! - **The tail must fail.** A blow-up only shows on a failing match:
//!   `(a+)+` succeeds on any input holding an `a` and never backtracks,
//!   while `(a+)+b` has to try every split before giving up.
//! - **Anchors are not nothing.** Dropping `^` and `$` models every
//!   anchored pattern as unanchored, and an unanchored loop usually
//!   matches empty at position 0 and returns at once.
//!
//! What cannot be demonstrated is named rather than guessed at — see
//! [`Undecidable`]. A pattern this cannot read is reported as undecided,
//! never as safe.
//!
//! The pattern itself is never handed to a regex engine; only this
//! automaton is walked, under a step budget it cannot exceed.

/// A set of code points, as sorted disjoint inclusive ranges.
type Ranges = Vec<(u32, u32)>;

const MAX_CODE_POINT: u32 = 0x0010_FFFF;

/// Why a pattern could not be decided.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum Undecidable {
    /// A backreference makes the language non-regular; an automaton
    /// cannot answer for it.
    Backreference,
    /// Lookaround is an intersection this construction does not model.
    Lookaround,
    /// Syntax this parser does not read. Named rather than guessed at: a
    /// pattern read wrongly is a verdict invented.
    Unsupported,
    /// The automaton outgrew its ceiling.
    TooLarge,
}

impl Undecidable {
    pub(crate) const fn reason(self) -> &'static str {
        match self {
            Self::Backreference => "a backreference is not a regular language",
            Self::Lookaround => "lookaround is not modelled by this construction",
            Self::Unsupported => "the pattern uses syntax this cannot read",
            Self::TooLarge => "the pattern is too large to decide",
        }
    }
}

// ---------------------------------------------------------------------
// Syntax
// ---------------------------------------------------------------------

#[derive(Debug, Clone)]
enum Node {
    /// Consumes nothing: a boundary, an empty alternative.
    Empty,
    /// `^` and `$`. **Not `Empty`.** Discarding them modelled every
    /// anchored pattern as unanchored, and an unanchored loop usually
    /// matches empty at position 0 and returns at once — so `^(a{2,4})+$`
    /// looked safe while `(a{1,3})*` looked dangerous. Both backwards.
    Start,
    End,
    Class(Ranges),
    Concat(Vec<Node>),
    Alt(Vec<Node>),
    Repeat {
        node: Box<Node>,
        min: u32,
        max: Option<u32>,
    },
}

struct Parser<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Parser<'a> {
    fn new(source: &'a str) -> Self {
        Self {
            bytes: source.as_bytes(),
            at: 0,
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn peek_at(&self, ahead: usize) -> Option<u8> {
        self.bytes.get(self.at + ahead).copied()
    }

    fn bump(&mut self) -> Option<u8> {
        let byte = self.peek()?;
        self.at += 1;
        Some(byte)
    }

    fn eat(&mut self, byte: u8) -> bool {
        if self.peek() == Some(byte) {
            self.at += 1;
            return true;
        }
        false
    }

    fn alternation(&mut self) -> Result<Node, Undecidable> {
        let mut branches = vec![self.concat()?];
        while self.eat(b'|') {
            branches.push(self.concat()?);
        }
        if branches.len() == 1 {
            return Ok(branches.remove(0));
        }
        Ok(Node::Alt(branches))
    }

    fn concat(&mut self) -> Result<Node, Undecidable> {
        let mut parts = Vec::new();
        while let Some(byte) = self.peek() {
            if byte == b'|' || byte == b')' {
                break;
            }
            parts.push(self.quantified()?);
        }
        match parts.len() {
            0 => Ok(Node::Empty),
            1 => Ok(parts.remove(0)),
            _ => Ok(Node::Concat(parts)),
        }
    }

    fn quantified(&mut self) -> Result<Node, Undecidable> {
        let atom = self.atom()?;
        let (min, max) = match self.peek() {
            Some(b'*') => {
                self.at += 1;
                (0, None)
            }
            Some(b'+') => {
                self.at += 1;
                (1, None)
            }
            Some(b'?') => {
                self.at += 1;
                (0, Some(1))
            }
            Some(b'{') => match self.counted() {
                Some(bounds) => bounds,
                // A brace that is not a counter is a literal, which
                // JavaScript permits.
                None => return Ok(atom),
            },
            _ => return Ok(atom),
        };
        // Lazy and possessive change which path is tried first, never how
        // many paths there are.
        if matches!(self.peek(), Some(b'?' | b'+')) {
            self.at += 1;
        }
        Ok(Node::Repeat {
            node: Box::new(atom),
            min,
            max,
        })
    }

    fn counted(&mut self) -> Option<(u32, Option<u32>)> {
        let start = self.at;
        self.at += 1;
        let Some(min) = self.number() else {
            self.at = start;
            return None;
        };
        let max = if self.eat(b',') {
            if self.peek() == Some(b'}') {
                None
            } else {
                let Some(value) = self.number() else {
                    self.at = start;
                    return None;
                };
                Some(value)
            }
        } else {
            Some(min)
        };
        if !self.eat(b'}') {
            self.at = start;
            return None;
        }
        Some((min, max))
    }

    fn number(&mut self) -> Option<u32> {
        let start = self.at;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.at += 1;
        }
        if start == self.at {
            return None;
        }
        std::str::from_utf8(&self.bytes[start..self.at])
            .ok()?
            .parse()
            .ok()
    }

    fn atom(&mut self) -> Result<Node, Undecidable> {
        match self.peek() {
            Some(b'(') => self.group(),
            Some(b'[') => Ok(Node::Class(self.class()?)),
            Some(b'.') => {
                self.at += 1;
                Ok(Node::Class(normalise(vec![
                    (0, 9),
                    (11, 12),
                    (14, MAX_CODE_POINT),
                ])))
            }
            Some(b'^') => {
                self.at += 1;
                Ok(Node::Start)
            }
            Some(b'$') => {
                self.at += 1;
                Ok(Node::End)
            }
            Some(b'\\') => self.escape(),
            Some(b'*' | b'+' | b'?') => Err(Undecidable::Unsupported),
            Some(_) => {
                let byte = self.bump().unwrap_or(b'\0');
                Ok(Node::Class(vec![(u32::from(byte), u32::from(byte))]))
            }
            None => Ok(Node::Empty),
        }
    }

    fn group(&mut self) -> Result<Node, Undecidable> {
        self.at += 1;
        if self.eat(b'?') {
            match self.peek() {
                Some(b':') => {
                    self.at += 1;
                }
                Some(b'=' | b'!') => return Err(Undecidable::Lookaround),
                Some(b'<') => {
                    if matches!(self.peek_at(1), Some(b'=' | b'!')) {
                        return Err(Undecidable::Lookaround);
                    }
                    // `(?<name>` is an ordinary capture.
                    self.at += 1;
                    while !self.eat(b'>') {
                        if self.bump().is_none() {
                            return Err(Undecidable::Unsupported);
                        }
                    }
                }
                // `(?P<name>` is Python's spelling of the same thing, and
                // `(?P=name)` its backreference. Patterns are read from
                // every language the extractor finds one in, so refusing
                // Python's syntax would leave `(?P<w>\w+)+@` — the classic
                // dangerous shape — undecided on working code.
                Some(b'P') => {
                    self.at += 1;
                    if self.peek() == Some(b'=') {
                        return Err(Undecidable::Backreference);
                    }
                    if !self.eat(b'<') {
                        return Err(Undecidable::Unsupported);
                    }
                    while !self.eat(b'>') {
                        if self.bump().is_none() {
                            return Err(Undecidable::Unsupported);
                        }
                    }
                }
                _ => return Err(Undecidable::Unsupported),
            }
        }
        let inner = self.alternation()?;
        if !self.eat(b')') {
            return Err(Undecidable::Unsupported);
        }
        Ok(inner)
    }

    fn escape(&mut self) -> Result<Node, Undecidable> {
        self.at += 1;
        let escaped = self.bump().ok_or(Undecidable::Unsupported)?;
        if escaped.is_ascii_digit() && escaped != b'0' {
            return Err(Undecidable::Backreference);
        }
        if escaped == b'k' {
            return Err(Undecidable::Backreference);
        }
        // A boundary consumes nothing.
        if matches!(escaped, b'b' | b'B') {
            return Ok(Node::Empty);
        }
        if matches!(escaped, b'u' | b'x' | b'c' | b'p' | b'P') {
            return Err(Undecidable::Unsupported);
        }
        Ok(Node::Class(escape_class(escaped)))
    }

    fn class(&mut self) -> Result<Ranges, Undecidable> {
        self.at += 1;
        let negated = self.eat(b'^');
        let mut ranges: Ranges = Vec::new();
        let mut first = true;
        loop {
            match self.peek() {
                None => return Err(Undecidable::Unsupported),
                Some(b']') if !first => {
                    self.at += 1;
                    break;
                }
                _ => {}
            }
            first = false;
            match self.class_member()? {
                Member::Whole(mut whole) => ranges.append(&mut whole),
                Member::Point(low) => {
                    let dashed = self.peek() == Some(b'-') && self.peek_at(1) != Some(b']');
                    if dashed {
                        self.at += 1;
                        match self.class_member()? {
                            Member::Point(high) => {
                                ranges.push((low.min(high), low.max(high)));
                                continue;
                            }
                            Member::Whole(mut whole) => {
                                // `[a-\d]` is not a range; JavaScript reads
                                // the dash as a literal.
                                ranges.push((low, low));
                                ranges.push((u32::from(b'-'), u32::from(b'-')));
                                ranges.append(&mut whole);
                                continue;
                            }
                        }
                    }
                    ranges.push((low, low));
                }
            }
        }
        let merged = normalise(ranges);
        Ok(if negated { complement(&merged) } else { merged })
    }

    fn class_member(&mut self) -> Result<Member, Undecidable> {
        let byte = self.bump().ok_or(Undecidable::Unsupported)?;
        if byte != b'\\' {
            return Ok(Member::Point(u32::from(byte)));
        }
        let escaped = self.bump().ok_or(Undecidable::Unsupported)?;
        if matches!(escaped, b'd' | b'D' | b'w' | b'W' | b's' | b'S') {
            return Ok(Member::Whole(escape_class(escaped)));
        }
        if matches!(escaped, b'u' | b'x' | b'c' | b'p' | b'P') {
            return Err(Undecidable::Unsupported);
        }
        Ok(Member::Point(u32::from(match escaped {
            b'n' => b'\n',
            b'r' => b'\r',
            b't' => b'\t',
            b'f' => 12,
            b'v' => 11,
            b'0' => 0,
            other => other,
        })))
    }
}

enum Member {
    Point(u32),
    Whole(Ranges),
}

fn escape_class(escaped: u8) -> Ranges {
    let digits = vec![(48, 57)];
    let word = vec![(48, 57), (65, 90), (95, 95), (97, 122)];
    let space = normalise(vec![
        (9, 13),
        (32, 32),
        (0x00A0, 0x00A0),
        (0x2028, 0x2029),
        (0xFEFF, 0xFEFF),
    ]);
    match escaped {
        b'd' => digits,
        b'D' => complement(&digits),
        b'w' => word,
        b'W' => complement(&word),
        b's' => space,
        b'S' => complement(&space),
        b'n' => vec![(10, 10)],
        b'r' => vec![(13, 13)],
        b't' => vec![(9, 9)],
        b'f' => vec![(12, 12)],
        b'v' => vec![(11, 11)],
        other => vec![(u32::from(other), u32::from(other))],
    }
}

fn normalise(mut ranges: Ranges) -> Ranges {
    ranges.sort_unstable();
    let mut out: Ranges = Vec::new();
    for (low, high) in ranges {
        match out.last_mut() {
            Some(last) if low <= last.1.saturating_add(1) => last.1 = last.1.max(high),
            _ => out.push((low, high)),
        }
    }
    out
}

fn complement(ranges: &[(u32, u32)]) -> Ranges {
    let mut out = Vec::new();
    let mut at = 0u32;
    for &(low, high) in ranges {
        if low > at {
            out.push((at, low - 1));
        }
        at = high.saturating_add(1);
    }
    if at <= MAX_CODE_POINT {
        out.push((at, MAX_CODE_POINT));
    }
    out
}

// ---------------------------------------------------------------------
// Alphabet
// ---------------------------------------------------------------------

/// Every class in the pattern, cut into disjoint intervals.
///
/// Two characters that no class tells apart behave identically, so the
/// automaton only ever needs one symbol per equivalence class. This keeps
/// the product walk over `.` — a million code points — the same size as
/// one over `a`.
fn alphabet(node: &Node) -> Vec<(u32, u32)> {
    let mut cuts: Vec<u32> = vec![0];
    collect_cuts(node, &mut cuts);
    cuts.push(MAX_CODE_POINT.saturating_add(1));
    cuts.sort_unstable();
    cuts.dedup();
    cuts.windows(2)
        .filter(|pair| pair[0] <= MAX_CODE_POINT)
        .map(|pair| (pair[0], pair[1].saturating_sub(1)))
        .collect()
}

fn collect_cuts(node: &Node, cuts: &mut Vec<u32>) {
    match node {
        Node::Empty | Node::Start | Node::End => {}
        Node::Class(ranges) => {
            for &(low, high) in ranges {
                cuts.push(low);
                cuts.push(high.saturating_add(1));
            }
        }
        Node::Concat(parts) | Node::Alt(parts) => {
            for part in parts {
                collect_cuts(part, cuts);
            }
        }
        Node::Repeat { node, .. } => collect_cuts(node, cuts),
    }
}

fn symbols_of(ranges: &[(u32, u32)], alphabet: &[(u32, u32)]) -> Vec<usize> {
    alphabet
        .iter()
        .enumerate()
        .filter(|&(_, &(low, high))| ranges.iter().any(|&(from, to)| from <= low && high <= to))
        .map(|(index, _)| index)
        .collect()
}

// ---------------------------------------------------------------------
// Automaton
// ---------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Edge {
    kind: Step,
    to: usize,
}

/// What crossing an edge requires.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    /// Free.
    Epsilon,
    /// Consumes one character from the alphabet class.
    Symbol(usize),
    /// Passable only at the start of the input.
    AtStart,
    /// Passable only at the end.
    AtEnd,
}

#[derive(Debug, Default)]
struct Nfa {
    edges: Vec<Vec<Edge>>,
    /// The code points each symbol stands for, so the matcher needs
    /// nothing but the automaton.
    alphabet: Vec<(u32, u32)>,
}

impl Nfa {
    fn state(&mut self) -> usize {
        self.edges.push(Vec::new());
        self.edges.len() - 1
    }

    fn link(&mut self, from: usize, kind: Step, to: usize) {
        self.edges[from].push(Edge { kind, to });
    }

    fn len(&self) -> usize {
        self.edges.len()
    }
}

/// Compile, returning the fragment's entry and exit.
fn compile(
    nfa: &mut Nfa,
    node: &Node,
    alphabet: &[(u32, u32)],
) -> Result<(usize, usize), Undecidable> {
    match node {
        Node::Empty => {
            let state = nfa.state();
            Ok((state, state))
        }
        Node::Start | Node::End => {
            let entry = nfa.state();
            let exit = nfa.state();
            let kind = if matches!(node, Node::Start) {
                Step::AtStart
            } else {
                Step::AtEnd
            };
            nfa.link(entry, kind, exit);
            Ok((entry, exit))
        }
        Node::Class(ranges) => {
            let entry = nfa.state();
            let exit = nfa.state();
            for symbol in symbols_of(ranges, alphabet) {
                nfa.link(entry, Step::Symbol(symbol), exit);
            }
            Ok((entry, exit))
        }
        Node::Concat(parts) => {
            let entry = nfa.state();
            let mut at = entry;
            for part in parts {
                let (start, end) = compile(nfa, part, alphabet)?;
                nfa.link(at, Step::Epsilon, start);
                at = end;
            }
            Ok((entry, at))
        }
        Node::Alt(branches) => {
            let entry = nfa.state();
            let exit = nfa.state();
            for branch in branches {
                let (start, end) = compile(nfa, branch, alphabet)?;
                nfa.link(entry, Step::Epsilon, start);
                nfa.link(end, Step::Epsilon, exit);
            }
            Ok((entry, exit))
        }
        Node::Repeat { node, min, max } => compile_repeat(nfa, node, *min, *max, alphabet),
    }
}

fn compile_repeat(
    nfa: &mut Nfa,
    node: &Node,
    min: u32,
    max: Option<u32>,
    alphabet: &[(u32, u32)],
) -> Result<(usize, usize), Undecidable> {
    // A counted repetition is unrolled, because `{20}` of an ambiguous
    // body is twenty chances to split the same string — which is exactly
    // what `(.*a){20}` is, and exactly what a rule keyed on "unbounded"
    // could not see. The bound keeps a hostile `{100000}` from unrolling
    // the process out of memory.
    const MAX_UNROLL: u32 = 64;
    let entry = nfa.state();
    let mut at = entry;
    let required = min.min(MAX_UNROLL);
    for _ in 0..required {
        let (start, end) = compile(nfa, node, alphabet)?;
        nfa.link(at, Step::Epsilon, start);
        at = end;
    }
    match max {
        None => {
            // A star over the body: back edge, and skippable.
            let (start, end) = compile(nfa, node, alphabet)?;
            let exit = nfa.state();
            nfa.link(at, Step::Epsilon, start);
            nfa.link(end, Step::Epsilon, start);
            nfa.link(end, Step::Epsilon, exit);
            nfa.link(at, Step::Epsilon, exit);
            Ok((entry, exit))
        }
        Some(max) => {
            let optional = max.saturating_sub(min).min(MAX_UNROLL);
            let exit = nfa.state();
            nfa.link(at, Step::Epsilon, exit);
            for _ in 0..optional {
                let (start, end) = compile(nfa, node, alphabet)?;
                nfa.link(at, Step::Epsilon, start);
                nfa.link(end, Step::Epsilon, exit);
                at = end;
            }
            Ok((entry, exit))
        }
    }
}

// ---------------------------------------------------------------------
// The decision: demonstrate it, or say nothing
// ---------------------------------------------------------------------

/// A demonstrated blow-up.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Blowup {
    /// The input that does it.
    pub(crate) witness: String,
    /// Steps at the smaller pump.
    pub(crate) low: u64,
    /// Steps at the larger one, or the budget when it was exhausted.
    pub(crate) high: u64,
}

/// The step ceiling. An engine that has taken this many steps on a
/// string this short has already lost. A budget, not a timing, so the
/// answer is the same on every machine.
const STEP_BUDGET: u64 = 2_000_000;
/// The two pump lengths. Doubling the input should at most double the
/// work; exponential blows the budget outright.
const PUMP_LOW: usize = 14;
const PUMP_HIGH: usize = 40;
/// What counts as a blow-up between them. Linear is ~2x, quadratic ~4x.
const BLOWUP_RATIO: u64 = 1_000;

/// Decide the pattern by demonstration.
///
/// **Nothing is reported that has not been shown.** A structural rule
/// can only say a shape looks dangerous, and both shapes and automata
/// over-report: the prefix-anchored idioms that defeat them are safe
/// because a separator forces the split, which is a fact about strings
/// rather than about syntax. So the question asked here is the one that
/// matters — is there an input that makes this blow up — and the answer
/// carries that input.
///
/// The matcher is this crate's own, over the parsed AST, counting steps
/// rather than seconds. Nothing reaches the host regex engine and
/// nothing can hang: the budget is the termination condition.
pub(crate) fn decide(pattern: &str) -> Result<Option<Blowup>, Undecidable> {
    let node = Parser::new(pattern).alternation()?;
    let alphabet = alphabet(&node);
    let mut nfa = Nfa::default();
    let (entry, exit) = compile(&mut nfa, &node, &alphabet)?;
    if nfa.len() > 4_000 {
        return Err(Undecidable::TooLarge);
    }
    nfa.alphabet.clone_from(&alphabet);

    for (prefix, core, tail) in candidates(&node, &alphabet) {
        let low_input = prefix.clone() + &core.repeat(PUMP_LOW) + &tail;
        let high_input = prefix + &core.repeat(PUMP_HIGH) + &tail;
        let low = steps(&nfa, entry, exit, &low_input);
        let high = steps(&nfa, entry, exit, &high_input);
        if high == STEP_BUDGET || high / low.max(1) >= BLOWUP_RATIO {
            return Ok(Some(Blowup {
                witness: high_input,
                low,
                high,
            }));
        }
    }
    Ok(None)
}

/// Attack strings to try: a prefix that reaches a loop, a repeatable
/// core, and a tail that fails.
///
/// The core comes from the alphabet of the loop being attacked, because a
/// character that loop does not accept cannot drive it. The tail must be
/// rejected, which is what forces the engine to exhaust every split
/// before giving up — a blow-up only shows on a failing match.
///
/// **The prefix is why `say "([a-z]+)*"` is caught.** Its loop sits
/// behind a literal, so an attack string of nothing but the core dies at
/// the `s` from every start position and the pattern measured flat.
/// Every loop is tried with a concrete string that reaches it.
fn candidates(node: &Node, alphabet: &[(u32, u32)]) -> Vec<(String, String, String)> {
    let rejected = ['\u{0}', '!', '#', '~']
        .into_iter()
        .find(|&ch| !accepts(node, ch))
        .unwrap_or('\u{0}')
        .to_string();

    let mut reachable = Vec::new();
    loops(node, String::new(), &mut reachable);
    // The whole pattern with no prefix stays in the list: a bounded but
    // deeply nested repeat has no unbounded loop to find, and used to be
    // measured this way.
    reachable.push((String::new(), node));

    let mut out: Vec<(String, String, String)> = Vec::new();
    for (prefix, target) in reachable {
        for core in cores(target, alphabet) {
            let candidate = (prefix.clone(), core, rejected.clone());
            if !out.contains(&candidate) {
                out.push(candidate);
            }
        }
    }
    out
}

/// The strings worth pumping through one loop.
fn cores(target: &Node, alphabet: &[(u32, u32)]) -> Vec<String> {
    let mut accepted: Vec<char> = Vec::new();
    for &(low, _) in alphabet {
        if let Some(ch) = char::from_u32(low)
            && ch.is_ascii_graphic()
            && accepts(target, ch)
        {
            accepted.push(ch);
        }
    }
    let mut cores: Vec<String> = accepted.iter().take(6).map(char::to_string).collect();
    // A two-character core catches a loop whose body is a pair, like
    // `(?:ab)+`, which a single character cannot pump.
    if accepted.len() >= 2 {
        cores.push(format!("{}{}", accepted[0], accepted[1]));
    }
    if cores.is_empty() {
        cores.push("a".to_string());
    }
    cores
}

/// Every unbounded repeat, each paired with a concrete string that
/// reaches it from the start of the pattern.
fn loops<'a>(node: &'a Node, prefix: String, out: &mut Vec<(String, &'a Node)>) {
    match node {
        Node::Repeat {
            node: body, max, ..
        } => {
            if max.is_none() {
                out.push((prefix.clone(), body.as_ref()));
            }
            // A loop nested inside this one is reached by the same
            // prefix — the outer loop can be entered zero times.
            loops(body, prefix, out);
        }
        Node::Concat(parts) => {
            let mut here = prefix;
            for part in parts {
                loops(part, here.clone(), out);
                // Once a part has no concrete match, nothing after it can
                // be reached by a string this builds.
                let Some(text) = shortest(part) else { return };
                here.push_str(&text);
            }
        }
        Node::Alt(parts) => {
            for part in parts {
                loops(part, prefix.clone(), out);
            }
        }
        Node::Empty | Node::Start | Node::End | Node::Class(_) => {}
    }
}

/// A shortest concrete string this node matches.
///
/// Used only to build a prefix, so an anchor contributes nothing rather
/// than failing — `^say (a+)+` is reached by `say ` at position 0.
fn shortest(node: &Node) -> Option<String> {
    match node {
        Node::Empty | Node::Start | Node::End => Some(String::new()),
        Node::Class(ranges) => ranges
            .iter()
            .find_map(|&(low, high)| {
                (low..=high)
                    .filter_map(char::from_u32)
                    .find(char::is_ascii_graphic)
            })
            .or_else(|| ranges.iter().find_map(|&(low, _)| char::from_u32(low)))
            .map(|ch| ch.to_string()),
        Node::Concat(parts) => parts
            .iter()
            .map(shortest)
            .collect::<Option<Vec<_>>>()
            .map(|parts| parts.concat()),
        Node::Alt(parts) => parts.iter().filter_map(shortest).min_by_key(String::len),
        Node::Repeat { node, min, .. } => {
            if *min == 0 {
                Some(String::new())
            } else {
                shortest(node).map(|text| text.repeat(*min as usize))
            }
        }
    }
}

/// Whether any class in the pattern admits this character.
fn accepts(node: &Node, ch: char) -> bool {
    match node {
        Node::Empty | Node::Start | Node::End => false,
        Node::Class(ranges) => ranges
            .iter()
            .any(|&(low, high)| (low..=high).contains(&(ch as u32))),
        Node::Concat(parts) | Node::Alt(parts) => parts.iter().any(|part| accepts(part, ch)),
        Node::Repeat { node, .. } => accepts(node, ch),
    }
}

/// How many steps a backtracking engine spends before it gives up.
///
/// Depth-first over the automaton with no memoisation, which is what a
/// backtracking engine is: every edge tried in order, a dead end unwound
/// rather than remembered. Capped at `STEP_BUDGET`, which is also the
/// signal that the pattern lost.
fn steps(nfa: &Nfa, entry: usize, exit: usize, input: &str) -> u64 {
    let chars: Vec<char> = input.chars().collect();
    let mut spent: u64 = 0;
    // **A search, not a full match.** An engine tries every start
    // position and stops at the first success, so an unanchored loop that
    // matches empty at position 0 returns at once — `(a{1,3})*` is not a
    // hazard for that reason, though it looks like one. Requiring the
    // whole input to be consumed reported it as exponential.
    for start in 0..=chars.len() {
        let mut stack: Vec<(usize, usize)> = vec![(entry, start)];
        while let Some((state, at)) = stack.pop() {
            spent += 1;
            if spent >= STEP_BUDGET {
                return STEP_BUDGET;
            }
            if state == exit {
                return spent;
            }
            for edge in nfa.edges[state].iter().rev() {
                match edge.kind {
                    Step::Epsilon => stack.push((edge.to, at)),
                    Step::AtStart if at == 0 => stack.push((edge.to, at)),
                    Step::AtEnd if at == chars.len() => stack.push((edge.to, at)),
                    Step::AtStart | Step::AtEnd => {}
                    Step::Symbol(symbol) => {
                        if let Some(&ch) = chars.get(at) {
                            let (low, high) = nfa.alphabet[symbol];
                            if (low..=high).contains(&(ch as u32)) {
                                stack.push((edge.to, at + 1));
                            }
                        }
                    }
                }
            }
        }
    }
    spent
}

#[cfg(test)]
mod tests {
    use std::fmt::Write as _;

    use super::decide;

    #[test]
    fn scored_against_measured_truth() {
        const TRUTH: &str = include_str!("../../fixtures/redos-truth.json");
        let truth: serde_json::Value = serde_json::from_str(TRUTH).expect("valid JSON");
        let (mut ok, mut miss, mut alarm) = (0, 0, 0);
        let mut detail = String::new();
        for case in truth["cases"].as_array().expect("cases") {
            let pattern = case["pattern"].as_str().expect("a pattern");
            let expected = case["measured"] == "exponential";
            let found = matches!(decide(pattern), Ok(Some(_)));
            match (expected, found) {
                (true, true) | (false, false) => ok += 1,
                (true, false) => {
                    miss += 1;
                    let _ = writeln!(detail, "  MISS  {pattern}");
                }
                (false, true) => {
                    alarm += 1;
                    let _ = writeln!(detail, "  ALARM {pattern}");
                }
            }
        }
        println!("correct {ok}/20  misses {miss}  false alarms {alarm}\n{detail}");
        assert_eq!((ok, miss, alarm), (20, 0, 0), "\n{detail}");
    }
}

#[cfg(test)]
mod holdout_tests {
    use super::{Undecidable, decide};

    fn blows(pattern: &str) -> bool {
        matches!(decide(pattern), Ok(Some(_)))
    }

    /// Patterns the thresholds were never tuned against.
    #[test]
    fn a_holdout_set_is_decided_correctly() {
        // Known-catastrophic shapes from the ReDoS literature.
        for pattern in [
            r"^(\w+\s?)*$",
            r"^(([a-z])+.)+[A-Z]([a-z])+$",
            r"(x+x+)+y",
            r"^(a|a?)+$",
            r"(\s*\w+)+$",
        ] {
            assert!(blows(pattern), "missed {pattern}");
        }
        // Ordinary idioms that must stay quiet.
        for pattern in [
            r"^[\w.+-]+@[\w-]+\.[\w.]+$",
            r"^/api/v[0-9]+/[a-z-]+$",
            r"^#[0-9a-fA-F]{6}$",
            r"^(?:\d{1,3}\.){3}\d{1,3}$",
            r"^[A-Za-z]+(?: [A-Za-z]+)*$",
            r"^\$?\d+(?:,\d{3})*(?:\.\d{2})?$",
        ] {
            assert!(!blows(pattern), "false alarm on {pattern}");
        }
    }

    /// A blow-up carries the input that causes it, which is the whole
    /// difference between this and a severity label.
    #[test]
    fn a_finding_carries_its_witness() {
        let Ok(Some(blowup)) = decide(r"(a+)+b") else {
            panic!("expected a blow-up");
        };
        assert!(!blowup.witness.is_empty());
        // Either the larger pump exhausted the budget, or it cost
        // enormously more than the smaller one. When the pattern is bad
        // enough that *both* pumps exhaust it, the ratio is 1 and the
        // budget is the signal — asserting only the ratio missed that.
        assert!(
            blowup.high == super::STEP_BUDGET || blowup.high > blowup.low.saturating_mul(100),
            "{blowup:?}"
        );
    }

    /// What an automaton cannot answer is refused by name, never guessed.
    #[test]
    fn non_regular_syntax_is_refused() {
        assert_eq!(decide(r"(a)\1"), Err(Undecidable::Backreference));
        assert_eq!(decide(r"(?=a)b"), Err(Undecidable::Lookaround));
        assert_eq!(decide(r"(?<=a)b"), Err(Undecidable::Lookaround));
        assert!(decide(r"(?<year>\d{4})").is_ok());
    }
}
