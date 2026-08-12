//! The pure detection layer: source text in, patterns and verdicts out.
//!
//! **Nothing in here touches the filesystem.** A `std::fs` call below
//! this line is a bug, and CI greps for one.
//!
//! This is the lint half of the extension and only that half. The
//! tester — running a pattern against text with JavaScript capture
//! semantics — is deliberately absent; see SPEC.md.

pub(crate) mod extract;
pub(crate) mod format;
pub(crate) mod heuristics;
pub(crate) mod redos;

mod position;

#[cfg(test)]
pub(crate) mod corpus;

// Re-exports land when the surfaces do. Until then the modules address
// each other directly, so nothing is exported that nothing imports.
