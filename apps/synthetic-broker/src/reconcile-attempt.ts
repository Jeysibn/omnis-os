import type { ConnectorExecutionAttempt } from '@omnis/contracts/connector-authorization-schema';
import type { AuthorizerClient } from './authorizer-client.ts';
import type { FakeProviderClient } from './fake-provider-client.ts';

/** Resolves a durable synthetic attempt without replaying a possibly submitted operation. */
export async function reconcileAttempt(
  authorizer: Pick<AuthorizerClient, 'record'>,
  provider: Pick<FakeProviderClient, 'events'> & Partial<Pick<FakeProviderClient, 'cancel'>>,
  attempt: ConnectorExecutionAttempt,
): Promise<ConnectorExecutionAttempt> {
  if (attempt.status === 'submitting') {
    return authorizer.record(attempt.id, {
      eventId: `restart-unknown:${attempt.id}`,
      status: 'unknown',
      usage: { kind: 'unknown', reason: 'submission_uncertain', billingExposure: 'unknown' },
    });
  }

  if (
    attempt.cancelRequestedAt &&
    attempt.providerSubmissionId &&
    ['accepted', 'running', 'unknown'].includes(attempt.status) &&
    provider.cancel
  ) {
    try {
      const cancellation = await provider.cancel(attempt.id, attempt.providerSubmissionId);
      if (cancellation.cancellation === 'confirmed' && cancellation.event) {
        return await authorizer.record(attempt.id, cancellation.event);
      }
    } catch {
      // Without a correlated interruption event, durable cancellation remains pending.
    }
    return attempt;
  }

  // A known provider ID makes status lookup safe even when the completion response was lost.
  if (attempt.providerSubmissionId && ['accepted', 'running', 'unknown'].includes(attempt.status)) {
    try {
      const completion = await provider.events(attempt.id, attempt.providerSubmissionId);
      return await authorizer.record(attempt.id, completion.event);
    } catch {
      // Read-only reconciliation can be retried; provider submission is never repeated.
    }
  }

  return attempt;
}
