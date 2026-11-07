import { createServer, request as httpRequest } from 'node:http';

const socketPath = requiredEnvironment('OMNIS_TEST_BROKER_SOCKET');
const testToken = requiredEnvironment('OMNIS_TEST_BROKER_TOKEN');
const authorizerSocket = requiredEnvironment('OMNIS_TEST_BROKER_AUTHORIZER_SOCKET');
const authorizerToken = requiredEnvironment('OMNIS_TEST_BROKER_AUTHORIZER_TOKEN');
const allowedEnvironment = new Set([
  'HOME',
  'NODE_ENV',
  'PATH',
  'TMPDIR',
  'OMNIS_TEST_BROKER_SOCKET',
  'OMNIS_TEST_BROKER_TOKEN',
  'OMNIS_TEST_BROKER_AUTHORIZER_SOCKET',
  'OMNIS_TEST_BROKER_AUTHORIZER_TOKEN',
]);
if (Object.keys(process.env).some((name) => !allowedEnvironment.has(name))) {
  throw new Error('The synthetic broker fixture received an unexpected environment variable.');
}
const server = createServer((request, response) => {
  void (async () => {
    if (request.method === 'GET' && request.url === '/health') {
      return sendJson(response, 200, { status: 'ok' });
    }
    if (
      request.method !== 'POST' ||
      request.url !== '/internal/broker/v1/submit' ||
      request.headers.authorization !== `Bearer ${testToken}`
    ) {
      return sendJson(response, 401, { error: { code: 'unauthorized' } });
    }

    const input = await readBoundedJson(request, 64 * 1024);
    if (
      !input ||
      input.version !== 'omnis.synthetic-broker.v1' ||
      typeof input.authorizationId !== 'string' ||
      typeof input.requestId !== 'string' ||
      typeof input.renderedRequest !== 'string' ||
      typeof input.request !== 'object' ||
      input.request === null ||
      Object.keys(input).sort().join(',') !==
        'authorizationId,renderedRequest,request,requestId,version'
    ) {
      return sendJson(response, 400, { error: { code: 'invalid_input' } });
    }

    const admission = await authorizerRequest('admissions', {
      version: 'omnis.broker-authorizer-ipc.v1',
      authorizationId: input.authorizationId,
      requestId: input.requestId,
      request: input.request,
    });
    const attemptId = admission.attempt?.id;
    const envelope = admission.envelope;
    if (typeof attemptId !== 'string' || !envelope?.claims) {
      throw new Error('Synthetic authorizer admission response was invalid.');
    }
    await authorizerRequest('submissions/begin', {
      version: 'omnis.broker-authorizer-ipc.v1',
      attemptId,
      envelope,
      renderedRequest: input.renderedRequest,
    });

    const event = {
      eventId: `fixture:${attemptId}:completed`,
      status: 'completed',
      providerSubmissionId: `fixture-${attemptId}`,
      usage: {
        kind: 'measured',
        source: 'synthetic-provider',
        inputUnits: 12,
        outputUnits: 7,
        billingExposure: 'synthetic-only',
      },
      responseText: 'Synthetic provider fixture result.',
    };
    await authorizerRequest('provider-events', {
      version: 'omnis.broker-authorizer-ipc.v1',
      attemptId,
      event,
    });
    return sendJson(response, 200, {
      attemptId,
      status: event.status,
      submitted: true,
      correlationId: envelope.claims.correlationId,
      responseText: event.responseText,
    });
  })().catch(() => {
    if (!response.headersSent) sendJson(response, 503, { error: { code: 'fixture_unavailable' } });
    else response.destroy();
  });
});

server.listen(socketPath);
const shutdown = () => server.close(() => process.exit(0));
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

function authorizerRequest(operation, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    if (payload.length > 64 * 1024) return reject(new Error('Authorizer request too large.'));
    const request = httpRequest(
      {
        socketPath: authorizerSocket,
        path: `/internal/broker/v1/${operation}`,
        method: 'POST',
        headers: {
          authorization: `Bearer ${authorizerToken}`,
          'x-omnis-service-identity': 'omnis-synthetic-broker',
          'content-type': 'application/json',
          'content-length': payload.length,
          connection: 'close',
        },
        timeout: 3_000,
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 64 * 1024)
            return response.destroy(new Error('Authorizer response too large.'));
          chunks.push(chunk);
        });
        response.on('end', () => {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode !== 200)
            return reject(new Error('Authorizer IPC rejected request.'));
          resolve(value);
        });
      },
    );
    request.once('error', reject);
    request.end(payload);
  });
}

async function readBoundedJson(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('Synthetic broker request exceeded its limit.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
  response.end(JSON.stringify(value));
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error('The synthetic broker fixture configuration is incomplete.');
  return value;
}
