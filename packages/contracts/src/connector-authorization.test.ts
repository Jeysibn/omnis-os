import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ConnectorAuthorizationDecisionSchema,
  ConnectorAuthorizationRequestSchema,
  CreateConnectorAuthorizationSchema,
  createRenderedRequestDigest,
} from './connector-authorization.ts';

const request = {
  projectId: 'prj_0123456789abcdef0123456789abcdef',
  projectRevision: 2,
  taskId: 'task-0001',
  taskRevision: 3,
  agentId: 'agent_0001',
  profileVersion: 4,
  promptDigest: `sha256:${'a'.repeat(64)}`,
  connectorId: 'synthetic.codex.fixture',
  connectorVersion: '0.0.0-synthetic.1',
  providerId: 'synthetic',
  modelId: 'synthetic-text-only-v1',
  operation: 'connector.respond',
  capabilities: [],
  limits: {
    maxInputTokens: 4_000,
    maxOutputTokens: 1_000,
    maxDurationSeconds: 120,
    maxConcurrentRuns: 1,
    maxUsageUnits: 10_000,
    maxCostMicrousd: 1_000_000,
  },
};

describe('synthetic connector authorization contracts', () => {
  it('accepts only the fixed synthetic connector and empty capability scope', () => {
    assert.deepEqual(ConnectorAuthorizationRequestSchema.parse(request), request);
    assert.equal(
      ConnectorAuthorizationRequestSchema.safeParse({
        ...request,
        capabilities: ['shell.execute'],
      }).success,
      false,
    );
  });

  it('rejects live connector identity and unexpected authority fields', () => {
    assert.equal(
      ConnectorAuthorizationRequestSchema.safeParse({ ...request, providerId: 'openai' }).success,
      false,
    );
    assert.equal(
      ConnectorAuthorizationRequestSchema.safeParse({ ...request, actor: 'owner' }).success,
      false,
    );
  });

  it('requires bounded exact request digests and resource limits', () => {
    assert.equal(
      ConnectorAuthorizationRequestSchema.safeParse({
        ...request,
        promptDigest: 'sha256:short',
      }).success,
      false,
    );
    assert.equal(
      ConnectorAuthorizationRequestSchema.safeParse({
        ...request,
        limits: { ...request.limits, maxConcurrentRuns: 2 },
      }).success,
      false,
    );
  });

  it('hashes the exact rendered request without storing it in the grant contract', () => {
    const { promptDigest, ...binding } = request;
    assert.match(promptDigest, /^sha256:[0-9a-f]{64}$/);
    const parsed = CreateConnectorAuthorizationSchema.parse({
      ...binding,
      renderedRequest: 'Read the synthetic task and return a short answer.',
    });
    assert.equal(parsed.renderedRequest, 'Read the synthetic task and return a short answer.');
    assert.equal('promptDigest' in parsed, false);
    assert.notEqual(
      createRenderedRequestDigest(parsed.renderedRequest),
      createRenderedRequestDigest(`${parsed.renderedRequest} `),
    );
  });

  it('requires digest confirmation for owner approval', () => {
    assert.equal(
      ConnectorAuthorizationDecisionSchema.safeParse({ decision: 'approve' }).success,
      false,
    );
    assert.equal(
      ConnectorAuthorizationDecisionSchema.safeParse({
        decision: 'approve',
        promptDigestConfirmation: request.promptDigest,
      }).success,
      true,
    );
    assert.equal(
      ConnectorAuthorizationDecisionSchema.safeParse({
        decision: 'deny',
        promptDigestConfirmation: request.promptDigest,
      }).success,
      false,
    );
  });
});
