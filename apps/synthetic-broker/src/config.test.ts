import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { readConfig } from './config.ts';

const valid = {
  OMNIS_BROKER_SOCKET: '/run/omnis-broker/internal.sock',
  OMNIS_BROKER_CALLER_TOKEN_FILE: '',
  OMNIS_BROKER_AUTHORIZER_SOCKET: '/run/omnis-authorizer/broker.sock',
  OMNIS_BROKER_AUTHORIZER_TOKEN_FILE: '',
  OMNIS_BROKER_TRUST_ANCHORS: '[]',
  OMNIS_FAKE_PROVIDER_TOKEN_FILE: '',
};
type TokenFiles = Omit<
  typeof valid,
  | 'OMNIS_BROKER_CALLER_TOKEN_FILE'
  | 'OMNIS_BROKER_AUTHORIZER_TOKEN_FILE'
  | 'OMNIS_FAKE_PROVIDER_TOKEN_FILE'
> & {
  OMNIS_BROKER_CALLER_TOKEN_FILE: string;
  OMNIS_BROKER_AUTHORIZER_TOKEN_FILE: string;
  OMNIS_FAKE_PROVIDER_TOKEN_FILE: string;
  caller: string;
  authorizer: string;
};

function withTokenFiles(run: (config: TokenFiles) => void) {
  const root = mkdtempSync(path.join(tmpdir(), 'omnis-broker-config-'));
  try {
    const caller = path.join(root, 'caller.token');
    const authorizer = path.join(root, 'authorizer.token');
    const provider = path.join(root, 'provider.token');
    writeFileSync(caller, 'a'.repeat(96), { mode: 0o600 });
    writeFileSync(authorizer, 'b'.repeat(96), { mode: 0o600 });
    writeFileSync(provider, 'synthetic-test-token-00000000000000000000000000000000', {
      mode: 0o600,
    });
    run({
      ...valid,
      OMNIS_BROKER_CALLER_TOKEN_FILE: caller,
      OMNIS_BROKER_AUTHORIZER_TOKEN_FILE: authorizer,
      OMNIS_FAKE_PROVIDER_TOKEN_FILE: provider,
      caller,
      authorizer,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it('loads only explicit token files and ignores unrelated process environment', () => {
  withTokenFiles((files) => {
    const config = readConfig({
      ...files,
      HOME: '/ignored',
      PATH: '/usr/bin',
      OTHER_SECRET: 'must-not-propagate',
    });
    assert.equal(config.socketPath, valid.OMNIS_BROKER_SOCKET);
    assert.equal(config.authorizerSocketPath, valid.OMNIS_BROKER_AUTHORIZER_SOCKET);
    assert.equal(config.callerToken, 'a'.repeat(96));
    assert.equal('OTHER_SECRET' in config, false);
  });
});

it('rejects shared IPC socket paths and malformed credentials', () => {
  withTokenFiles((files) => {
    assert.throws(() =>
      readConfig({ ...files, OMNIS_BROKER_AUTHORIZER_SOCKET: valid.OMNIS_BROKER_SOCKET }),
    );
    writeFileSync(files.caller, 'short');
    assert.throws(() => readConfig(files));
  });
});
