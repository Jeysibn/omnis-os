import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { VerificationKey } from '@omnis/contracts/connector-broker';
import {
  createSyntheticFakeProviderServer,
  FakeProviderFixturesSchema,
} from './fake-provider-app.ts';

const tokenPath = process.env.OMNIS_FAKE_PROVIDER_TOKEN_FILE;
const token = tokenPath ? readFileSync(tokenPath, 'utf8').trim() : undefined;
if (!token || token.length < 32) throw new Error('Synthetic fake-provider token is required.');
const fixtures = FakeProviderFixturesSchema.parse(
  JSON.parse(process.env.OMNIS_FAKE_PROVIDER_FIXTURES ?? '{}') as unknown,
);
const trustAnchors = readTrustAnchors(process.env.OMNIS_FAKE_PROVIDER_TRUST_ANCHORS ?? '[]');
createSyntheticFakeProviderServer({ token, fixtures, trustAnchors }).listen(8787, '0.0.0.0');

function readTrustAnchors(source: string): VerificationKey[] {
  const schema = z
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
    .max(8);
  return schema.parse(JSON.parse(source) as unknown).map((entry) => ({
    keyId: entry.keyId,
    publicKey: createPublicKey(entry.publicKeyPem),
    notBefore: entry.notBefore,
    notAfter: entry.notAfter,
  }));
}
