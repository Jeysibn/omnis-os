import assert from 'node:assert/strict';
import Fastify, { type preHandlerHookHandler } from 'fastify';
import test from 'node:test';
import { RuntimeCapabilitiesSchema } from '@omnis/contracts/synthetic-task-run';
import { runtimeCapabilities } from '@omnis/contracts/runtime-capabilities';
import { registerRuntimeCapabilityRoutes } from './runtime-capability-routes.ts';

for (const enabled of [false, true]) {
  test(`reports the synthetic connector fixture as ${enabled ? 'available' : 'disabled'}`, async () => {
    const app = Fastify();
    let ownerGuardCalls = 0;
    const requireOwner: preHandlerHookHandler = async () => {
      ownerGuardCalls += 1;
    };
    registerRuntimeCapabilityRoutes(app, {
      requireOwner,
      syntheticConnectorEnabled: enabled,
      getWorkerCapabilities: async () => runtimeCapabilities(false, 'mock'),
    });
    try {
      const response = await app.inject({ url: '/api/v1/runtime-capabilities' });
      assert.equal(response.statusCode, 200);
      const result = RuntimeCapabilitiesSchema.parse(response.json());
      assert.deepEqual(result, {
        version: 'omnis.runtime-capabilities.v2',
        executionMode: 'mock',
        mockRuntime: { enabled: true, synthetic: true },
        syntheticConnectorFixture: {
          enabled,
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
}

test('reports disabled execution and does not advertise the synthetic connector', async () => {
  const app = Fastify();
  registerRuntimeCapabilityRoutes(app, {
    requireOwner: async () => {},
    syntheticConnectorEnabled: true,
    getWorkerCapabilities: async () => runtimeCapabilities(false, 'disabled'),
  });
  try {
    const response = await app.inject({ url: '/api/v1/runtime-capabilities' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(RuntimeCapabilitiesSchema.parse(response.json()), {
      version: 'omnis.runtime-capabilities.v2',
      executionMode: 'disabled',
      mockRuntime: { enabled: false, synthetic: true },
      syntheticConnectorFixture: {
        enabled: false,
        providerId: 'synthetic',
        modelId: 'synthetic-text-only-v1',
        synthetic: true,
      },
    });
  } finally {
    await app.close();
  }
});
