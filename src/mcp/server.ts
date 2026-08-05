/**
 * The Regex-LE MCP server.
 *
 * Runs outside the editor: VS Code launches the bundled copy over stdio, Zed
 * and every other MCP host run the published npm package. It imports the
 * extraction engine and nothing from `vscode` — `check:mcp-bundle` fails the
 * build if that ever stops being true.
 */
import { name, version } from './info';
import { TOOLS } from './tools';
import { serve } from './transport';

serve({ name, version }, TOOLS);
