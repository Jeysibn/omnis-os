import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateAllowedUse } from './index.ts';

describe('allowed-use policy', () => {
  it('rejects disabled runtimes and scope escalation', () => {
    assert.deepEqual(evaluateAllowedUse('disabled', 'interactive'), {
      allowed: false,
      reason: 'runtime_disabled',
    });
    assert.deepEqual(evaluateAllowedUse('interactive', 'background'), {
      allowed: false,
      reason: 'use_not_authorized',
    });
  });

  it('allows only the configured use', () => {
    assert.deepEqual(evaluateAllowedUse('interactive', 'interactive'), { allowed: true });
    assert.deepEqual(evaluateAllowedUse('both', 'background'), { allowed: true });
  });
});

describe('authoritative runtime authorization', () => {
  it('fails closed for missing, insufficient, expired, or revoked authorization', async () => {
    const { StaticRuntimeAuthorizer } = await import('./index.ts');
    const grant = {
      id: 'grant-1',
      actorId: 'owner',
      runtimeId: 'mock',
      operation: 'start_task' as const,
      capabilities: ['mock.execute' as const],
      scope: { kind: 'all_tasks' as const },
      approvalRequired: false,
      status: 'authorized' as const,
      policyVersion: 'v1',
      expiresAt: 2000,
      revokedAt: null,
      provenance: 'test',
    };
    const authorizer = new StaticRuntimeAuthorizer([grant]);
    const request = {
      actorId: 'owner',
      runtimeId: 'mock',
      operation: 'start_task' as const,
      requiredCapabilities: ['mock.execute' as const],
      taskId: 'task-0001',
    };
    assert.equal(authorizer.authorize(request, 1500)?.id, 'grant-1');
    assert.equal(
      authorizer.authorize(
        { ...request, requiredCapabilities: ['provider.network' as never] },
        1500,
      ),
      undefined,
    );
    assert.equal(authorizer.authorize(request, 2500), undefined);
    authorizer.revoke('grant-1', 1750);
    assert.equal(authorizer.authorize(request, 1800), undefined);
  });

  it('does not grant authority from adapter-declared capabilities', async () => {
    const { StaticRuntimeAuthorizer } = await import('./index.ts');
    const authorizer = new StaticRuntimeAuthorizer([]);
    assert.equal(
      authorizer.authorize({
        actorId: 'owner',
        runtimeId: 'mock',
        operation: 'start_task',
        requiredCapabilities: ['mock.execute'],
        taskId: 'task-0001',
      }),
      undefined,
    );
  });
});
