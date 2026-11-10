import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { collectPreflight } from './wsl2-acceptance-preflight.mjs';

test('available WSL2 and Docker versions never imply acceptance', () => {
  const calls = [];
  const result = collectPreflight({
    kernel: '6.6.87.2-microsoft-standard-WSL2',
    run: (command, args) => {
      calls.push([command, ...args]);
      if (command === 'git') return args[0] === 'diff' ? '' : 'a'.repeat(40);
      return '29.9.1';
    },
  });
  assert.equal(result.wsl2KernelDetected, true);
  assert.equal(result.trackedTreeClean, true);
  assert.equal(result.commit, 'a'.repeat(40));
  assert.equal(result.dockerServer, '29.9.1');
  assert.equal(result.verdict, 'BLOCKED');
  assert.equal(result.targetHostVerification, 'NOT TESTED');
  assert.equal(calls.length, 5);
});

test('missing prerequisites and unexpected output fail closed without diagnostics leakage', () => {
  for (const run of [
    () => {
      throw new Error('secret-fixture');
    },
    () => 'secret-fixture',
  ]) {
    const result = collectPreflight({ run, kernel: '7.2.10-fedora' });
    assert.equal(result.wsl2KernelDetected, false);
    assert.equal(result.trackedTreeClean, false);
    assert.equal(result.commit, null);
    assert.equal(result.dockerServer, null);
    assert.equal(result.verdict, 'BLOCKED');
    assert.ok(!JSON.stringify(result).includes('secret-fixture'));
  }
});

test('CLI emits machine-readable blocked inventory and nonzero exit', () => {
  assert.throws(
    () => execFileSync(process.execPath, ['scripts/compose/wsl2-acceptance-preflight.mjs']),
    (error) => {
      assert.equal(error.status, 2);
      assert.equal(JSON.parse(error.stdout.toString()).verdict, 'BLOCKED');
      assert.equal(error.stderr.length, 0);
      return true;
    },
  );
});
