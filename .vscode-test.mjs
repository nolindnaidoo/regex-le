import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out-test/**/*.test.js',
	version: 'stable',
	launchArgs: ['--disable-extensions'],
	mocha: {
		ui: 'bdd',
		timeout: 30_000,
	},
});
