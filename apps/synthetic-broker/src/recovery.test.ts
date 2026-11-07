import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { reconcileDurableAttempts } from './recovery.ts';

const now = new Date().toISOString();

function attempt(
  status: 'submitting' | 'accepted' | 'unknown',
  options: { providerSubmissionId?: string | null; cancelRequestedAt?: string | null } = {},
) {
  return {
    id: randomUUID(),
    authorizationId: randomUUID(),
    requestId: randomUUID(),
    status,
    synthetic: true as const,
    createdAt: now,
    submissionStartedAt: status === 'submitting' ? now : null,
    providerSubmissionId: options.providerSubmissionId ?? null,
    cancelRequestedAt: options.cancelRequestedAt ?? null,
  };
}

describe('synthetic broker durable recovery', () => {
  it('reads a correlated provider event after an accepted attempt and persists it', async () => {
    const item = attempt('accepted', { providerSubmissionId: 'synthetic-known' });
    const completion = {
      eventId: 'completed-known',
      status: 'completed' as const,
      providerSubmissionId: 'synthetic-known',
      responseText: 'Recovered synthetic response.',
      usage: {
        kind: 'measured' as const,
        source: 'synthetic-provider' as const,
        billingExposure: 'synthetic-only' as const,
        inputUnits: 1,
        outputUnits: 1,
      },
    };
    const recorded: unknown[] = [];
    let lookedUp: [string, string] | undefined;

    await reconcileDurableAttempts(
      {
        async recovery() {
          return [item];
        },
        async record(_attemptId, event) {
          recorded.push(event);
          return item;
        },
      },
      {
        async events(attemptId, providerSubmissionId) {
          lookedUp = [attemptId, providerSubmissionId];
          return {
            version: 'omnis.fake-provider.v1',
            attemptId,
            event: completion,
          };
        },
        async cancel() {
          throw new Error('no cancellation was requested');
        },
      },
    );

    assert.deepEqual(lookedUp, [item.id, 'synthetic-known']);
    assert.deepEqual(recorded, [completion]);
  });

  it('marks interrupted submission boundaries unknown without resubmitting or looking up', async () => {
    const item = attempt('submitting');
    const recorded: unknown[] = [];
    let providerCalls = 0;

    await reconcileDurableAttempts(
      {
        async recovery() {
          return [item];
        },
        async record(_attemptId, event) {
          recorded.push(event);
          return item;
        },
      },
      {
        async events() {
          providerCalls += 1;
          throw new Error('lookup is unsafe without a durable provider ID');
        },
        async cancel() {
          providerCalls += 1;
          throw new Error('cancellation was not requested');
        },
      },
    );

    assert.deepEqual(recorded, [
      {
        eventId: `restart-unknown:${item.id}`,
        status: 'unknown',
        usage: { kind: 'unknown', reason: 'submission_uncertain', billingExposure: 'unknown' },
      },
    ]);
    assert.equal(providerCalls, 0);
  });

  it('keeps cancellation reconciliation ahead of event polling', async () => {
    const item = attempt('unknown', {
      providerSubmissionId: 'synthetic-cancel',
      cancelRequestedAt: now,
    });
    let eventLookups = 0;
    const interruption = {
      eventId: 'interrupted-known',
      status: 'interrupted' as const,
      providerSubmissionId: 'synthetic-cancel',
    };
    const recorded: unknown[] = [];

    await reconcileDurableAttempts(
      {
        async recovery() {
          return [item];
        },
        async record(_attemptId, event) {
          recorded.push(event);
          return item;
        },
      },
      {
        async events() {
          eventLookups += 1;
          throw new Error('cancellation path should run first');
        },
        async cancel() {
          return {
            version: 'omnis.fake-provider.v1',
            attemptId: item.id,
            cancellation: 'confirmed',
            event: interruption,
          };
        },
      },
    );

    assert.equal(eventLookups, 0);
    assert.deepEqual(recorded, [interruption]);
  });
});
