#!/usr/bin/env node
/**
 * Assemble the `cli/` npm package: the command line bundled from
 * `src/cli/main.ts`, the license, and a manifest whose version is written from
 * the root's, so the package and the extension cannot claim the same version
 * while carrying different code.
 *
 *   node scripts/build-cli.js [--prod]
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const prod = process.argv.includes('--prod');
const manifestPath = path.resolve('cli/package.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

// The npm package installs the command `regex-le`, the name the crate
// installs too. A manifest naming anything else would publish a second
// command nobody documented. The package name can differ, since npm decides
// which names it accepts, and check-cli-package.js holds the READMEs to it.
const commands = Object.keys(manifest.bin ?? {});
if (commands.length !== 1 || manifest.bin[root.name] !== 'cli.js') {
	console.error(
		`FAIL: cli/package.json must install exactly one command, "${root.name}": "cli.js"`,
	);
	process.exit(1);
}

const args = [
	'src/cli/main.ts',
	'--bundle',
	'--outfile=cli/cli.js',
	'--format=cjs',
	'--platform=node',
	'--target=node20',
	'--main-fields=module,main',
	'--banner:js=#!/usr/bin/env node',
	// stderr is the crate's listing and summary and nothing else, so nothing
	// the engine warns on the console is part of this build: console.warn is
	// marked pure, and dropped by the syntax pass even in a development build.
	'--pure:console.warn',
	'--minify-syntax',
	`--define:__MCP_NAME__=${JSON.stringify(root.name)}`,
	`--define:__MCP_VERSION__=${JSON.stringify(root.version)}`,
	...(prod ? ['--minify'] : []),
];
const esbuild = require.resolve('esbuild/bin/esbuild');
execFileSync(process.execPath, [esbuild, ...args], { stdio: 'inherit' });

fs.copyFileSync('LICENSE', 'cli/LICENSE');
if (manifest.version !== root.version) {
	manifest.version = root.version;
	fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, '\t')}\n`);
}
console.log(`${manifest.name} built at ${root.version}`);
