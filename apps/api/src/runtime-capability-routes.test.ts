import assert from 'node:assert/strict';
import Fastify, { type preHandlerHookHandler } from 'fastify';
import test from 'node:test';
import type { WorkerExecutionStatus } from '@omnis/contracts/runtime-capabilities';
import { RuntimeCapabilitiesSchema } from '@omnis/contracts/runtime-capabilities';
import { registerRuntimeCapabilityRoutes } from './runtime-capability-routes.ts';

const healthyDisabledWorker: WorkerExecutionStatus = {
  version: 'omnis.worker-execution-status.v1',
  serviceAvailability: 'healthy',
  executionMode: 'disabled',
  queueAvailability: 'not_required',
  launcherAvailability: 'not_required',
};
const healthyMockWorker: WorkerExecutionStatus = {
  version: 'omnis.worker-execution-status.v1',
  serviceAvailability: 'healthy',
  executionMode: 'mock',
  queueAvailability: 'available',
  launcherAvailability: 'available',
};

test('reports service health separately from disabled execution and Authorizer availability', async () => {
  const app = Fastify();
  let ownerGuardCalls = 0;
  const requireOwner: preHandlerHookHandler = async () => {
    ownerGuardCalls += 1;
  };
  registerRuntimeCapabilityRoutes(app, {
    requireOwner,
    configuredMode: 'disabled',
    syntheticConnectorEnabled: true,
    getWorkerStatus: async () => healthyDisabledWorker,
    checkAuthorizationDependency: async () => false,
  });
  try {
    const response = await app.inject({ url: '/api/v1/runtime-capabilities' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(RuntimeCapabilitiesSchema.parse(response.json()), {
      version: 'omnis.runtime-capabilities.v3',
      services: { api: 'healthy', worker: 'healthy' },
      execution: {
        configuredMode: 'disabled',
        workerMode: 'disabled',
        capability: 'disabled',
        availability: 'disabled',
        queueAvailability: 'not_required',
        launcherAvailability: 'not_required',
      },
      authorization: { availability: 'unavailable' },
      syntheticConnectorFixture: {
        enabled: false,
        providerId: 'synthetic',
        modelId: 'synthetic-text-only-v1',
        synthetic: true,
      },
    });
    assert.equal(ownerGuardCalls, 1);
  } finally {
    await app.close();
  }
});

test('reports mock execution unavailable when launcher or Authorizer health is unavailable', async () => {
  const app = Fastify();
  registerRuntimeCapabilityRoutes(app, {
    requireOwner: async () => {},
    configuredMode: 'mock',
    syntheticConnectorEnabled: true,
    getWorkerStatus: async () => ({ ...healthyMockWorker, launcherAvailability: 'unavailable' }),
    checkAuthorizationDependency: async () => false,
  });
  try {
    const response = await app.inject({ url: '/api/v1/runtime-capabilities' });
    assert.equal(response.statusCode, 200);
    const capabilities = RuntimeCapabilitiesSchema.parse(response.json());
    assert.deepEqual(capabilities.services, { api: 'healthy', worker: 'healthy' });
    assert.deepEqual(capabilities.execution, {
      configuredMode: 'mock',
      workerMode: 'mock',
      capability: 'mock_synthetic',
      availability: 'unavailable',
      queueAvailability: 'available',
      launcherAvailability: 'unavailable',
    });
    assert.deepEqual(capabilities.authorization, { availability: 'unavailable' });
    assert.equal(capabilities.syntheticConnectorFixture.enabled, false);
  } finally {
    await app.close();
  }
});

test('reports an unavailable worker without claiming disabled or available execution', async () => {
  const app = Fastify();
  registerRuntimeCapabilityRoutes(app, {
    requireOwner: async () => {},
    configuredMode: 'mock',
    syntheticConnectorEnabled: false,
    getWorkerStatus: async () => {
      throw new Error('worker unavailable');
    },
    checkAuthorizationDependency: async () => true,
  });
  try {
    const response = await app.inject({ url: '/api/v1/runtime-capabilities' });
    assert.equal(response.statusCode, 200);
    const capabilities = RuntimeCapabilitiesSchema.parse(response.json());
    assert.deepEqual(capabilities.services, { api: 'healthy', worker: 'unavailable' });
    assert.deepEqual(capabilities.execution, {
      configuredMode: 'mock',
      workerMode: null,
      capability: 'unavailable',
      availability: 'unavailable',
      queueAvailability: 'unknown',
      launcherAvailability: 'unknown',
    });
  } finally {
    await app.close();
  }
});

test('rejects mismatched API and worker mode as unavailable', async () => {
  const app = Fastify();
  registerRuntimeCapabilityRoutes(app, {
    requireOwner: async () => {},
    configuredMode: 'disabled',
    syntheticConnectorEnabled: false,
    getWorkerStatus: async () => healthyMockWorker,
    checkAuthorizationDependency: async () => true,
  });
  try {
    const response = await app.inject({ url: '/api/v1/runtime-capabilities' });
    const capabilities = RuntimeCapabilitiesSchema.parse(response.json());
    assert.deepEqual(capabilities.execution, {
      configuredMode: 'disabled',
      workerMode: 'mock',
      capability: 'unavailable',
      availability: 'unavailable',
      queueAvailability: 'available',
      launcherAvailability: 'available',
    });
  } finally {
    await app.close();
  }
});
