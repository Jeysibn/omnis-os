import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CoordinatorError, RunCoordinator } from './run-coordinator.ts';

describe('mock run coordinator', () => {
  it('keeps request retries on one run and rejects a reused key with different input', () => {
    const coordinator = new RunCoordinator();
    const task = coordinator.createTask({
      title: 'Inspect files',
      detail: 'List files without changing them.',
    });
    const first = coordinator.startRun(task.id, 'idempotency-key-0001');
    const retry = coordinator.startRun(task.id, 'idempotency-key-0001');
    assert.equal(first.run.id, retry.run.id);
    assert.equal(retry.created, false);
    assert.equal(coordinator.listRuns().length, 1);
    assert.throws(
      () => coordinator.startRun('another-task', 'idempotency-key-0001'),
      CoordinatorError,
    );
  });

  it('records stopping until cancellation has been observed as terminal', async () => {
    const coordinator = new RunCoordinator();
    const task = coordinator.createTask({
      title: 'Inspect files',
      detail: 'List files without changing them.',
    });
    const { run } = coordinator.startRun(task.id, 'idempotency-key-0002');
    assert.equal(run.status, 'queued');
    const stopping = coordinator.stopRun(run.id);
    assert.equal(stopping.status, 'stopping');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(coordinator.getRun(run.id)?.status, 'cancelled');
    assert.ok(coordinator.getEvents(run.id).some((event) => event.type === 'run.cancelled'));
  });

  it('rejects a second active run at the worker concurrency cap', async () => {
    const coordinator = new RunCoordinator();
    const firstTask = coordinator.createTask({
      title: 'First task',
      detail: 'Inspect the first safe task.',
    });
    const secondTask = coordinator.createTask({
      title: 'Second task',
      detail: 'Inspect the second safe task.',
    });
    coordinator.startRun(firstTask.id, 'idempotency-key-0003');
    assert.throws(
      () => coordinator.startRun(secondTask.id, 'idempotency-key-0004'),
      (error: unknown) =>
        error instanceof CoordinatorError &&
        error.code === 'concurrency_limit' &&
        error.statusCode === 409,
    );
    coordinator.stopRun('run-0001');
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
});
