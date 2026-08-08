//! A throwaway directory tree, for the modules that genuinely need a
//! filesystem.
//!
//! `extract/` never does — that is the point of the split — so this is
//! only ever used by `resolve`, `walk` and `audit`.
//!
//! The root is canonicalised on creation. On macOS the temporary
//! directory is itself a symlink (`/tmp` → `/private/tmp`), so a root
//! taken as given and a path resolved through the filesystem are two
//! spellings of the same directory — and every `starts_with` check
//! between them fails for a reason that has nothing to do with the code
//! under test.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

static COUNTER: AtomicUsize = AtomicUsize::new(0);

pub(crate) struct TempTree {
    root: PathBuf,
}

impl TempTree {
    pub(crate) fn new(name: &str) -> Self {
        let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
        let root =
            std::env::temp_dir().join(format!("regex-le-{name}-{}-{unique}", std::process::id()));
        // A leftover from a killed run would otherwise leak into this
        // one and make it pass or fail for the wrong reason.
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("a temporary directory");
        let root = std::fs::canonicalize(&root).expect("a canonical temporary directory");
        Self { root }
    }

    pub(crate) fn path(&self) -> &Path {
        &self.root
    }

    pub(crate) fn mkdir(&self, relative: &str) -> PathBuf {
        let target = self.root.join(relative);
        std::fs::create_dir_all(&target).expect("a directory");
        target
    }

    pub(crate) fn write(&self, relative: &str, contents: &str) -> PathBuf {
        let target = self.root.join(relative);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).expect("a parent directory");
        }
        std::fs::write(&target, contents).expect("a file");
        target
    }

    /// `link` points at `target`, with `target` written verbatim so a
    /// relative link stays relative — which is what makes the reported
    /// link target readable.
    #[cfg(unix)]
    pub(crate) fn symlink(&self, target: &str, link: &str) {
        let link_path = self.root.join(link);
        if let Some(parent) = link_path.parent() {
            std::fs::create_dir_all(parent).expect("a parent directory");
        }
        std::os::unix::fs::symlink(target, link_path).expect("a symlink");
    }
}

impl Drop for TempTree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
