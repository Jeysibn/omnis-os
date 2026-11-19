import test from 'node:test';
import assert from 'node:assert/strict';
import { captureCheckpointEvidence } from './checkpoint-a-evidence.mjs';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { URL, fileURLToPath } from 'node:url';

const runnerSource = readFileSync(
  fileURLToPath(new URL('./checkpoint-a-evidence.mjs', import.meta.url)),
);
const runnerSha256 = createHash('sha256').update(runnerSource).digest('hex');
const commands = [
  { id: 'C01', command: 'synthetic-c01', allowedClassifications: ['match', 'mismatch'] },
  { id: 'C02', command: 'synthetic-c02', allowedClassifications: ['match', 'mismatch'] },
];
const commandSourceSha256 = createHash('sha256').update(JSON.stringify(commands)).digest('hex');
const manifest = { commands, commandSourceSha256, runnerSha256 };

function syntheticAdapter({
  failId,
  srStatus = 0,
  ambiguous = false,
  reportError = false,
  output,
} = {}) {
  let tick = 0;
  const executed = [];
  return {
    executed,
    now: () => new Date(Date.UTC(2026, 10, 19, 0, 0, tick++)).toISOString(),
    execute: async (command) => {
      executed.push(command.id);
      return {
        stdout: output ?? `RAW SYNTHETIC OUTPUT ${command.id}`,
        exitStatus: command.id === failId ? 1 : 0,
      };
    },
    reportStatus: async (exitStatus) => {
      if (reportError) throw new Error('synthetic SR failure');
      return { exitStatus: srStatus === 0 ? exitStatus : srStatus };
    },
    classify: (command, stdout) => {
      assert.match(stdout, /^RAW SYNTHETIC OUTPUT /);
      return ambiguous ? 'unexpected' : command.id === 'C01' ? 'match' : 'mismatch';
    },
  };
}

test('captures ordered command identity, timestamps and paired statuses without raw output', async () => {
  const adapter = syntheticAdapter();
  const result = await captureCheckpointEvidence(manifest, adapter);
  assert.equal(result.state, 'complete');
  assert.deepEqual(
    result.events.map(({ commandId, exitStatus, statusReport }) => [
      commandId,
      exitStatus,
      statusReport.exitStatus,
    ]),
    [
      ['C01', 0, 0],
      ['C02', 0, 0],
    ],
  );
  assert.ok(result.events.every((event) => event.startedAt < event.finishedAt));
  assert.ok(!JSON.stringify(result).includes('RAW SYNTHETIC OUTPUT'));
  assert.deepEqual(adapter.executed, ['C01', 'C02']);
});

test('stops on command failure and marks the run partial', async () => {
  const adapter = syntheticAdapter({ failId: 'C01' });
  const result = await captureCheckpointEvidence(manifest, adapter);
  assert.equal(result.state, 'partial');
  assert.equal(result.stopReason, 'command_nonzero');
  assert.equal(result.events.length, 1);
  assert.deepEqual(adapter.executed, ['C01']);
});

test('stops on SR mismatch before classification or later commands', async () => {
  const adapter = syntheticAdapter({ srStatus: 7 });
  const result = await captureCheckpointEvidence(manifest, adapter);
  assert.equal(result.state, 'partial');
  assert.equal(result.stopReason, 'status_report_mismatch');
  assert.deepEqual(adapter.executed, ['C01']);
});

test('stops when classification is outside the allowlist', async () => {
  const adapter = syntheticAdapter({ ambiguous: true });
  const result = await captureCheckpointEvidence(manifest, adapter);
  assert.equal(result.stopReason, 'classification_unapproved');
  assert.equal(result.events.length, 1);
  assert.equal('classification' in result.events[0], false);
  assert.deepEqual(adapter.executed, ['C01']);
});

test('rejects command source hash mismatch before invoking the adapter', async () => {
  const adapter = syntheticAdapter();
  await assert.rejects(
    captureCheckpointEvidence({ ...manifest, commandSourceSha256: '0'.repeat(64) }, adapter),
    /command source hash mismatch/,
  );
  assert.deepEqual(adapter.executed, []);
});

test('rejects runner source hash mismatch before invoking the adapter', async () => {
  const adapter = syntheticAdapter();
  await assert.rejects(
    captureCheckpointEvidence({ ...manifest, runnerSha256: '0'.repeat(64) }, adapter),
    /runner source hash mismatch/,
  );
  assert.deepEqual(adapter.executed, []);
});

test('partial status-report failure preserves manifest hashes and command identity', async () => {
  const adapter = syntheticAdapter({ reportError: true });
  const result = await captureCheckpointEvidence(manifest, adapter);
  assert.equal(result.state, 'partial');
  assert.equal(result.stopReason, 'execution_or_status_report_error');
  assert.equal(result.commandId, 'C01');
  assert.equal(result.phase, 'status_report');
  assert.equal(result.commandSourceSha256, commandSourceSha256);
  assert.equal(result.runnerSha256, runnerSha256);
  assert.equal(result.events[0].commandId, 'C01');
  assert.equal(result.events[0].statusReport.exitStatus, null);
  assert.deepEqual(adapter.executed, ['C01']);
});

test('rejects oversized synthetic output without classifying it', async () => {
  const adapter = syntheticAdapter({ output: 'x'.repeat(16 * 1024 + 1) });
  const result = await captureCheckpointEvidence(manifest, adapter);
  assert.equal(result.state, 'partial');
  assert.equal(result.stopReason, 'stdout_too_large');
  assert.equal(result.commandId, 'C01');
  assert.equal('classification' in result.events[0], false);
  assert.ok(!JSON.stringify(result).includes('x'.repeat(100)));
  assert.deepEqual(adapter.executed, ['C01']);
});
