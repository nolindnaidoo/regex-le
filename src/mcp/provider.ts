import * as vscode from 'vscode';

/**
 * Offer the bundled MCP server to VS Code's agent mode.
 *
 * The server ships inside the VSIX as `dist/mcp-server.js`, so nothing is
 * fetched at runtime — the same self-contained property the extension bundle
 * has. VS Code spawns it over stdio only when an agent actually calls a tool;
 * registering costs a single object.
 */

const PROVIDER_ID = 'regex-le';

/**
 * Register the provider, if this host supports it.
 *
 * `engines.vscode` declares 1.101, but a floor in the manifest is not a runtime
 * guarantee in forks — a VS Code-based editor can report a recent version and
 * still lack the API. Feature-detect rather than assume, and say nothing when
 * it is absent: an editor without agent mode is not a broken install.
 */
export function registerMcpProvider(
	context: vscode.ExtensionContext,
): vscode.Disposable | undefined {
	if (typeof vscode.lm?.registerMcpServerDefinitionProvider !== 'function') {
		return undefined;
	}

	const disposable = vscode.lm.registerMcpServerDefinitionProvider(
		PROVIDER_ID,
		{
			provideMcpServerDefinitions: () => [buildDefinition(context)],
		},
	);

	context.subscriptions.push(disposable);
	return disposable;
}

function buildDefinition(
	context: vscode.ExtensionContext,
): vscode.McpStdioServerDefinition {
	return new vscode.McpStdioServerDefinition(
		'Regex-LE',
		// The extension host runs Electron, not Node, so process.execPath is the
		// editor binary. ELECTRON_RUN_AS_NODE makes it behave as the Node it
		// embeds — without it the server never starts and the failure is silent.
		process.execPath,
		[context.asAbsolutePath('dist/mcp-server.js')],
		{ ELECTRON_RUN_AS_NODE: '1' },
		// Passing the version lets VS Code notice an upgrade and refresh the tool
		// list, rather than holding a stale definition until restart.
		context.extension.packageJSON.version,
	);
}
