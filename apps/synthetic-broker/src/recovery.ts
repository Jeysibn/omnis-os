import type { AuthorizerClient } from './authorizer-client.ts';
import type { FakeProviderClient } from './fake-provider-client.ts';
import { reconcileAttempt } from './reconcile-attempt.ts';

/** Reconciles durable synthetic attempts without ever replaying an external submission. */
export async function reconcileDurableAttempts(
  authorizer: Pick<AuthorizerClient, 'recovery' | 'record'>,
  provider: Pick<FakeProviderClient, 'events' | 'cancel'>,
): Promise<void> {
  for (let cursor: string | null = null; ;) {
    const page = await authorizer.recovery(100, cursor);
    for (const attempt of page) {
      await reconcileAttempt(authorizer, provider, attempt);
    }
    if (page.length < 100) break;
    cursor = page.at(-1)!.id;
  }
}
