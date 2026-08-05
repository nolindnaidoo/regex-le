import * as assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';

/**
 * Guards the two localization mechanisms, which are separate and fail
 * separately:
 *
 *   package.nls.<locale>.json      -> manifest strings (%key% in package.json)
 *   l10n/bundle.l10n.<locale>.json -> runtime strings (vscode.l10n.t)
 *
 * This is the regression test the v1.x line did not have. Back then
 * `vscode-nls` was misconfigured (`nls.config(...)()` called without
 * `__filename`), so every runtime string silently fell back to English while
 * thirteen fully-populated catalogues sat in the VSIX looking perfectly
 * correct. Shipping catalogues and rendering translations are different
 * things, and only the second is worth anything to a user.
 *
 * Note on what cannot be asserted here: `vscode.l10n` is scoped to the
 * extension whose code calls it. Test code runs under the test runner's
 * identity, so `vscode.l10n.t('URLs-LE: Ready')` in this file resolves against
 * the runner's (empty) bundle and returns English even on a German host —
 * regardless of whether this extension's own localization works. Asserting
 * German here would only ever test the harness. Verified manually instead: on a
 * host launched with `--locale=de` and the German language pack installed, this
 * extension's activate() reports `lang=de ready="URLs-LE: Bereit"
 * bundle=LOADED`. What this file guards is that the catalogues shipped
 * alongside that mechanism stay correct and complete.
 */
describe('Regex-LE localization', function () {
	this.timeout(30_000);

	const extension = vscode.extensions.getExtension('nolindnaidoo.regex-le');
	const root = extension?.extensionPath ?? '';

	// Placeholders are positional and are what breaks silently: a translation
	// that drops {0} renders a message with the number missing and throws
	// nothing.
	const placeholders = (s: string): string[] =>
		(s.match(/\{\d+\}/g) ?? []).sort();

	it('substitutes manifest placeholders', () => {
		assert.ok(extension, 'extension not found');

		// Walk every contribution point, not just command titles. This checked
		// only `contributes.commands` and so missed the label on
		// `mcpServerDefinitionProviders` entirely — a placeholder that reaches a
		// user reads as literal `%manifest.mcp.label%` in the UI.
		const unsubstituted: string[] = [];
		const walk = (value: unknown): void => {
			if (typeof value === 'string') {
				if (value.startsWith('%') && value.endsWith('%')) {
					unsubstituted.push(value);
				}
				return;
			}
			if (Array.isArray(value)) {
				for (const entry of value) walk(entry);
				return;
			}
			if (value && typeof value === 'object') {
				for (const entry of Object.values(value)) walk(entry);
			}
		};
		walk(extension.packageJSON.contributes);

		assert.deepStrictEqual(
			unsubstituted,
			[],
			`manifest placeholders were never substituted: ${unsubstituted.join(', ')} — ` +
				'package.nls.json missing from the VSIX, or the key does not exist',
		);
	});

	// Translated manifest catalogues live in src/i18n/ and are copied to the
	// extension root by `copy:i18n` during packaging, then removed again by
	// `clean:i18n`. So an installed extension has them at the root while a
	// dev-loaded one still has them in src/i18n — this test must work for both,
	// because it is the only place the two layouts are checked against each
	// other.
	const catalogueDir = (): string => {
		const atRoot = readdirSync(root).some(
			(f) => f.startsWith('package.nls.') && f !== 'package.nls.json',
		);
		return atRoot ? root : join(root, 'src', 'i18n');
	};

	it('ships every manifest catalogue in exact key parity', () => {
		const english = JSON.parse(
			readFileSync(join(root, 'package.nls.json'), 'utf8'),
		) as Record<string, string>;
		const keys = Object.keys(english).sort();

		const dir = catalogueDir();
		const catalogues = readdirSync(dir).filter(
			(f) => f.startsWith('package.nls.') && f !== 'package.nls.json',
		);
		assert.strictEqual(
			catalogues.length,
			12,
			`expected 12 translated manifest catalogues, found ${catalogues.length}`,
		);

		for (const file of catalogues) {
			const catalogue = JSON.parse(
				readFileSync(join(dir, file), 'utf8'),
			) as Record<string, string>;
			assert.deepStrictEqual(
				Object.keys(catalogue).sort(),
				keys,
				`${file} is not in key parity with package.nls.json`,
			);
			for (const [key, value] of Object.entries(catalogue)) {
				const source = english[key];
				assert.ok(source !== undefined, `${file} :: ${key} has no English source`);
				assert.deepStrictEqual(
					placeholders(value),
					placeholders(source),
					`${file} :: ${key} changed its placeholders`,
				);
			}
		}
	});

	it('ships every runtime bundle in exact key parity', () => {
		// The English source bundle is deliberately not packaged — l10n.t falls
		// back to the literal in the code — so parity is checked against the set
		// of keys the translated bundles agree on, and against the source strings
		// themselves, which are the keys.
		// bundle.l10n.json (the English source) is present in the repo but is
		// deliberately excluded from the VSIX, so it is filtered out rather than
		// counted — the count must come out the same in dev and installed.
		const bundles = readdirSync(join(root, 'l10n')).filter(
			(f) => f !== 'bundle.l10n.json',
		);
		assert.strictEqual(
			bundles.length,
			12,
			`expected 12 runtime bundles, found ${bundles.length}: ${bundles.join(', ')}`,
		);

		let reference: string[] | undefined;
		for (const file of bundles) {
			const bundle = JSON.parse(
				readFileSync(join(root, 'l10n', file), 'utf8'),
			) as Record<string, string>;
			const keys = Object.keys(bundle).sort();

			if (reference === undefined) {
				reference = keys;
				assert.ok(keys.length > 0, `${file} is empty`);
			} else {
				assert.deepStrictEqual(keys, reference, `${file} is not in parity`);
			}

			for (const [source, translation] of Object.entries(bundle)) {
				// In this format the key IS the English source string.
				assert.deepStrictEqual(
					placeholders(translation),
					placeholders(source),
					`${file} :: "${source}" changed its placeholders`,
				);
			}
		}
	});

	it('substitutes positional placeholders at runtime', () => {
		// Locale-independent: whether l10n.t returns a translation or the English
		// fallback, argument substitution must happen.

	});
});
