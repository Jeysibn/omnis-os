import assert from 'node:assert/strict';
import test from 'node:test';
import { getGitHubMaskCommands } from './mask-test-credentials.mjs';

test('registers a distinct GitHub Actions mask for each disposable database credential', () => {
  const commands = getGitHubMaskCommands();
  assert.equal(commands.length, 5);
  assert.equal(new Set(commands).size, commands.length);
  assert.ok(commands.every((command) => command.startsWith('::add-mask::')));
});
