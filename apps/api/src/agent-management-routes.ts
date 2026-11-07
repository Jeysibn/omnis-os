import type { FastifyInstance } from 'fastify';
import {
  AgentIdSchema,
  AgentMutationReceiptSchema,
  AgentIdentityUpdateReceiptSchema,
  AgentProfileDraftResponseSchema,
  AgentIdempotencyKeySchema,
  CreateAgentInputSchema,
  PublishAgentProfileInputSchema,
  SaveAgentProfileDraftInputSchema,
  UpdateAgentIdentityInputSchema,
} from '@omnis/contracts';
import { requireMutationProtection, requireOwner } from './auth.ts';
import { authorizerRequest } from './authorizer-client.ts';

type AuthorizerRequest = typeof authorizerRequest;
const invalid = { error: { code: 'invalid_input', message: 'Agent management input is invalid.' } };

export function registerAgentManagementRoutes(
  app: FastifyInstance,
  request: AuthorizerRequest = authorizerRequest,
) {
  const mutationPreHandler = [requireOwner, requireMutationProtection];
  function idempotencyKey(value: unknown): string | undefined {
    const parsed = AgentIdempotencyKeySchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  }

  app.get<{ Params: { agentId: string } }>(
    '/api/v1/agents/:agentId/draft-profile',
    { preHandler: requireOwner },
    async (httpRequest, reply) => {
      const agentId = AgentIdSchema.safeParse(httpRequest.params.agentId);
      if (!agentId.success) return reply.code(422).send(invalid);
      return request(
        `/internal/v1/agents/${encodeURIComponent(agentId.data)}/draft-profile`,
        {},
        (value) => AgentProfileDraftResponseSchema.parse(value),
      );
    },
  );

  app.post('/api/v1/agents', { preHandler: mutationPreHandler }, async (httpRequest, reply) => {
    const body = CreateAgentInputSchema.safeParse(httpRequest.body);
    const key = idempotencyKey(httpRequest.headers['idempotency-key']);
    if (!body.success || !key) return reply.code(422).send(invalid);
    const receipt = await request(
      '/internal/v1/agents',
      { method: 'POST', headers: { 'idempotency-key': key }, body: JSON.stringify(body.data) },
      (value) => AgentMutationReceiptSchema.parse(value),
    );
    return reply.code(201).send(receipt);
  });

  app.put<{ Params: { agentId: string } }>(
    '/api/v1/agents/:agentId/draft-profile',
    { bodyLimit: 64 * 1024, preHandler: mutationPreHandler },
    async (httpRequest, reply) => {
      const agentId = AgentIdSchema.safeParse(httpRequest.params.agentId);
      const body = SaveAgentProfileDraftInputSchema.safeParse(httpRequest.body);
      const key = idempotencyKey(httpRequest.headers['idempotency-key']);
      if (!agentId.success || !body.success || !key) return reply.code(422).send(invalid);
      const receipt = await request(
        `/internal/v1/agents/${encodeURIComponent(agentId.data)}/draft-profile`,
        { method: 'PUT', headers: { 'idempotency-key': key }, body: JSON.stringify(body.data) },
        (value) => AgentMutationReceiptSchema.parse(value),
      );
      return reply.send(receipt);
    },
  );

  app.post<{ Params: { agentId: string } }>(
    '/api/v1/agents/:agentId/publish',
    { preHandler: mutationPreHandler },
    async (httpRequest, reply) => {
      const agentId = AgentIdSchema.safeParse(httpRequest.params.agentId);
      const body = PublishAgentProfileInputSchema.safeParse(httpRequest.body);
      const key = idempotencyKey(httpRequest.headers['idempotency-key']);
      if (!agentId.success || !body.success || !key) return reply.code(422).send(invalid);
      const receipt = await request(
        `/internal/v1/agents/${encodeURIComponent(agentId.data)}/publish`,
        { method: 'POST', headers: { 'idempotency-key': key }, body: JSON.stringify(body.data) },
        (value) => AgentMutationReceiptSchema.parse(value),
      );
      return reply.code(201).send(receipt);
    },
  );

  app.post<{ Params: { agentId: string } }>(
    '/api/v1/agents/:agentId/archive',
    { preHandler: mutationPreHandler },
    async (httpRequest, reply) => {
      const agentId = AgentIdSchema.safeParse(httpRequest.params.agentId);
      const key = idempotencyKey(httpRequest.headers['idempotency-key']);
      if (!agentId.success || !key) return reply.code(422).send(invalid);
      const receipt = await request(
        `/internal/v1/agents/${encodeURIComponent(agentId.data)}/archive`,
        { method: 'POST', headers: { 'idempotency-key': key } },
        (value) => AgentMutationReceiptSchema.parse(value),
      );
      return reply.send(receipt);
    },
  );

  app.put<{ Params: { agentId: string } }>(
    '/api/v1/agents/:agentId/identity',
    { preHandler: mutationPreHandler },
    async (httpRequest, reply) => {
      const agentId = AgentIdSchema.safeParse(httpRequest.params.agentId);
      const body = UpdateAgentIdentityInputSchema.safeParse(httpRequest.body);
      const key = idempotencyKey(httpRequest.headers['idempotency-key']);
      if (!agentId.success || !body.success || !key) return reply.code(422).send(invalid);
      const receipt = await request(
        `/internal/v1/agents/${encodeURIComponent(agentId.data)}/identity`,
        {
          method: 'PUT',
          headers: { 'idempotency-key': key },
          body: JSON.stringify(body.data),
        },
        (value) => AgentIdentityUpdateReceiptSchema.parse(value),
      );
      return reply.send(receipt);
    },
  );
}
