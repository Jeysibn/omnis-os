import type { FastifyInstance } from 'fastify';
import {
  AgentDirectoryQuerySchema,
  AgentIdSchema,
  AgentVersionQuerySchema,
  AgentVersionRouteParamSchema,
} from '@omnis/contracts';
import { requireOwner } from './auth.ts';
import {
  parseAgentDirectory,
  parseAgentProfile,
  parseAgentVersion,
  parseAgentVersions,
  workerRequest,
} from './worker-client.ts';

type WorkerRequest = typeof workerRequest;

export function registerAgentReadRoutes(
  app: FastifyInstance,
  request: WorkerRequest = workerRequest,
) {
  app.get('/api/v1/agents', { preHandler: requireOwner }, async (httpRequest, reply) => {
    const query = AgentDirectoryQuerySchema.safeParse(httpRequest.query);
    if (!query.success)
      return reply.code(422).send({
        error: { code: 'invalid_input', message: 'Agent directory query parameters are invalid.' },
      });
    return request('/internal/v1/agents', {}, parseAgentDirectory);
  });
  app.get<{ Params: { agentId: string } }>(
    '/api/v1/agents/:agentId',
    { preHandler: requireOwner },
    async (httpRequest, reply) => {
      const agentId = AgentIdSchema.safeParse(httpRequest.params.agentId);
      const query = AgentDirectoryQuerySchema.safeParse(httpRequest.query);
      if (!agentId.success || !query.success)
        return reply.code(422).send({
          error: { code: 'invalid_input', message: 'Agent identifier is invalid.' },
        });
      return request(
        `/internal/v1/agents/${encodeURIComponent(agentId.data)}`,
        {},
        parseAgentProfile,
      );
    },
  );
  app.get<{ Params: { agentId: string; version: string } }>(
    '/api/v1/agents/:agentId/versions/:version',
    { preHandler: requireOwner },
    async (httpRequest, reply) => {
      const agentId = AgentIdSchema.safeParse(httpRequest.params.agentId);
      const version = AgentVersionRouteParamSchema.safeParse(httpRequest.params.version);
      const query = AgentDirectoryQuerySchema.safeParse(httpRequest.query);
      if (!agentId.success || !version.success || !query.success)
        return reply.code(422).send({
          error: { code: 'invalid_input', message: 'Agent profile version identifier is invalid.' },
        });
      return request(
        `/internal/v1/agents/${encodeURIComponent(agentId.data)}/versions/${version.data}`,
        {},
        parseAgentVersion,
      );
    },
  );
  app.get<{ Params: { agentId: string } }>(
    '/api/v1/agents/:agentId/versions',
    { preHandler: requireOwner },
    async (httpRequest, reply) => {
      const agentId = AgentIdSchema.safeParse(httpRequest.params.agentId);
      const query = AgentVersionQuerySchema.safeParse(httpRequest.query);
      if (!agentId.success || !query.success)
        return reply.code(422).send({
          error: { code: 'invalid_input', message: 'Agent version history query is invalid.' },
        });
      const params = new URLSearchParams();
      if (query.data.cursor) params.set('cursor', query.data.cursor);
      if (query.data.limit !== undefined) params.set('limit', String(query.data.limit));
      const suffix = params.size ? `?${params.toString()}` : '';
      return request(
        `/internal/v1/agents/${encodeURIComponent(agentId.data)}/versions${suffix}`,
        {},
        parseAgentVersions,
      );
    },
  );
}
