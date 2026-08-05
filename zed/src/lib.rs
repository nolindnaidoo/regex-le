//! The Zed side of Regex-LE.
//!
//! This crate holds no extraction logic. It resolves `regex-le-mcp` from npm and
//! hands Zed a command that launches it over stdio — the same server the VSIX
//! bundles and the same one `npx regex-le-mcp` runs. Keeping it a launcher is
//! deliberate: a second implementation in Rust would be a second set of
//! behaviour to keep in agreement with the goldens.

use std::env;
use std::path::PathBuf;

use zed_extension_api::{self as zed, Command, ContextServerId, Project, Result};

const PACKAGE_NAME: &str = "regex-le-mcp";
const SERVER_PATH: &str = "node_modules/regex-le-mcp/server.js";

struct RegexLEExtension;

/// Install or update the server, tolerating a registry that cannot be reached.
///
/// An offline editor with a working copy already installed should keep working;
/// only the case where there is nothing to run at all is an error, and that is
/// reported by the caller against the file it actually looked for.
fn sync_package() {
    let Ok(latest) = zed::npm_package_latest_version(PACKAGE_NAME) else {
        return;
    };

    let installed = zed::npm_package_installed_version(PACKAGE_NAME).unwrap_or(None);
    if installed.as_deref() == Some(latest.as_str()) {
        return;
    }

    let _ = zed::npm_install_package(PACKAGE_NAME, &latest);
}

/// Resolve the installed server to an absolute path.
///
/// `npm_install_package` installs relative to the extension's working
/// directory, and the spawned process does not inherit that as its cwd — so a
/// relative path here fails intermittently rather than never, which is the
/// worse way to be wrong.
fn server_path() -> Result<PathBuf> {
    let working_directory = env::current_dir()
        .map_err(|error| format!("could not resolve the extension directory: {error}"))?;

    let server = working_directory.join(SERVER_PATH);
    if !server.exists() {
        return Err(format!(
            "{PACKAGE_NAME} is not installed — expected the server at {}. \
             Check that Zed can reach the npm registry, then reload the extension.",
            server.display()
        ));
    }

    Ok(server)
}

impl zed::Extension for RegexLEExtension {
    fn new() -> Self {
        Self
    }

    fn context_server_command(
        &mut self,
        _context_server_id: &ContextServerId,
        _project: &Project,
    ) -> Result<Command> {
        sync_package();

        let server = server_path()?;
        let node = zed::node_binary_path()
            .map_err(|error| format!("Zed could not provide a Node binary: {error}"))?;

        Ok(Command {
            command: node,
            args: vec![server.to_string_lossy().into_owned()],
            env: vec![],
        })
    }
}

zed::register_extension!(RegexLEExtension);
