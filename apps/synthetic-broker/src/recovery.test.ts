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
    brokerGeneration: 1,
    brokerLeaseExpiresAt: now,
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
        async claim() {
          return {
            version: 'omnis.broker-authorizer-ipc.v1',
            owned: true,
            attempt: { ...item, brokerLeaseExpiresAt: now },
          };
        },
        async record(_attemptId, _brokerInstanceId, _generation, event) {
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
      'c22db4c2-27bc-4b1d-a73e-236199111111',
    );

    assert.deepEqual(lookedUp, [item.id, 'synthetic-known']);
    assert.deepEqual(recorded, [completion]);
  });

  it('does not reconcile a submitting attempt until the durable recovery claim resolves it', async () => {
    const item = attempt('submitting');
    let providerCalls = 0;

    await reconcileDurableAttempts(
      {
        async recovery() {
          return [item];
        },
        async claim() {
          return {
            version: 'omnis.broker-authorizer-ipc.v1',
            owned: true,
            attempt: {
              ...item,
              status: 'unknown' as const,
              brokerGeneration: item.brokerGeneration + 1,
              brokerLeaseExpiresAt: null,
            },
          };
        },
        async record() {
          throw new Error('an unknown attempt without a provider ID must not be recorded');
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
      'c22db4c2-27bc-4b1d-a73e-236199111111',
    );

    assert.equal(providerCalls, 0);
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
        async claim() {
          return { version: 'omnis.broker-authorizer-ipc.v1', owned: true, attempt: item };
        },
        async record(_attemptId, _brokerInstanceId, _generation, event) {
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
      'c22db4c2-27bc-4b1d-a73e-236199111111',
    );

    assert.equal(eventLookups, 0);
    assert.deepEqual(recorded, [interruption]);
  });
});
