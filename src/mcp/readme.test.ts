import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOOLS } from './tools';

/**
 * The npm package's README, held against the tools it documents.
 *
 * Seven of the ten READMEs were published describing a URL extractor — the
 * arguments, the return shape and the example all copied from the package the
 * template came from — and nothing noticed for two months, because nothing
 * read the README against the code. This does, for the three places that went
 * wrong: the heading names the tool, the argument table lists exactly the
 * arguments the schema takes, and the example is an answer from this tool.
 *
 * Identical in every *-le repo; the fleet check holds the copies equal.
 */
const README = readFileSync(
	join(__dirname, '..', '..', 'mcp', 'README.md'),
	'utf8',
);

function sectionOf(name: string): string {
	const start = README.indexOf(`### \`${name}\``);
	if (start === -1) return '';
	const rest = README.slice(start + 1);
	const next = rest.search(/\n##+ /);
	return next === -1 ? rest : rest.slice(0, next);
}

/**
 * The opening sentence, from "An [MCP]" to the first blank line, with its
 * links removed — it links the extension by name, and "Numbers-LE" would
 * otherwise satisfy a check that the sentence is about numbers.
 */
const INTRO = (README.match(/^An \[MCP\][\s\S]*?(?=\n\n)/m)?.[0] ?? '')
	.replace(/\[[^\]]*\]\([^)]*\)/g, '')
	.toLowerCase();

describe('mcp/README.md documents the tools this server offers', () => {
	it('opens by naming what the tool works on', () => {
		// The word the tool is named for: extract_numbers -> "number",
		// compare_env_files -> "file". The copied READMEs all opened "extracts
		// URLs", whatever they were for.
		const subject = (TOOLS[0]?.name.split('_').pop() ?? '').replace(/s$/, '');
		expect(INTRO, 'no "An [MCP] server that ..." opening').not.toBe('');
		expect(INTRO).toContain(subject);
	});

	for (const tool of TOOLS) {
		describe(tool.name, () => {
			const section = sectionOf(tool.name);

			it('has a section headed with the tool name', () => {
				expect(section, `no "### \`${tool.name}\`" heading`).not.toBe('');
			});

			it('lists exactly the arguments the schema takes', () => {
				const documented = [...section.matchAll(/^\| `([A-Za-z]+)` \|/gm)].map(
					(match) => match[1],
				);
				const declared = Object.keys(
					tool.inputSchema.properties as Record<string, unknown>,
				);
				expect([...documented].sort()).toEqual([...declared].sort());
			});

			it('names every value an argument offers', () => {
				const properties = tool.inputSchema.properties as Record<
					string,
					{ enum?: readonly string[] }
				>;
				for (const [name, property] of Object.entries(properties)) {
					if (property.enum === undefined) continue;
					const row =
						section.match(new RegExp(`^\\| \`${name}\` \\|.*$`, 'm'))?.[0] ??
						'';
					for (const value of property.enum) {
						expect(row, `${name} does not name \`${value}\``).toContain(
							`\`${value}\``,
						);
					}
				}
			});

			it('marks the required arguments as required, and nothing else', () => {
				const required = [
					...section.matchAll(
						/^\| `([A-Za-z]+)` \|[^|]*\| \*\*required\.\*\*/gm,
					),
				].map((match) => match[1]);
				expect([...required].sort()).toEqual(
					[...((tool.inputSchema.required as string[]) ?? [])].sort(),
				);
			});

			it('shows an example answered by this tool', () => {
				const block = section.match(/```json\n([\s\S]*?)\n```/);
				expect(block, 'no JSON example').not.toBeNull();
				const example = JSON.parse(block?.[1] ?? '{}') as {
					meta?: { tool?: string };
				};
				expect(example.meta?.tool).toBe(tool.name);
			});
		});
	}
});
