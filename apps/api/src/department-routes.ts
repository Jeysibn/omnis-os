import type { FastifyInstance } from 'fastify';
import {
  CreateDepartmentSchema,
  DepartmentIdSchema,
  DepartmentListQuerySchema,
  DepartmentListResponseSchema,
  DepartmentSchema,
  UpdateDepartmentSchema,
} from '@omnis/contracts';
import { requireMutationProtection, requireOwner } from './auth.ts';
import { authorizerRequest } from './authorizer-client.ts';

type AuthorizerRequest = typeof authorizerRequest;

export function registerDepartmentRoutes(
  app: FastifyInstance,
  request: AuthorizerRequest = authorizerRequest,
) {
  app.get('/api/v1/departments', { preHandler: requireOwner }, async (httpRequest, reply) => {
    const query = DepartmentListQuerySchema.safeParse(httpRequest.query);
    if (!query.success) {
      return reply.code(422).send({
        error: { code: 'invalid_input', message: 'Department query parameters are invalid.' },
      });
    }
    const suffix = query.data.includeArchived === 'true' ? '?includeArchived=true' : '';
    return request(`/internal/v1/departments${suffix}`, {}, (value) =>
      DepartmentListResponseSchema.parse(value),
    );
  });

  app.post(
    '/api/v1/departments',
    { preHandler: [requireOwner, requireMutationProtection] },
    async (httpRequest, reply) => {
      const body = CreateDepartmentSchema.safeParse(httpRequest.body);
      if (!body.success) {
        return reply.code(422).send({
          error: { code: 'invalid_input', message: 'Department input is invalid.' },
        });
      }
      const department = await request(
        '/internal/v1/departments',
        { method: 'POST', body: JSON.stringify(body.data) },
        (value) => DepartmentSchema.parse(value),
      );
      return reply.code(201).send(department);
    },
  );

  app.patch<{ Params: { departmentId: string } }>(
    '/api/v1/departments/:departmentId',
    { preHandler: [requireOwner, requireMutationProtection] },
    async (httpRequest, reply) => {
      const id = DepartmentIdSchema.safeParse(httpRequest.params.departmentId);
      const body = UpdateDepartmentSchema.safeParse(httpRequest.body);
      if (!id.success || !body.success) {
        return reply.code(422).send({
          error: { code: 'invalid_input', message: 'Department update is invalid.' },
        });
      }
      const department = await request(
        `/internal/v1/departments/${encodeURIComponent(id.data)}`,
        { method: 'PATCH', body: JSON.stringify(body.data) },
        (value) => DepartmentSchema.parse(value),
      );
      return reply.send(department);
    },
  );

  app.post<{ Params: { departmentId: string } }>(
    '/api/v1/departments/:departmentId/archive',
    { preHandler: [requireOwner, requireMutationProtection] },
    async (httpRequest, reply) => {
      const id = DepartmentIdSchema.safeParse(httpRequest.params.departmentId);
      if (!id.success) {
        return reply.code(422).send({
          error: { code: 'invalid_input', message: 'Department identifier is invalid.' },
        });
      }
      const department = await request(
        `/internal/v1/departments/${encodeURIComponent(id.data)}/archive`,
        { method: 'POST' },
        (value) => DepartmentSchema.parse(value),
      );
      return reply.send(department);
    },
  );
}
