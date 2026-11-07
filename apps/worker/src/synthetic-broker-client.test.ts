import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { SyntheticTaskRunRequest } from '@omnis/contracts/synthetic-task-run';
import { SyntheticBrokerClient } from './synthetic-broker-client.ts';

const taskId = 'task-0001';
const authorizationId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';

const request = {
  version: 'omnis.synthetic-task-run.v1',
  authorizationId,
  requestId,
  request: {
    projectId: `prj_${'a'.repeat(32)}`,
    projectRevision: 1,
    taskId,
    taskRevision: 1,
    agentId: 'fixture-agent',
    profileVersion: 1,
    connectorId: 'synthetic.codex.fixture',
    connectorVersion: '0.0.0-synthetic.1',
    providerId: 'synthetic',
    modelId: 'synthetic-text-only-v1',
    operation: 'connector.respond',
    capabilities: [],
    limits: {
      maxInputTokens: 100,
      maxOutputTokens: 100,
      maxDurationSeconds: 30,
      maxConcurrentRuns: 1,
      maxUsageUnits: 100,
      maxCostMicrousd: 100,
    },
    promptDigest: `sha256:${'b'.repeat(64)}`,
  },
  renderedRequest: 'synthetic task run',
} as const satisfies SyntheticTaskRunRequest;

describe('synthetic broker worker client', () => {
  it('uses only the fixed local broker socket and maps unreported usage to unknown', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'omnis-broker-worker-'));
    const socketPath = path.join(directory, 'broker.sock');
    let observed: {
      url: string | undefined;
      authorization: string | undefined;
      body: Record<string, unknown> | undefined;
    } = { url: undefined, authorization: undefined, body: undefined };
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        observed = {
          url: req.url,
          authorization: req.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            attemptId: '44444444-4444-4444-8444-444444444444',
            correlationId: '55555555-5555-4555-8555-555555555555',
            status: 'completed',
            submitted: true,
            responseText: 'Synthetic response',
          }),
        );
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      const result = await new SyntheticBrokerClient(socketPath, 'a'.repeat(64)).execute(
        taskId,
        request,
      );
      assert.equal(observed.url, '/internal/broker/v1/submit');
      assert.equal(observed.authorization, `Bearer ${'a'.repeat(64)}`);
      assert.equal('ownerId' in (observed.body ?? {}), false);
      assert.equal(result.status, 'completed');
      assert.deepEqual(result.usage, {
        kind: 'unknown',
        reason: 'not_reported',
        billingExposure: 'unknown',
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects task mutation before opening the broker socket', async () => {
    const client = new SyntheticBrokerClient('/tmp/unused-broker.sock', 'a'.repeat(64));
    await assert.rejects(client.execute('task-0002', request), /task binding failed/);
  });

  it('rejects an uncertain broker response without the persisted correlation identity', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'omnis-broker-worker-'));
    const socketPath = path.join(directory, 'broker.sock');
    const server = createServer((_req, res) => {
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          attemptId: '44444444-4444-4444-8444-444444444444',
          status: 'unknown',
          submitted: true,
        }),
      );
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      await assert.rejects(
        new SyntheticBrokerClient(socketPath, 'a'.repeat(64)).execute(taskId, request),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
