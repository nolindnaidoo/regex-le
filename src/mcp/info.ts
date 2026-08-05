/**
 * Server identity, kept out of server.ts so the version has one source.
 *
 * Injected at build time by esbuild --define, so it cannot drift from
 * package.json the way a hand-copied string would.
 */
declare const __MCP_NAME__: string;
declare const __MCP_VERSION__: string;

export const name: string =
	typeof __MCP_NAME__ === 'string' ? __MCP_NAME__ : 'regex-le';
export const version: string =
	typeof __MCP_VERSION__ === 'string' ? __MCP_VERSION__ : '0.0.0-dev';
