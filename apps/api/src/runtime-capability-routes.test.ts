import assert from 'node:assert/strict';
import Fastify, { type preHandlerHookHandler } from 'fastify';
import test from 'node:test';
import { RuntimeCapabilitiesSchema } from '@omnis/contracts/synthetic-task-run';
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
    });
    try {
      const response = await app.inject({ url: '/api/v1/runtime-capabilities' });
      assert.equal(response.statusCode, 200);
      const result = RuntimeCapabilitiesSchema.parse(response.json());
      assert.deepEqual(result, {
        version: 'omnis.runtime-capabilities.v1',
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
