import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out-test/**/*.test.js',
	version: 'stable',
	// No GPU process. Under xvfb on a CI runner there is no GPU to start, and
	// the window has sat unresponsive from launch until the test run gave up
	// on it: "CodeWindow: detected unresponsive", sixteen seconds in, before a
	// single test had run. Software rendering has nothing to wait for.
	launchArgs: ['--disable-extensions', '--disable-gpu'],
	mocha: {
		ui: 'bdd',
		timeout: 30_000,
	},
});
