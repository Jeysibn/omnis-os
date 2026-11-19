import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deserialize, serialize } from 'node:v8';
import { URL, fileURLToPath } from 'node:url';
import { captureCheckpointEvidence, verifyCheckpointEvidence } from './checkpoint-a-evidence.mjs';

const runnerSource = readFileSync(
  fileURLToPath(new URL('./checkpoint-a-evidence.mjs', import.meta.url)),
);
const runnerSha256 = createHash('sha256').update(runnerSource).digest('hex');
const commands = [
  {
    id: 'C01',
    command: 'synthetic-c01',
    timeoutMs: 1000,
    allowedClassifications: ['match', 'mismatch'],
  },
  {
    id: 'C02',
    command: 'synthetic-c02',
    timeoutMs: 1000,
    allowedClassifications: ['match', 'mismatch'],
  },
];
const commandSourceSha256 = createHash('sha256').update(JSON.stringify(commands)).digest('hex');
const manifest = { commands, commandSourceSha256, runnerSha256 };

function chunksFrom(text, chunkSize = 1024) {
  const source = Buffer.from(text);
  return (async function* () {
    for (let offset = 0; offset < source.length; offset += chunkSize) {
      yield source.subarray(offset, offset + chunkSize);
    }
  })();
}

function syntheticAdapter({
  failId,
  srStatus = 0,
  ambiguous = false,
  reportError = false,
  timeoutId,
  output = 'RAW SYNTHETIC OUTPUT',
  monotonicStep = 1,
} = {}) {
  let tick = 0;
  const executed = [];
  return {
    executed,
    now: () => new Date(Date.UTC(2026, 10, 19, 0, 0, tick++)).toISOString(),
    monotonicNow: () => tick * monotonicStep,
    execute: async (command, limits) => {
      executed.push(command.id);
      assert.equal(limits.timeoutMs, command.timeoutMs);
      assert.equal(typeof limits.signal.addEventListener, 'function');
      const timedOut = command.id === timeoutId;
      const exitStatus = timedOut ? null : command.id === failId ? 1 : 0;
      return {
        stdoutChunks: chunksFrom(`${output} ${command.id}`),
        completion: Promise.resolve({ exitStatus, timedOut }),
      };
    },
    reportStatus: async (exitStatus) => {
      if (reportError) throw new Error('synthetic SR failure');
      return { exitStatus: srStatus === 0 ? exitStatus : srStatus };
    },
    classify: (command, stdout) => {
      assert.ok(Buffer.isBuffer(stdout));
      assert.match(stdout.toString(), /^RAW SYNTHETIC OUTPUT /);
      return ambiguous ? 'unexpected' : command.id === 'C01' ? 'match' : 'mismatch';
    },
  };
}

test('captures ordered identities, bounded chunks, monotonic/wall times and paired statuses', async () => {
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
  assert.deepEqual(
    result.events.map((event) => event.sequence),
    [1, 2],
  );
  assert.ok(
    result.events.every(
      (event) =>
        event.startedAt < event.commandFinishedAt &&
        event.commandFinishedAt <= event.statusReportedAt,
    ),
  );
  assert.ok(
    result.events.every(
      (event) =>
        event.startedTick < event.commandFinishedTick &&
        event.commandFinishedTick <= event.statusReportedTick,
    ),
  );
  assert.ok(!JSON.stringify(result).includes('RAW SYNTHETIC OUTPUT'));
  assert.equal(verifyCheckpointEvidence(result), true);
  assert.deepEqual(adapter.executed, ['C01', 'C02']);
});

test('stops on command failure and marks the run partial', async () => {
  const adapter = syntheticAdapter({ failId: 'C01' });
  const result = await captureCheckpointEvidence(manifest, adapter);
  assert.equal(result.state, 'partial');
  assert.equal(result.stopReason, 'command_nonzero');
  assert.equal(result.events.length, 1);
  assert.ok(Number.isSafeInteger(result.stoppedTick));
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

test('bounds output capture to a fixed byte budget', async () => {
  const adapter = syntheticAdapter({ output: 'x'.repeat(16 * 1024 + 1) });
  const result = await captureCheckpointEvidence(manifest, adapter);
  assert.equal(result.state, 'partial');
  assert.equal(result.stopReason, 'stdout_too_large');
  assert.equal(result.commandId, 'C01');
  assert.equal('classification' in result.events[0], false);
  assert.ok(!JSON.stringify(result).includes('x'.repeat(100)));
  assert.deepEqual(adapter.executed, ['C01']);
});

test('marks timed out commands unknown and does not retry', async () => {
  const adapter = syntheticAdapter({ timeoutId: 'C01' });
  const result = await captureCheckpointEvidence(manifest, adapter);
  assert.equal(result.state, 'partial');
  assert.equal(result.stopReason, 'command_timeout');
  assert.equal(result.events[0].exitStatus, null);
  assert.deepEqual(adapter.executed, ['C01']);
});

test('detects evidence record mutation', async () => {
  const result = await captureCheckpointEvidence(manifest, syntheticAdapter());
  const modified = deserialize(serialize(result));
  modified.events[0].classification = 'mismatch';
  assert.equal(verifyCheckpointEvidence(modified), false);
});

test('verification fails closed for malformed or non-serializable evidence', async () => {
  assert.equal(verifyCheckpointEvidence(null), false);
  const circular = { events: [] };
  circular.self = circular;
  circular.recordSha256 = 'a'.repeat(64);
  assert.equal(verifyCheckpointEvidence(circular), false);
});

test('rejects an oversized stream chunk before retaining it', async () => {
  const adapter = syntheticAdapter();
  adapter.execute = async (command) => {
    adapter.executed.push(command.id);
    return {
      stdoutChunks: (async function* () {
        yield Buffer.alloc(4 * 1024 + 1);
      })(),
      completion: Promise.resolve({ exitStatus: 0, timedOut: false }),
    };
  };
  const result = await captureCheckpointEvidence(manifest, adapter);
  assert.equal(result.state, 'partial');
  assert.equal(result.stopReason, 'stdout_too_large');
  assert.deepEqual(adapter.executed, ['C01']);
  assert.ok(!JSON.stringify(result).includes('x'.repeat(100)));
});

test('stops before executing the next command when monotonic time regresses', async () => {
  const adapter = syntheticAdapter();
  let reads = 0;
  adapter.monotonicNow = () => [10, 11, 12, 13, 12][reads++];
  const result = await captureCheckpointEvidence(manifest, adapter);
  assert.equal(result.state, 'partial');
  assert.equal(result.stopReason, 'clock_regression');
  assert.equal(result.commandId, 'C02');
  assert.deepEqual(adapter.executed, ['C01']);
});

test('rejects a reordered or edited event chain', async () => {
  const result = await captureCheckpointEvidence(manifest, syntheticAdapter());
  const reordered = deserialize(serialize(result));
  reordered.events.reverse();
  assert.equal(verifyCheckpointEvidence(reordered), false);
  const edited = deserialize(serialize(result));
  edited.events[0].commandSha256 = 'f'.repeat(64);
  assert.equal(verifyCheckpointEvidence(edited), false);
});

test('waits for executor termination after output overflow before paired status report', async () => {
  const order = [];
  const adapter = syntheticAdapter();
  adapter.execute = async (_command, { signal }) => ({
    stdoutChunks: (async function* () {
      try {
        yield Buffer.alloc(4 * 1024);
        yield Buffer.alloc(4 * 1024);
        yield Buffer.alloc(4 * 1024);
        yield Buffer.alloc(4 * 1024);
        yield Buffer.alloc(1);
      } finally {
        order.push(
          signal.aborted ? 'iterator_closed_after_abort' : 'iterator_closed_without_abort',
        );
      }
    })(),
    completion: new Promise((resolve) => {
      signal.addEventListener(
        'abort',
        () => {
          order.push('terminated');
          resolve({ exitStatus: 143, timedOut: false });
        },
        { once: true },
      );
    }),
  });
  adapter.reportStatus = async (exitStatus) => {
    order.push('status');
    assert.deepEqual(order, ['terminated', 'iterator_closed_after_abort', 'status']);
    return { exitStatus };
  };
  const result = await captureCheckpointEvidence(manifest, adapter);
  assert.equal(result.stopReason, 'stdout_too_large');
  assert.deepEqual(order, ['terminated', 'iterator_closed_after_abort', 'status']);
  assert.deepEqual(adapter.executed, []);
});
