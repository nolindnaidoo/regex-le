import { defineConfig } from 'vitest/config';

// Before anything reads a clock. The suite answers the same way on every
// machine: one tool in this family records characterization snapshots in UTC,
// and this lived as a `TZ=UTC` prefix on two package.json scripts — so vitest
// run any other way failed seven of them on a six-hour offset, and CI passed
// only because hosted runners happen to be UTC.
//
// Set here rather than through vitest's `test.env`, which applies inside an
// already-started worker: that sets process.env.TZ and leaves Date on the
// machine's zone, which reads as fixed while still being wrong.
//
// No sibling is named above on purpose — the fleet check normalises a repo's
// own name away, so naming one gives this file two shapes and reports drift
// that is not there.
process.env.TZ = 'UTC';

// Identical in every *-le repo. Paths are glob-based rather than repo-specific
// so this file can be copied across without edits; coverage is measured and
// reported but not gated.
export default defineConfig({
	test: {
		environment: 'node',
		globals: true,
		pool: 'threads',
		env: { TZ: 'UTC' },
		include: ['src/**/*.test.ts'],
		exclude: ['node_modules/**', 'dist/**', 'out-test/**'],
		coverage: {
			provider: 'v8',
			thresholds: {
				lines: 75,
				functions: 80,
				branches: 60,
				statements: 75,
			},
			reporter: ['text', 'json', 'json-summary', 'html', 'lcov'],
			include: ['src/**/*.ts'],
			exclude: [
				'src/**/*.test.ts',
				'src/**/*.bench.ts',
				'src/**/__mocks__/**',
				'src/**/__fixtures__/**',
				'src/**/__snapshots__/**',
				'src/**/__performance__/**',
				'src/**/__data__/**',
				'src/i18n/**',
				'src/types.ts',
			],
		},
	},
	resolve: {
		alias: {
			vscode: new URL('./src/__mocks__/vscode.ts', import.meta.url).pathname,
		},
	},
});
