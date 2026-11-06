import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BrokerBeginSubmissionRequestSchema,
  BrokerConsumeRequestSchema,
  SyntheticFakeProviderSubmissionRequestSchema,
} from './broker-ipc.ts';

describe('broker authorizer IPC schemas', () => {
  it('rejects unknown fields, caller-supplied actors, and wrong protocol versions', () => {
    const base = {
      version: 'omnis.broker-authorizer-ipc.v1',
      authorizationId: 'b2262c45-b413-4dd2-8334-427be5ed159d',
      requestId: '723c69b0-05d4-4e5b-a928-15b2406055a5',
      request: {},
    };
    assert.equal(BrokerConsumeRequestSchema.safeParse({ ...base, actor: 'owner' }).success, false);
    assert.equal(BrokerConsumeRequestSchema.safeParse({ ...base, version: 'v2' }).success, false);
  });

  it('bounds request text and rejects NUL bytes before the authorizer store', () => {
    const base = {
      version: 'omnis.broker-authorizer-ipc.v1',
      attemptId: '723c69b0-05d4-4e5b-a928-15b2406055a5',
      envelope: {},
      renderedRequest: `${'x'.repeat(32_000)}\0`,
    };
    assert.equal(BrokerBeginSubmissionRequestSchema.safeParse(base).success, false);
    assert.equal(
      BrokerBeginSubmissionRequestSchema.safeParse({ ...base, renderedRequest: 'x'.repeat(32_001) })
        .success,
      false,
    );
  });

  it('binds synthetic provider payloads to the signed attempt identity', () => {
    assert.equal(
      SyntheticFakeProviderSubmissionRequestSchema.safeParse({
        version: 'omnis.fake-provider.v1',
        attemptId: '723c69b0-05d4-4e5b-a928-15b2406055a5',
        envelope: { claims: { attemptId: 'wrong' } },
        renderedRequest: 'synthetic only',
      }).success,
      false,
    );
  });
});
