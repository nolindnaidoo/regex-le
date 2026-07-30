import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		globals: true,
		pool: 'threads',
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'html', 'lcov'],
			include: ['src/**/*.ts'],
			exclude: [
				'src/**/*.test.ts',
				'src/**/*.spec.ts',
				'src/__mocks__/**',
				'src/extraction/regex/__fixtures__/**',
			],
		},
		include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
	},
	resolve: {
		alias: {
			vscode: new URL('./src/__mocks__/vscode.ts', import.meta.url).pathname,
			'vscode-nls': new URL('./src/__mocks__/vscode-nls.ts', import.meta.url)
				.pathname,
		},
	},
});
