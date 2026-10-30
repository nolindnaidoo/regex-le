/**
 * The Regex-LE MCP server.
 *
 * Runs outside the editor: VS Code launches the bundled copy over stdio,
 * and every other MCP host runs the published npm package. It imports the
 * extraction engine and nothing from `vscode` — `check:mcp-bundle` fails the
 * build if that ever stops being true.
 */
import { name, version } from './info';
import { TOOLS } from './tools';
import { serve } from './transport';

// The crate's server and the npm command line's stop at the first reply
// they cannot write. A client that went away raised an unhandled EPIPE
// here, and the host logged a Node stack trace as the server crashing.
process.stdout.once('error', () => process.exit(2));

serve({ name, version }, TOOLS);
