import { expect, test } from '@playwright/test';
import {
  runtimeCapabilities,
  type WorkerExecutionStatus,
} from '@omnis/contracts/runtime-capabilities';
import {
  checkRefusal,
  describeExecution,
  fixtureAllowed,
  runAllowed,
  syntheticFixtureOffered,
} from './executionCapability.js';

const worker = (over: Partial<WorkerExecutionStatus>): WorkerExecutionStatus => ({
  version: 'omnis.worker-execution-status.v1',
  serviceAvailability: 'healthy',
  executionMode: 'mock',
  queueAvailability: 'available',
  launcherAvailability: 'available',
  ...over,
});
const ready = (input: Parameters<typeof runtimeCapabilities>[0]) =>
  ({ status: 'ready', capabilities: runtimeCapabilities(input) }) as const;
const disabledWorker = worker({
  executionMode: 'disabled',
  queueAvailability: 'not_required',
  launcherAvailability: 'not_required',
});

test('loading and failed capability states never allow a Run', () => {
  expect(describeExecution({ status: 'loading' })).toMatchObject({
    kind: 'loading',
    canStartRun: false,
  });
  expect(describeExecution({ status: 'error', message: 'x' })).toMatchObject({
    kind: 'load_failed',
    canStartRun: false,
  });
});

test('disabled execution is distinct from unavailable services', () => {
  const disabled = describeExecution(
    ready({
      apiExecutionMode: 'disabled',
      workerStatus: disabledWorker,
      authorizationAvailable: false,
      syntheticConnectorEnabled: false,
    }),
  );
  expect(disabled.kind).toBe('disabled');
  expect(disabled.canStartRun).toBe(false);
  expect(disabled.detail).not.toMatch(/fail/i);

  const noWorker = describeExecution(
    ready({
      apiExecutionMode: 'mock',
      authorizationAvailable: true,
      syntheticConnectorEnabled: false,
    }),
  );
  expect(noWorker.kind).toBe('worker_unavailable');

  const noAuth = describeExecution(
    ready({
      apiExecutionMode: 'mock',
      workerStatus: worker({}),
      authorizationAvailable: false,
      syntheticConnectorEnabled: false,
    }),
  );
  expect(noAuth.kind).toBe('authorizer_unavailable');

  const noQueue = describeExecution(
    ready({
      apiExecutionMode: 'mock',
      workerStatus: worker({ queueAvailability: 'unavailable' }),
      authorizationAvailable: true,
      syntheticConnectorEnabled: false,
    }),
  );
  expect(noQueue.kind).toBe('unavailable');
});

test('only an available mock capability allows Runs, and the fixture needs its own flag', () => {
  const base = {
    apiExecutionMode: 'mock' as const,
    workerStatus: worker({}),
    authorizationAvailable: true,
  };
  const plain = ready({ ...base, syntheticConnectorEnabled: false });
  expect(describeExecution(plain)).toMatchObject({ kind: 'mock_ready', canStartRun: true });
  expect(syntheticFixtureOffered(plain)).toBe(false);
  expect(syntheticFixtureOffered(ready({ ...base, syntheticConnectorEnabled: true }))).toBe(true);
  expect(describeExecution(plain).title.toLowerCase()).toContain('synthetic');
});

test('overlapping dependency failures are attributed in precedence order', () => {
  const mismatch = describeExecution(
    ready({
      apiExecutionMode: 'mock',
      workerStatus: disabledWorker,
      authorizationAvailable: false,
      syntheticConnectorEnabled: false,
    }),
  );
  expect(mismatch.kind).toBe('mode_mismatch');
  expect(mismatch.canStartRun).toBe(false);
  expect(mismatch.detail).toContain('Owner approvals are also unavailable');

  const queueOnlyWithAuthDown = describeExecution(
    ready({
      apiExecutionMode: 'mock',
      workerStatus: worker({ queueAvailability: 'unavailable' }),
      authorizationAvailable: false,
      syntheticConnectorEnabled: false,
    }),
  );
  expect(queueOnlyWithAuthDown.kind).toBe('unavailable');
  expect(queueOnlyWithAuthDown.detail).toContain('queue is not ready');
  expect(queueOnlyWithAuthDown.detail).toContain('approvals are also unavailable');
  expect(queueOnlyWithAuthDown.detail).not.toMatch(/Execution itself is not disabled/);

  const both = describeExecution(
    ready({
      apiExecutionMode: 'mock',
      workerStatus: worker({
        queueAvailability: 'unavailable',
        launcherAvailability: 'unavailable',
      }),
      authorizationAvailable: true,
      syntheticConnectorEnabled: false,
    }),
  );
  expect(both.detail).toContain('queue and launcher are not ready');
  expect(both.detail).not.toContain('approvals');

  const launcherOnly = describeExecution(
    ready({
      apiExecutionMode: 'mock',
      workerStatus: worker({ launcherAvailability: 'unavailable' }),
      authorizationAvailable: true,
      syntheticConnectorEnabled: false,
    }),
  );
  expect(launcherOnly.detail).toContain('launcher is not ready');

  // Authorizer-specific message only when it is the sole failure.
  expect(
    describeExecution(
      ready({
        apiExecutionMode: 'mock',
        workerStatus: worker({}),
        authorizationAvailable: false,
        syntheticConnectorEnabled: false,
      }),
    ).kind,
  ).toBe('authorizer_unavailable');

  // Worker down wins over everything else.
  expect(
    describeExecution(
      ready({
        apiExecutionMode: 'mock',
        authorizationAvailable: false,
        syntheticConnectorEnabled: false,
      }),
    ).kind,
  ).toBe('worker_unavailable');
});

test('only a current, available check can authorize; superseded and failed fail closed', () => {
  const base = {
    apiExecutionMode: 'mock' as const,
    workerStatus: worker({}),
    authorizationAvailable: true,
  };
  const current = (input: Parameters<typeof runtimeCapabilities>[0]) =>
    ({ status: 'current', capabilities: runtimeCapabilities(input) }) as const;
  const available = current({ ...base, syntheticConnectorEnabled: true });
  expect(runAllowed(available)).toBe(true);
  expect(fixtureAllowed(available)).toBe(true);
  // An "available" payload that was superseded must never authorize anything.
  for (const check of [{ status: 'superseded' }, { status: 'failed' }] as const) {
    expect(runAllowed(check)).toBe(false);
    expect(fixtureAllowed(check)).toBe(false);
    expect(checkRefusal(check)).not.toMatch(/available$/);
  }
  expect(fixtureAllowed(current({ ...base, syntheticConnectorEnabled: false }))).toBe(false);
  const disabled = current({
    apiExecutionMode: 'disabled',
    workerStatus: disabledWorker,
    authorizationAvailable: true,
    syntheticConnectorEnabled: true,
  });
  expect(runAllowed(disabled)).toBe(false);
  expect(fixtureAllowed(disabled)).toBe(false);
  expect(checkRefusal(disabled)).toBe('Execution is disabled');
});
