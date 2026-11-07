import type { AuthorizerClient } from './authorizer-client.ts';
import type { FakeProviderClient } from './fake-provider-client.ts';

/** Reconciles durable synthetic attempts without ever replaying an external submission. */
export async function reconcileDurableAttempts(
  authorizer: Pick<AuthorizerClient, 'recovery' | 'record'>,
  provider: Pick<FakeProviderClient, 'events' | 'cancel'>,
): Promise<void> {
  for (let cursor: string | null = null; ;) {
    const page = await authorizer.recovery(100, cursor);
    for (const attempt of page) {
      if (attempt.status === 'submitting') {
        await authorizer.record(attempt.id, {
          eventId: `restart-unknown:${attempt.id}`,
          status: 'unknown',
          usage: { kind: 'unknown', reason: 'submission_uncertain', billingExposure: 'unknown' },
        });
        continue;
      }

      if (
        attempt.cancelRequestedAt &&
        attempt.providerSubmissionId &&
        ['accepted', 'running', 'unknown'].includes(attempt.status)
      ) {
        try {
          const cancellation = await provider.cancel(attempt.id, attempt.providerSubmissionId);
          if (cancellation.cancellation === 'confirmed' && cancellation.event) {
            await authorizer.record(attempt.id, cancellation.event);
          }
        } catch {
          // Without a correlated interrupted event the durable cancellation remains pending.
        }
        continue;
      }

      // A known provider ID makes status lookup safe even when the completion response was lost.
      if (
        attempt.providerSubmissionId &&
        ['accepted', 'running', 'unknown'].includes(attempt.status)
      ) {
        try {
          const completion = await provider.events(attempt.id, attempt.providerSubmissionId);
          await authorizer.record(attempt.id, completion.event);
        } catch {
          // Read-only reconciliation can be retried on the next pass; submission is never repeated.
        }
      }
    }
    if (page.length < 100) break;
    cursor = page.at(-1)!.id;
  }
}
