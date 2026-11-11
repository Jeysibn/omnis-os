import Fastify from 'fastify';
import {
  AuthorizationSchema,
  AuthorizationDecisionSchema,
  CreateAuthorizationSchema,
  CreateRunSchema,
} from '@omnis/contracts';
import { syntheticTaskRunTestMode } from '@omnis/contracts/synthetic-task-run';
import {
  isOwnerPasswordValid,
  requireMutationProtection,
  requireOwner,
  verifyOrigin,
  verifyCsrf,
} from './auth.ts';
import { authorizerRequest, AuthorizerRequestError } from './authorizer-client.ts';
import { env } from './env.ts';
import { LocalSessionStore } from './session-store.ts';
import { RunEventStreamRegistry } from './run-event-stream-registry.ts';
import { registerRunEventsRoute } from './run-events-route.ts';
import { AuthThrottle } from './auth-throttle.ts';
import { registerAgentReadRoutes } from './agent-routes.ts';
import { registerAgentManagementRoutes } from './agent-management-routes.ts';
import { registerDepartmentRoutes } from './department-routes.ts';
import { registerProjectRoutes } from './project-routes.ts';
import { registerProjectMilestoneRoutes } from './project-milestone-routes.ts';
import { registerProjectEpicRoutes } from './project-epic-routes.ts';
import { registerProjectWorkspaceRoutes } from './project-workspace-routes.ts';
import { registerTaskEpicRoutes } from './task-epic-routes.ts';
import { registerTaskRoutes } from './task-routes.ts';
import { registerConnectorAuthorizationRoutes } from './connector-authorization-routes.ts';
import { registerSyntheticTaskRunRoutes } from './synthetic-task-run-routes.ts';
import { registerRuntimeCapabilityRoutes } from './runtime-capability-routes.ts';
import { registerRunStopRoute } from './run-stop-route.ts';
import {
  parseRun,
  parseRunList,
  workerEventStream,
  workerRequest,
  WorkerRequestError,
} from './worker-client.ts';

const app = Fastify({
  trustProxy: false,
  logger: { redact: ['req.headers.cookie', 'res.headers.set-cookie', 'req.headers.x-omnis-csrf'] },
});
const syntheticBrokerTestMode = syntheticTaskRunTestMode(process.env);
// Memory-backed sessions are limited to this single-owner local mock gate. Durable session storage is a later gate.
const sessions = new LocalSessionStore(env.sessionSecret, env.secureCookies);
const runEventStreams = new RunEventStreamRegistry({ sessions });
const authThrottle = new AuthThrottle();
app.decorateRequest('omnisSession', undefined);
app.addHook('onRequest', async (request, reply) => {
  reply.header('x-content-type-options', 'nosniff');
  reply.header('referrer-policy', 'no-referrer');
  reply.header('x-frame-options', 'DENY');
  reply.header('cache-control', 'no-store');
  if (request.url === '/api/v1/health') return;
  const needsAnonymousSession =
    request.url === '/api/v1/auth/csrf' || request.url === '/api/v1/auth/login';
  const resolved = sessions.resolve(request.headers.cookie, needsAnonymousSession);
  if (resolved.session) request.omnisSession = resolved.session;
  if (resolved.setCookie && resolved.session)
    reply.header('set-cookie', sessions.cookie(resolved.session));
});

app.get('/api/v1/health', async () => ({
  status: 'ok',
  product: 'Omnis OS',
  runtimeMode: 'mock-only',
}));
app.get('/api/v1/auth/csrf', async (request) => {
  return { csrfToken: request.omnisSession?.csrfToken ?? '' };
});
app.post('/api/v1/auth/login', async (request, reply) => {
  if (!verifyOrigin(request) || !verifyCsrf(request)) {
    return reply
      .code(403)
      .send({ error: { code: 'csrf_rejected', message: 'Refresh the page and retry sign in.' } });
  }
  const admission = authThrottle.begin(request.ip);
  if ('retryAfterSeconds' in admission) {
    reply.header('retry-after', admission.retryAfterSeconds);
    return reply.code(429).send({
      error: { code: 'authentication_throttled', message: 'Sign in is temporarily rate limited.' },
    });
  }
  const body: unknown = request.body;
  const password =
    typeof body === 'object' && body !== null && 'password' in body
      ? (body as { password?: unknown }).password
      : undefined;
  try {
    if (!(await isOwnerPasswordValid(password))) {
      authThrottle.failed(request.ip);
      return reply.code(401).send({
        error: { code: 'invalid_credentials', message: 'The owner password is incorrect.' },
      });
    }
    authThrottle.succeeded(request.ip);
  } finally {
    admission.release();
  }
  const rotated = sessions.rotate(request.omnisSession?.id ?? '');
  if (!rotated) {
    return reply
      .code(429)
      .send({ error: { code: 'session_capacity', message: 'Retry sign in shortly.' } });
  }
  request.omnisSession = rotated;
  reply.header('set-cookie', sessions.cookie(rotated));
  return { authenticated: true };
});
app.post(
  '/api/v1/auth/logout',
  { preHandler: [requireOwner, requireMutationProtection] },
  async (request, reply) => {
    if (request.omnisSession) sessions.destroy(request.omnisSession.id);
    reply.header('set-cookie', sessions.clearCookie());
    return reply.code(204).send();
  },
);
app.get<{ Params: { authorizationId: string } }>(
  '/api/v1/authorizations/:authorizationId',
  { preHandler: requireOwner },
  async (request, reply) => {
    if (!/^[0-9a-f-]{36}$/i.test(request.params.authorizationId)) {
      return reply
        .code(400)
        .send({ error: { code: 'invalid_input', message: 'Authorization ID is invalid.' } });
    }
    return authorizerRequest(
      `/internal/v1/authorizations/${encodeURIComponent(request.params.authorizationId)}`,
      {},
      parseAuthorizationResponse,
    );
  },
);
app.post(
  '/api/v1/authorizations',
  { preHandler: [requireOwner, requireMutationProtection] },
  async (request, reply) => {
    const parsed = CreateAuthorizationSchema.safeParse(request.body);
    const idempotencyKey = request.headers['idempotency-key'];
    if (
      !parsed.success ||
      typeof idempotencyKey !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(idempotencyKey)
    )
      return reply.code(400).send({
        error: {
          code: 'invalid_input',
          message: 'Authorization request and Idempotency-Key are required.',
        },
      });
    const authorization = await authorizerRequest(
      '/internal/v1/authorizations',
      {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey },
        body: JSON.stringify(parsed.data),
      },
      parseAuthorizationResponse,
    );
    return reply.code(201).send(authorization);
  },
);
app.post<{ Params: { authorizationId: string } }>(
  '/api/v1/authorizations/:authorizationId/decision',
  { preHandler: [requireOwner, requireMutationProtection] },
  async (request, reply) => {
    const parsed = AuthorizationDecisionSchema.safeParse(request.body);
    if (!parsed.success || !/^[0-9a-f-]{36}$/i.test(request.params.authorizationId))
      return reply
        .code(400)
        .send({ error: { code: 'invalid_input', message: 'Authorization decision is invalid.' } });
    const authorization = await authorizerRequest(
      `/internal/v1/authorizations/${encodeURIComponent(request.params.authorizationId)}/decision`,
      {
        method: 'POST',
        body: JSON.stringify(parsed.data),
      },
      parseAuthorizationResponse,
    );
    return reply.send(authorization);
  },
);
app.post<{ Params: { authorizationId: string } }>(
  '/api/v1/authorizations/:authorizationId/revoke',
  { preHandler: [requireOwner, requireMutationProtection] },
  async (request, reply) => {
    if (!/^[0-9a-f-]{36}$/i.test(request.params.authorizationId))
      return reply
        .code(400)
        .send({ error: { code: 'invalid_input', message: 'Authorization ID is invalid.' } });
    const authorization = await authorizerRequest(
      `/internal/v1/authorizations/${encodeURIComponent(request.params.authorizationId)}/revoke`,
      { method: 'POST' },
      parseAuthorizationResponse,
    );
    return reply.send(authorization);
  },
);

app.get('/api/v1/me', { preHandler: requireOwner }, async () => ({
  id: 'owner',
  displayName: 'Director',
  product: 'Omnis OS',
  authMode: 'local-owner-session',
}));
registerAgentReadRoutes(app);
registerAgentManagementRoutes(app);
registerDepartmentRoutes(app);
registerProjectRoutes(app);
registerProjectMilestoneRoutes(app);
registerProjectEpicRoutes(app);
registerProjectWorkspaceRoutes(app);
registerTaskEpicRoutes(app);
registerTaskRoutes(app, workerRequest, authorizerRequest);
registerConnectorAuthorizationRoutes(app, { requireOwner, requireMutationProtection });
registerRuntimeCapabilityRoutes(app, {
  requireOwner,
  syntheticConnectorEnabled: syntheticBrokerTestMode,
});
registerSyntheticTaskRunRoutes(app, {
  requireOwner,
  requireMutationProtection,
  enabled: syntheticBrokerTestMode,
});
app.get('/api/v1/runs', { preHandler: requireOwner }, async () =>
  workerRequest('/internal/v1/runs', {}, parseRunList),
);
app.post(
  '/api/v1/runs',
  { preHandler: [requireOwner, requireMutationProtection] },
  async (request, reply) => {
    const parsed = CreateRunSchema.safeParse(request.body);
    const idempotencyKey = request.headers['idempotency-key'];
    if (
      !parsed.success ||
      typeof idempotencyKey !== 'string' ||
      idempotencyKey.length < 16 ||
      idempotencyKey.length > 128
    ) {
      return reply.code(400).send({
        error: {
          code: 'invalid_input',
          message: 'A task and valid Idempotency-Key are required.',
        },
      });
    }
    const run = await workerRequest(
      '/internal/v1/runs',
      {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey },
        body: JSON.stringify(parsed.data),
      },
      parseRun,
    );
    return reply.code(run.status === 'queued' ? 201 : 200).send(run);
  },
);
app.get<{ Params: { runId: string } }>(
  '/api/v1/runs/:runId',
  { preHandler: requireOwner },
  async (request) =>
    workerRequest(`/internal/v1/runs/${encodeURIComponent(request.params.runId)}`, {}, parseRun),
);
registerRunStopRoute(app, {
  requireOwner,
  requireMutationProtection,
  syntheticBrokerEnabled: syntheticBrokerTestMode,
});
registerRunEventsRoute(app, {
  sessions,
  streams: runEventStreams,
  requireOwner,
  workerEventStream,
});

app.setErrorHandler((error, request, reply) => {
  if (error instanceof AuthorizerRequestError) return reply.code(error.statusCode).send(error.body);
  if (error instanceof WorkerRequestError) return reply.code(error.statusCode).send(error.body);
  const statusCode =
    error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
  if (request.url.startsWith('/api/v1/agents')) {
    app.log.error(
      { errorType: error instanceof Error ? error.name : 'unknown', requestId: request.id },
      'Agent management request failed.',
    );
    if (statusCode === 413 || statusCode === 400) {
      return reply.code(statusCode).send({
        error: {
          code: statusCode === 413 ? 'payload_too_large' : 'invalid_input',
          message:
            statusCode === 413
              ? 'Agent management request exceeds the allowed size.'
              : 'Agent management request is malformed.',
        },
      });
    }
  } else {
    app.log.error({ err: error, requestId: request.id }, 'API request failed');
  }
  return reply.code(500).send({
    error: {
      code: 'internal_error',
      message: 'The request could not be completed.',
      requestId: request.id,
    },
  });
});

await app.listen({ host: env.host, port: env.port });
app.log.info({ host: env.host, port: env.port }, 'Omnis OS API listening on loopback');

function parseAuthorizationResponse(value: unknown) {
  return AuthorizationSchema.parse(value);
}
