#!/usr/bin/env node
/**
 * Build the MCP server bundle.
 *
 * A Node script rather than an inline esbuild invocation because the server
 * name and version have to be injected from package.json, and doing that with
 * shell command substitution (`$(node -p ...)`) is not portable — Bun's shell
 * on the Windows runner passes the literal string through and esbuild reads it
 * as flags.
 *
 *   node scripts/build-mcp.js [--prod]
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const pkg = require(path.resolve('package.json'));
const prod = process.argv.includes('--prod');

const args = [
	'src/mcp/server.ts',
	'--bundle',
	'--outfile=dist/mcp-server.js',
	'--format=cjs',
	'--platform=node',
	'--target=node20',
	'--main-fields=module,main',
	'--banner:js=#!/usr/bin/env node',
	// Deliberately no --external:vscode. The server must fail to build if any
	// import path reaches the editor API, rather than fail at runtime in Zed.
	`--define:__MCP_NAME__=${JSON.stringify(pkg.name)}`,
	`--define:__MCP_VERSION__=${JSON.stringify(pkg.version)}`,
	prod ? '--minify' : '--sourcemap',
];
if (prod) args.push('--sourcemap=external');

// Resolve esbuild through Node rather than assuming a PATH shim exists.
const esbuild = require.resolve('esbuild/bin/esbuild');
execFileSync(process.execPath, [esbuild, ...args], { stdio: 'inherit' });
