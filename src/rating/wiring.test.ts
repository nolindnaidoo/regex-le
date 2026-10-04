import { beforeEach, describe, expect, it } from 'vitest';
import {
	_createDocument,
	_createExtensionContext,
	_registeredCommands,
	_resetMockState,
	_setActiveEditor,
} from '../__mocks__/vscode';
import { activate } from '../extension';
import { RATING_STATE_KEY } from '../ui/ratingPrompt';
import { parseRatingState } from './policy';

/**
 * The prompt's own tests cover when it asks. This covers the one thing they
 * cannot: that the real command, registered by the real activate(), counts a
 * delivered result and nothing else.
 */

function activated() {
	const context = _createExtensionContext();
	activate(context as never);
	const uses = (): number =>
		parseRatingState(context.globalState.get(RATING_STATE_KEY)).uses;
	return { uses };
}

async function run(): Promise<void> {
	const handler = _registeredCommands().get('regex-le.extract');
	if (!handler) throw new Error('command not registered: regex-le.extract');
	await handler();
}

beforeEach(() => {
	_resetMockState();
});

describe('rating prompt wiring', () => {
	it('counts a run that delivered its result', async () => {
		const { uses } = activated();
		_setActiveEditor(
			_createDocument({
				content: 'const re = /ab+c/gi;',
				languageId: 'javascript',
			}),
		);
		await run();
		await expect.poll(uses).toBe(1);
	});

	it('does not count a run that delivered nothing', async () => {
		const { uses } = activated();
		_setActiveEditor(undefined);
		await run();
		// recordSuccess is not awaited by the command, so give a wrongly-fired
		// one the same chance to land as the test above gives a correct one.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(uses()).toBe(0);
	});
});
