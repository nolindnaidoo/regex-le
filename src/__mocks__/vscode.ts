/**
 * Mock VS Code API for unit tests (aliased via vitest.config.ts).
 * Stateful pieces (config store, message log, command registry, opened
 * documents) expose `_reset()`/`_set()` helpers prefixed with
 * underscore — test-only API.
 */

// ---------------------------------------------------------------- Uri

export class Uri {
	constructor(
		public scheme: string,
		public authority: string,
		public path: string,
	) {}

	get fsPath(): string {
		return this.path;
	}

	toString(): string {
		return `${this.scheme}://${this.authority}${this.path}`;
	}

	static file(path: string): Uri {
		return new Uri('file', '', path);
	}

	static parse(value: string): Uri {
		const match = value.match(/^(\w+):\/\/([^/]*)(.*)$/);
		if (match?.[1] && match[2] !== undefined && match[3] !== undefined) {
			return new Uri(match[1], match[2], match[3]);
		}
		return new Uri('file', '', value);
	}
}

// --------------------------------------------- positions and ranges

export class Position {
	constructor(
		public readonly line: number,
		public readonly character: number,
	) {}
}

export class Range {
	constructor(
		public readonly start: Position,
		public readonly end: Position,
	) {}
}

// ---------------------------------------------------------- documents

export interface MockDocumentInit {
	readonly content: string;
	readonly languageId?: string;
	readonly fileName?: string;
}

export function _createDocument(init: MockDocumentInit) {
	const content = init.content;
	const lines = content.split('\n');
	return {
		getText: () => content,
		languageId: init.languageId ?? 'plaintext',
		fileName: init.fileName ?? '/mock/document.txt',
		uri: Uri.file(init.fileName ?? '/mock/document.txt'),
		lineCount: lines.length,
	};
}

export type MockDocument = ReturnType<typeof _createDocument>;

// ------------------------------------------------------ configuration

const configStore = new Map<string, unknown>();

export function _setConfig(key: string, value: unknown): void {
	configStore.set(key, value);
}

export const ConfigurationTarget = {
	Global: 1,
	Workspace: 2,
	WorkspaceFolder: 3,
};

type ConfigListener = (event: {
	affectsConfiguration: (section: string) => boolean;
}) => void;
const configListeners: ConfigListener[] = [];

export function _fireConfigChange(section: string): void {
	for (const listener of configListeners) {
		listener({
			affectsConfiguration: (candidate: string) =>
				section === candidate || section.startsWith(`${candidate}.`),
		});
	}
}

// --------------------------------------------------------- workspace

const openedDocuments: MockDocument[] = [];

export function _openedDocuments(): readonly MockDocument[] {
	return openedDocuments;
}

export const workspace = {
	getConfiguration: (section?: string) => ({
		get: <T>(key: string, defaultValue?: T): T | undefined => {
			const full = section ? `${section}.${key}` : key;
			return configStore.has(full)
				? (configStore.get(full) as T)
				: defaultValue;
		},
		update: async (key: string, value: unknown) => {
			const full = section ? `${section}.${key}` : key;
			configStore.set(full, value);
		},
	}),
	onDidChangeConfiguration: (listener: ConfigListener) => {
		configListeners.push(listener);
		return {
			dispose: () => {
				const index = configListeners.indexOf(listener);
				if (index >= 0) configListeners.splice(index, 1);
			},
		};
	},
	openTextDocument: async (options?: {
		content?: string;
		language?: string;
	}) => {
		const document = _createDocument({
			content: options?.content ?? '',
			languageId: options?.language ?? 'plaintext',
		});
		openedDocuments.push(document);
		return document;
	},
};

// ------------------------------------------------------------ window

export interface ShownMessage {
	readonly kind: 'info' | 'warning' | 'error';
	readonly message: string;
	readonly items: readonly unknown[];
}

const shownMessages: ShownMessage[] = [];
let activeTextEditor: { document: MockDocument } | undefined;
let quickPickResponder: ((items: unknown[]) => unknown) | undefined;
let warningResponder: ((items: unknown[]) => unknown) | undefined;
let inputBoxResponder: (() => string | undefined) | undefined;

export function _shownMessages(): readonly ShownMessage[] {
	return shownMessages;
}

export function _setActiveEditor(document: MockDocument | undefined): void {
	activeTextEditor = document ? { document } : undefined;
}

export function _respondToQuickPick(
	responder: ((items: unknown[]) => unknown) | undefined,
): void {
	quickPickResponder = responder;
}

export function _respondToWarning(
	responder: ((items: unknown[]) => unknown) | undefined,
): void {
	warningResponder = responder;
}

/** Values an input-box validator refused, in order. */
const inputBoxRejections: Array<{ value: string; message: string }> = [];

export function _inputBoxRejections(): readonly {
	value: string;
	message: string;
}[] {
	return inputBoxRejections;
}

export function _respondToInputBox(
	responder: (() => string | undefined) | undefined,
): void {
	inputBoxResponder = responder;
}

export interface MockOutputChannel {
	readonly name: string;
	readonly _lines: string[];
	appendLine(line: string): void;
	show(): void;
	dispose(): void;
}

const outputChannels: MockOutputChannel[] = [];

export function _outputChannels(): readonly MockOutputChannel[] {
	return outputChannels;
}

export const StatusBarAlignment = { Left: 1, Right: 2 };
export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2 };
export const ProgressLocation = { Notification: 15 };

export const window = {
	get activeTextEditor() {
		return activeTextEditor;
	},
	showInformationMessage: async (message: string, ...items: unknown[]) => {
		shownMessages.push({ kind: 'info', message, items });
		return undefined;
	},
	showWarningMessage: async (message: string, ...items: unknown[]) => {
		shownMessages.push({ kind: 'warning', message, items });
		return warningResponder?.(items);
	},
	showErrorMessage: async (message: string, ...items: unknown[]) => {
		shownMessages.push({ kind: 'error', message, items });
		return undefined;
	},
	showQuickPick: async (items: unknown[], _options?: unknown) =>
		quickPickResponder ? quickPickResponder(items) : undefined,
	showInputBox: async (options?: unknown) => {
		const value = inputBoxResponder ? inputBoxResponder() : undefined;

		// VS Code runs validateInput against what the user types and refuses to
		// accept a value the validator rejects — the box stays open until the
		// input is valid or the user escapes. Ignoring it leaves the validators
		// uncovered AND lets a test hand a command a value the real UI would
		// never deliver.
		const validate = (options as { validateInput?: (v: string) => unknown })
			?.validateInput;
		if (typeof validate === 'function' && typeof value === 'string') {
			const message = validate(value);
			if (message !== undefined && message !== null && message !== '') {
				inputBoxRejections.push({ value, message: String(message) });
				return undefined;
			}
		}
		return value;
	},
	showTextDocument: async (_document: unknown, _column?: unknown) => undefined,
	withProgress: async <T>(
		_options: unknown,
		task: (
			progress: { report: (value: unknown) => void },
			token: { isCancellationRequested: boolean },
		) => Promise<T>,
	): Promise<T> =>
		task({ report: () => {} }, { isCancellationRequested: false }),
	createOutputChannel: (name: string): MockOutputChannel => {
		const _lines: string[] = [];
		const channel: MockOutputChannel = {
			name,
			_lines,
			appendLine: (line: string) => _lines.push(line),
			show: () => {},
			dispose: () => {},
		};
		outputChannels.push(channel);
		return channel;
	},
	createStatusBarItem: (_alignment?: unknown, _priority?: number) => ({
		text: '',
		tooltip: '',
		command: undefined as unknown,
		visible: false,
		show(): void {
			(this as { visible: boolean }).visible = true;
		},
		hide(): void {
			(this as { visible: boolean }).visible = false;
		},
		dispose: () => {},
	}),
};

// ---------------------------------------------------------- commands

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();

export function _registeredCommands(): ReadonlyMap<
	string,
	(...args: unknown[]) => unknown
> {
	return registeredCommands;
}

export const commands = {
	registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
		registeredCommands.set(id, handler);
		return {
			dispose: () => {
				registeredCommands.delete(id);
			},
		};
	},
	executeCommand: async (id: string, ...args: unknown[]) => {
		const handler = registeredCommands.get(id);
		if (handler) return handler(...args);
		executedBuiltins.push({ id, args });
		return undefined;
	},
};

export const executedBuiltins: Array<{ id: string; args: unknown[] }> = [];

// --------------------------------------------------------------- env

const clipboard = { value: '' };
let clipboardError: Error | undefined;

/** Make the next clipboard write reject. */
export function _setClipboardError(error: Error | undefined): void {
	clipboardError = error;
}

export const env = {
	clipboard: {
		writeText: async (text: string) => {
			// The clipboard is the one output the OS can refuse — a remote or
			// headless session. Without a way to fail it, every handler for that
			// case was unreachable.
			if (clipboardError) throw clipboardError;
			clipboard.value = text;
		},
		readText: async () => clipboard.value,
	},
};

export function _clipboardText(): string {
	return clipboard.value;
}

// ------------------------------------------------- extension context

export function _createExtensionContext() {
	const globalStateStore = new Map<string, unknown>();
	return {
		subscriptions: [] as Array<{ dispose(): void }>,
		globalState: {
			get: <T>(key: string, defaultValue?: T): T | undefined =>
				globalStateStore.has(key)
					? (globalStateStore.get(key) as T)
					: defaultValue,
			update: async (key: string, value: unknown) => {
				globalStateStore.set(key, value);
			},
		},
	};
}

export type MockExtensionContext = ReturnType<typeof _createExtensionContext>;

/** Reset all mutable mock state between tests. */
export function _resetMockState(): void {
	clipboardError = undefined;
	inputBoxRejections.length = 0;
	configStore.clear();
	configListeners.length = 0;
	shownMessages.length = 0;
	openedDocuments.length = 0;
	outputChannels.length = 0;
	executedBuiltins.length = 0;
	registeredCommands.clear();
	activeTextEditor = undefined;
	quickPickResponder = undefined;
	warningResponder = undefined;
	inputBoxResponder = undefined;
	clipboard.value = '';
}

export const l10n = {
	t(message: string, ...args: unknown[]): string {
		if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
			const named = args[0] as Record<string, unknown>;
			return message.replace(/\{(\w+)\}/g, (whole, key) =>
				key in named ? String(named[key]) : whole,
			);
		}
		return message.replace(/\{(\d+)\}/g, (whole, index) => {
			const value = args[Number(index)];
			return value === undefined ? whole : String(value);
		});
	},
};
