/**
 * What a folder scan leaves out unless told otherwise.
 *
 * This file is the same in every extension of the family and names none of
 * them. A name is here when it is common and almost never hand-written
 * source: dependency folders, build output, tool caches. Names that are
 * ordinary folders in many projects are not — `bin`, `tmp`, `logs`, `public`
 * — because a project that generates those ignores them in git, and the scan
 * reads `.gitignore`.
 *
 * Each list is a setting's worth of behaviour and can be switched off whole.
 * `alwaysInclude` reads a path whatever these, or `.gitignore`, say.
 */

/** Folders left out wherever they appear. */
export const DEFAULT_EXCLUDED_FOLDERS: readonly string[] = Object.freeze([
	// Version control
	'.git',
	'.hg',
	'.svn',
	// Dependencies
	'node_modules',
	'bower_components',
	'jspm_packages',
	'.pnpm-store',
	'.yarn',
	'vendor',
	'site-packages',
	'Pods',
	'Carthage',
	// Build output
	'dist',
	'build',
	'out',
	'target',
	'_build',
	'_site',
	'dist-newstyle',
	'zig-out',
	'storybook-static',
	'cdk.out',
	'DerivedData',
	'CMakeFiles',
	// Framework output and caches
	'.next',
	'.nuxt',
	'.output',
	'.svelte-kit',
	'.angular',
	'.astro',
	'.docusaurus',
	'.vuepress',
	'.expo',
	'.turbo',
	'.parcel-cache',
	'.cache',
	'.sass-cache',
	'.jekyll-cache',
	'.dart_tool',
	'.pub-cache',
	'.gradle',
	'.kotlin',
	'.cxx',
	'.externalNativeBuild',
	'captures',
	'ephemeral',
	'.symlinks',
	'.swiftpm',
	'.build',
	'.bundle',
	'.stack-work',
	'.zig-cache',
	'.godot',
	'elm-stuff',
	// Deploy tooling
	'.vercel',
	'.netlify',
	'.serverless',
	'.aws-sam',
	'.terraform',
	// Python environments and caches
	'.venv',
	'venv',
	'__pycache__',
	'.tox',
	'.nox',
	'.mypy_cache',
	'.pytest_cache',
	'.ruff_cache',
	'.ipynb_checkpoints',
	'.eggs',
	// Test and coverage output
	'coverage',
	'htmlcov',
	'.nyc_output',
	'.vscode-test',
	// Editor state
	'.idea',
	'.vs',
	'xcuserdata',
]);

/** Generated files left out wherever they appear, as globs. */
export const DEFAULT_EXCLUDED_FILES: readonly string[] = Object.freeze([
	'*.min.js',
	'*.min.css',
	'*.map',
	'*.snap',
	'*.lock',
	'package-lock.json',
	'pnpm-lock.yaml',
	'npm-shrinkwrap.json',
	'go.sum',
	// Written by an IDE or a build, and committed or left beside the source:
	// an Xcode project file is thousands of object ids and no prose.
	'*.pbxproj',
	'*.iml',
	'local.properties',
	'output-metadata.json',
	'.flutter-plugins',
	'.flutter-plugins-dependencies',
	'.packages',
	'Generated.xcconfig',
	'flutter_export_environment.sh',
	'GeneratedPluginRegistrant.*',
]);

/**
 * Generated output that is only recognisable by where it sits, as paths
 * beneath any folder. `report.xml` is an ordinary name; `fastlane/report.xml`
 * is not.
 */
export const DEFAULT_EXCLUDED_PATHS: readonly string[] = Object.freeze([
	'fastlane/report.xml',
	'fastlane/test_output/**',
	'doc/api/**',
]);

/**
 * Extensions of files that are not text.
 *
 * A scan would refuse these anyway once it had read them. Leaving them out by
 * name is what saves reading them. SVG is text and is not here.
 */
export const BINARY_EXTENSIONS: readonly string[] = Object.freeze([
	// Images
	'png',
	'jpg',
	'jpeg',
	'gif',
	'webp',
	'bmp',
	'ico',
	'icns',
	'tiff',
	'avif',
	'heic',
	'psd',
	// Documents and archives
	'pdf',
	'zip',
	'gz',
	'tgz',
	'bz2',
	'xz',
	'7z',
	'rar',
	'tar',
	'jar',
	'war',
	'dmg',
	'iso',
	// Fonts
	'woff',
	'woff2',
	'ttf',
	'otf',
	'eot',
	// Audio and video
	'mp3',
	'mp4',
	'mov',
	'avi',
	'mkv',
	'webm',
	'wav',
	'ogg',
	'flac',
	// Compiled
	'exe',
	'dll',
	'so',
	'dylib',
	'bin',
	'o',
	'a',
	'class',
	'pyc',
	'wasm',
	// Databases
	'db',
	'sqlite',
]);

/**
 * The globs a file search is told to leave out.
 *
 * One glob per name rather than one with a nested `{a,b}` group: the search
 * joins these inside a group of its own, and a group inside a group is not
 * something every matcher reads the same way.
 */
export function excludeGlobs(options: {
	readonly userExcludes: readonly string[];
	readonly useDefaults: boolean;
	readonly skipBinaryFiles: boolean;
}): string[] {
	const globs = [...options.userExcludes];
	if (options.useDefaults) {
		for (const folder of DEFAULT_EXCLUDED_FOLDERS)
			globs.push(`**/${folder}/**`);
		globs.push('**/*.egg-info/**');
		for (const file of DEFAULT_EXCLUDED_FILES) globs.push(`**/${file}`);
		for (const path of DEFAULT_EXCLUDED_PATHS) globs.push(`**/${path}`);
	}
	if (options.skipBinaryFiles)
		for (const extension of BINARY_EXTENSIONS) globs.push(`**/*.${extension}`);
	return globs;
}
