import { createPublicKey } from 'node:crypto';
import { chmod, lstat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { readConfig } from './config.ts';
import { z } from 'zod';
import { AuthorizerClient } from './authorizer-client.ts';
import { FakeProviderClient } from './fake-provider-client.ts';
import { createSyntheticBrokerApp } from './broker-app.ts';
import type { VerificationKey } from '@omnis/contracts/connector-broker';

const config = readConfig();
const verificationKeys = parseTrustAnchors(config.trustAnchors);
const authorizer = new AuthorizerClient(config.authorizerSocketPath, config.authorizerToken);
const provider = new FakeProviderClient(config.providerToken);
await reconcileDurableAttempts();
const app = createSyntheticBrokerApp({
  callerToken: config.callerToken,
  verificationKeys,
  authorizer,
  provider,
});

await mkdir(path.dirname(config.socketPath), { recursive: true, mode: 0o750 });
const existing = await lstat(config.socketPath).catch((error: NodeJS.ErrnoException) =>
  error.code === 'ENOENT' ? undefined : Promise.reject(error),
);
if (existing) {
  if (!existing.isSocket() || existing.uid !== (process.getuid?.() ?? -1))
    throw new Error('Refusing to replace an unowned broker socket.');
  await rm(config.socketPath);
}
await app.listen({ path: config.socketPath });
await chmod(config.socketPath, 0o660);
const recoveryTimer = setInterval(() => {
  void reconcileDurableAttempts().catch(() => undefined);
}, 2_000);
recoveryTimer.unref();

let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  clearInterval(recoveryTimer);
  void app.close().finally(() => rm(config.socketPath, { force: true }));
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

async function reconcileDurableAttempts(): Promise<void> {
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
      }
    }
    if (page.length < 100) break;
    cursor = page.at(-1)!.id;
  }
}

function parseTrustAnchors(source: string): VerificationKey[] {
  const entries = z
    .array(
      z
        .object({
          keyId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
          publicKeyPem: z.string().min(1).max(4096),
          notBefore: z.string().datetime(),
          notAfter: z.string().datetime(),
        })
        .strict(),
    )
    .min(1)
    .max(8)
    .parse(JSON.parse(source) as unknown);
  return entries.map((entry) => ({
    keyId: entry.keyId,
    publicKey: createPublicKey(entry.publicKeyPem),
    notBefore: entry.notBefore,
    notAfter: entry.notAfter,
  }));
}
