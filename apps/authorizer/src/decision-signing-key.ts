import { createPrivateKey, type KeyObject } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import {
  signConnectorDecisionEnvelope,
  type ConnectorDecisionEnvelope,
} from '@omnis/contracts/connector-broker';

export type AuthorizerDecisionSigningKey = {
  keyId: string;
  privateKey: KeyObject;
  notBefore: string;
  notAfter: string;
};

export async function loadAuthorizerDecisionSigningKey(input: {
  filePath: string;
  keyId: string;
  notBefore: string;
  notAfter: string;
}): Promise<AuthorizerDecisionSigningKey> {
  const handle = await open(input.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let privateKey: KeyObject;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== (process.getuid?.() ?? -1) || (stat.mode & 0o077) !== 0) {
      throw new Error('Decision signing key must be an owner-only regular file.');
    }
    privateKey = createPrivateKey(await handle.readFile());
  } finally {
    await handle.close();
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Decision signing key must be Ed25519.');
  }
  if (
    !/^[A-Za-z0-9._-]{1,64}$/.test(input.keyId) ||
    !isCanonicalTimestamp(input.notBefore) ||
    !isCanonicalTimestamp(input.notAfter) ||
    Date.parse(input.notAfter) <= Date.parse(input.notBefore)
  ) {
    throw new Error('Decision signing key metadata is invalid.');
  }
  return { ...input, privateKey };
}

export function createAuthorizerDecisionSigner(
  key: AuthorizerDecisionSigningKey,
): (claims: unknown) => ConnectorDecisionEnvelope {
  return (claims) => signConnectorDecisionEnvelope(claims, key);
}

function isCanonicalTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
