import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadAuthorizerDecisionSigningKey } from './decision-signing-key.ts';

describe('authorizer decision signing key custody', () => {
  it('loads an owner-only Ed25519 key without exposing its material in metadata', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'omnis-authorizer-key-'));
    const file = path.join(dir, 'decision-key.pem');
    try {
      const pair = generateKeyPairSync('ed25519');
      await writeFile(file, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
        mode: 0o600,
      });
      await chmod(file, 0o600);
      const loaded = await loadAuthorizerDecisionSigningKey({
        filePath: file,
        keyId: 'synthetic-test-key',
        notBefore: '2026-11-05T00:00:00.000Z',
        notAfter: '2026-11-07T00:00:00.000Z',
      });
      assert.equal(loaded.privateKey.asymmetricKeyType, 'ed25519');
      assert.equal(
        JSON.stringify({ keyId: loaded.keyId, notBefore: loaded.notBefore }).includes(
          'PRIVATE KEY',
        ),
        false,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects group-readable or invalid key material', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'omnis-authorizer-key-'));
    const file = path.join(dir, 'decision-key.pem');
    try {
      const pair = generateKeyPairSync('ed25519');
      await writeFile(file, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
        mode: 0o640,
      });
      await chmod(file, 0o640);
      await assert.rejects(
        loadAuthorizerDecisionSigningKey({
          filePath: file,
          keyId: 'synthetic-test-key',
          notBefore: '2026-11-05T00:00:00.000Z',
          notAfter: '2026-11-07T00:00:00.000Z',
        }),
        /owner-only regular file/,
      );
      await chmod(file, 0o600);
      await writeFile(file, 'not a private key', { mode: 0o600 });
      await assert.rejects(
        loadAuthorizerDecisionSigningKey({
          filePath: file,
          keyId: 'synthetic-test-key',
          notBefore: '2026-11-05T00:00:00.000Z',
          notAfter: '2026-11-07T00:00:00.000Z',
        }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a symlink in place of the private-key file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'omnis-authorizer-key-'));
    const target = path.join(dir, 'target.pem');
    const file = path.join(dir, 'decision-key.pem');
    try {
      const pair = generateKeyPairSync('ed25519');
      await writeFile(target, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
        mode: 0o600,
      });
      await symlink(target, file);
      await assert.rejects(
        loadAuthorizerDecisionSigningKey({
          filePath: file,
          keyId: 'synthetic-test-key',
          notBefore: '2026-11-05T00:00:00.000Z',
          notAfter: '2026-11-07T00:00:00.000Z',
        }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
