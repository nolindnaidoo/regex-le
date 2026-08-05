#!/usr/bin/env node
/**
 * Assemble the npm package from the built MCP server.
 *
 * The same `dist/mcp-server.js` the VSIX ships is what gets published, so the
 * two distributions can never diverge in behaviour — there is one build.
 *
 * The version is *written* here from the root manifest rather than maintained
 * by hand in two places. A VSIX and an npm package claiming the same version
 * while carrying different code is the kind of drift that is invisible until
 * someone reports a bug against a version that never existed.
 *
 *   node scripts/build-npm.js
 */
const fs = require('node:fs');
const path = require('node:path');

const root = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const packageDir = path.resolve('mcp');
const manifestPath = path.join(packageDir, 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const expectedName = `${root.name}-mcp`;
if (manifest.name !== expectedName) {
	console.error(
		`FAIL: mcp/package.json is named "${manifest.name}", expected "${expectedName}"`,
	);
	process.exit(1);
}

const bundlePath = path.resolve('dist/mcp-server.js');
if (!fs.existsSync(bundlePath)) {
	console.error('FAIL: dist/mcp-server.js is missing — run `bun run build:mcp:prod` first');
	process.exit(1);
}

if (manifest.version !== root.version) {
	manifest.version = root.version;
	fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, '\t')}\n`);
}

// The MCP registry hosts metadata only: it verifies a server by reading
// `mcpName` out of the published npm package and checking it against the name
// in server.json. They live in different files, so they are written from one
// place — and a mismatch discovered after publishing costs a version, because
// npm will not let the same one be republished.
const registryPath = path.resolve('server.json');
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));

if (registry.name !== manifest.mcpName) {
	console.error(
		`FAIL: server.json is "${registry.name}" but mcp/package.json mcpName is "${manifest.mcpName}"`,
	);
	process.exit(1);
}

const npmPackage = registry.packages?.find((p) => p.registryType === 'npm');
if (npmPackage?.identifier !== manifest.name) {
	console.error(
		`FAIL: server.json publishes "${npmPackage?.identifier}", expected "${manifest.name}"`,
	);
	process.exit(1);
}

// The registry rejects a description over 100 characters, and it does so at
// publish time — after npm has already taken the version, which can never be
// reused. Failing here costs nothing.
const REGISTRY_DESCRIPTION_LIMIT = 100;
if (registry.description.length > REGISTRY_DESCRIPTION_LIMIT) {
	console.error(
		`FAIL: server.json description is ${registry.description.length} characters, over the ${REGISTRY_DESCRIPTION_LIMIT} the MCP registry allows`,
	);
	process.exit(1);
}

if (registry.version !== root.version || npmPackage.version !== root.version) {
	registry.version = root.version;
	npmPackage.version = root.version;
	fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, '\t')}\n`);
}

fs.copyFileSync(bundlePath, path.join(packageDir, 'server.js'));
fs.copyFileSync(path.resolve('LICENSE'), path.join(packageDir, 'LICENSE'));

console.log(`OK: mcp/ assembled as ${manifest.name}@${manifest.version}`);
