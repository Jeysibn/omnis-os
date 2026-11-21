import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool } from '../../../packages/db/src/index.ts';
import { provisionDatabaseRoles } from '../../../packages/db/src/provision-roles.ts';
import { createRenderedRequestDigest } from '../../../packages/contracts/src/connector-authorization.ts';
import { renderSyntheticConnectorRequest } from '../../../packages/contracts/src/synthetic-connector-prompt.ts';
import { freePort, startMockServices } from './mock-services.mjs';

const databaseUrlKeys = [
  'OMNIS_TEST_ADMIN_DATABASE_URL',
  'OMNIS_TEST_DATABASE_URL',
  'OMNIS_TEST_MIGRATION_DATABASE_URL',
  'OMNIS_TEST_AUTHORIZER_DATABASE_URL',
  'OMNIS_TEST_LAUNCHER_DATABASE_URL',
];
const activeRunStatuses = ['queued', 'running', 'stopping', 'unknown'];

export async function runRevokedWorkerAdmissionScenario() {
  const databaseName = `omnis_worker_revoked_${randomUUID().replaceAll('-', '').slice(0, 12)}_test`;
  const databaseEnvironment = Object.fromEntries(
    databaseUrlKeys.map((key) => [key, databaseUrlForName(process.env[key], databaseName)]),
  );
  const clusterAdmin = createPool({
    connectionString: process.env.OMNIS_TEST_ADMIN_DATABASE_URL,
    max: 1,
    application_name: 'omnis-test-worker-isolation-admin',
  });
  let isolatedAdmin;
  let isolatedServices;
  let databaseCreated = false;
  try {
    await clusterAdmin.query(`CREATE DATABASE ${quoteDatabaseName(databaseName)}`);
    databaseCreated = true;
    isolatedAdmin = createPool({
      connectionString: databaseEnvironment.OMNIS_TEST_ADMIN_DATABASE_URL,
      max: 1,
      application_name: 'omnis-test-worker-isolation-provision',
    });
    await provisionDatabaseRoles(isolatedAdmin, {
      migration: passwordFrom(databaseEnvironment.OMNIS_TEST_MIGRATION_DATABASE_URL),
      runtime: passwordFrom(databaseEnvironment.OMNIS_TEST_DATABASE_URL),
      authorizer: passwordFrom(databaseEnvironment.OMNIS_TEST_AUTHORIZER_DATABASE_URL),
      launcher: passwordFrom(databaseEnvironment.OMNIS_TEST_LAUNCHER_DATABASE_URL),
    });
    await isolatedAdmin.end();
    isolatedAdmin = undefined;

    const frontendPort = await freePort();
    const origin = `http://127.0.0.1:${frontendPort}`;
    isolatedServices = await startMockServices({
      origin,
      reservedPorts: [frontendPort],
      requireAuditPool: true,
      enableSyntheticBrokerTestMode: true,
      enableSyntheticBrokerProcessTestMode: true,
      databaseEnvironment,
    });
    const projectId = await createActiveSyntheticProject(isolatedServices);
    const owner = await createOwnerClient(isolatedServices);
    const fixture = await createRevokedAuthorizationFixture(owner, projectId);
    const dispatch = await postWorkerAdmission(isolatedServices, fixture);
    const replay = await postWorkerAdmission(isolatedServices, fixture);

    assert.equal(dispatch.status, 202, 'direct worker admission should persist a queued Run');
    assert.equal(replay.status, 200, 'same-identity worker replay should resolve the prior Run');
    assert.equal(dispatch.body.created, true);
    assert.equal(replay.body.created, false);
    assert.equal(replay.body.run.id, dispatch.body.run.id);

    let readback = await readWorkerAdmissionState(
      isolatedServices.auditPool,
      dispatch.body.run.id,
      fixture.authorizationId,
      fixture.requestId,
    );
    const deadline = Date.now() + 60_000;
    while (
      readback.runStatus &&
      activeRunStatuses.includes(readback.runStatus) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      readback = await readWorkerAdmissionState(
        isolatedServices.auditPool,
        dispatch.body.run.id,
        fixture.authorizationId,
        fixture.requestId,
      );
    }

    const brokerCalls = isolatedServices.syntheticBrokerCompose.brokerCallCount(fixture.requestId);
    const providerCalls = isolatedServices.syntheticBrokerCompose.assertProviderCallCount(
      fixture.requestId,
      0,
    );
    const activeRunSlotReleased = readback.activeRunSlots === 0;
    process.stdout.write(
      `Revoked-worker direct admission after replay: run_status=${readback.runStatus ?? 'missing'}, active_run_slot_released=${activeRunSlotReleased}, attempts=${readback.attempts}, attempt_ids=${readback.attemptIds.join(',') || 'none'}, reservations=${readback.reservations}, fake_broker_calls=${brokerCalls}, fake_provider_calls=${providerCalls}\n`,
    );
    assert.equal(readback.runCount, 1, 'the worker replay must not create a second Run');
    assert.equal(
      readback.attempts,
      0,
      'revocation-first worker dispatch must not reserve an attempt',
    );
    assert.equal(
      readback.reservations,
      0,
      'revocation-first worker dispatch must not commit a reservation',
    );
    assert.equal(readback.reservationAttemptIds.length, 0);
    isolatedServices.assertSensitiveValuesAbsentFromLogs();
    return { ...readback, activeRunSlotReleased, brokerCalls, providerCalls };
  } finally {
    await isolatedServices?.cleanup();
    await isolatedAdmin?.end().catch(() => undefined);
    if (databaseCreated) {
      await clusterAdmin.query(
        `DROP DATABASE IF EXISTS ${quoteDatabaseName(databaseName)} WITH (FORCE)`,
      );
    }
    await clusterAdmin.end();
  }
}

function databaseUrlForName(value, databaseName) {
  if (typeof value !== 'string' || !value) {
    throw new Error('The isolated worker case requires all disposable test database URLs.');
  }
  const url = new URL(value);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function passwordFrom(value) {
  return decodeURIComponent(new URL(value).password);
}

function quoteDatabaseName(value) {
  if (!/^omnis_worker_revoked_[a-f0-9]{12}_test$/.test(value)) {
    throw new Error(
      'Refusing to create or drop a database outside the revoked-worker test prefix.',
    );
  }
  return `"${value}"`;
}

async function createActiveSyntheticProject(services) {
  const owner = await createOwnerClient(services);
  const project = await owner.request('/api/v1/projects', {
    method: 'POST',
    idempotencyKey: randomUUID(),
    body: {
      key: `SYNTH-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
      name: 'Isolated revoked-worker admission',
      objective: 'Measure direct worker admission after grant revocation.',
    },
  });
  assert.equal(project.status, 201);
  await services.auditPool.query("UPDATE omnis.projects SET status='active' WHERE id=$1", [
    project.body.id,
  ]);
  return project.body.id;
}

async function createOwnerClient(services) {
  const anonymousCsrf = await fetch(`${services.apiUrl}/api/v1/auth/csrf`);
  const anonymousCookie = cookieFrom(anonymousCsrf);
  const anonymousToken = (await anonymousCsrf.json()).csrfToken;
  const login = await fetch(`${services.apiUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: {
      cookie: anonymousCookie,
      origin: services.origin,
      'x-omnis-csrf': anonymousToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ password: services.password }),
  });
  assert.equal(login.status, 200, 'isolated owner login must succeed');
  const cookie = cookieFrom(login);
  const csrfResponse = await fetch(`${services.apiUrl}/api/v1/auth/csrf`, {
    headers: { cookie },
  });
  assert.equal(csrfResponse.status, 200);
  const csrfToken = (await csrfResponse.json()).csrfToken;
  return {
    async request(path, { method = 'GET', body, idempotencyKey } = {}) {
      const headers = { cookie };
      if (method !== 'GET') {
        headers.origin = services.origin;
        headers['x-omnis-csrf'] = csrfToken;
      }
      if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetch(`${services.apiUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const responseBody = await response.json().catch(() => null);
      return { status: response.status, body: responseBody };
    },
  };
}

async function createRevokedAuthorizationFixture(owner, projectId) {
  const taskCreated = await owner.request('/api/v1/tasks', {
    method: 'POST',
    idempotencyKey: randomUUID(),
    body: {
      title: `Revoked worker admission ${randomUUID()}`,
      detail: 'Only a synthetic fake-broker test request.',
    },
  });
  assert.equal(taskCreated.status, 201);
  const taskProject = await owner.request(`/api/v1/tasks/${taskCreated.body.id}/project`, {
    method: 'PUT',
    idempotencyKey: randomUUID(),
    body: {
      projectId,
      expectedAssociationRevision: taskCreated.body.associationRevision,
    },
  });
  assert.equal(taskProject.status, 200);

  const agentCreated = await owner.request('/api/v1/agents', {
    method: 'POST',
    idempotencyKey: randomUUID(),
    body: {
      name: 'Revoked worker test agent',
      slug: `revoked-worker-${randomUUID().slice(0, 8)}`,
      departmentId: null,
    },
  });
  assert.equal(agentCreated.status, 201);
  const profile = {
    profession: 'Synthetic test assistant',
    seniority: null,
    specialties: ['integration testing'],
    personality: { traits: ['careful'], tone: 'plain', principles: ['synthetic data only'] },
    behavior: { autonomy: 'No external actions.', escalation: null },
    instructions: 'Return only the fixed synthetic test fixture.',
  };
  const draft = await owner.request(`/api/v1/agents/${agentCreated.body.agentId}/draft-profile`, {
    method: 'PUT',
    idempotencyKey: randomUUID(),
    body: { expectedDraftRevision: 0, baseVersionNo: null, profile },
  });
  assert.equal(draft.status, 200);
  const published = await owner.request(`/api/v1/agents/${agentCreated.body.agentId}/publish`, {
    method: 'POST',
    idempotencyKey: randomUUID(),
    body: { expectedVersionNo: null, expectedDraftRevision: 1 },
  });
  assert.equal(published.status, 201);
  const profileResponse = await owner.request(
    `/api/v1/agents/${agentCreated.body.agentId}/versions/1`,
  );
  assert.equal(profileResponse.status, 200);
  const profileVersion = profileResponse.body.version;

  const assignment = await owner.request(
    `/api/v1/tasks/${taskProject.body.id}/execution-assignment`,
    {
      method: 'PUT',
      idempotencyKey: randomUUID(),
      body: {
        agentId: profileVersion.agentId,
        profileVersion: profileVersion.versionNo,
        runtimeId: 'mock',
        expectedAssignmentRevision: taskCreated.body.assignmentRevision,
      },
    },
  );
  assert.equal(assignment.status, 200);

  const projectResponse = await owner.request(`/api/v1/projects/${projectId}`);
  assert.equal(projectResponse.status, 200);
  const renderedRequest = renderSyntheticConnectorRequest(assignment.body, profileVersion);
  const limits = {
    maxInputTokens: 100,
    maxOutputTokens: 100,
    maxDurationSeconds: 30,
    maxConcurrentRuns: 1,
    maxUsageUnits: 100,
    maxCostMicrousd: 100,
  };
  const authorizationInput = {
    projectId,
    projectRevision: projectResponse.body.revision,
    taskId: assignment.body.id,
    taskRevision: assignment.body.associationRevision,
    agentId: profileVersion.agentId,
    profileVersion: profileVersion.versionNo,
    connectorId: 'synthetic.codex.fixture',
    connectorVersion: '0.0.0-synthetic.1',
    providerId: 'synthetic',
    modelId: 'synthetic-text-only-v1',
    operation: 'connector.respond',
    capabilities: [],
    limits,
    renderedRequest,
  };
  const authorizationResponse = await owner.request('/api/v1/connector-authorizations', {
    method: 'POST',
    idempotencyKey: randomUUID(),
    body: authorizationInput,
  });
  assert.equal(authorizationResponse.status, 201);
  const authorization = authorizationResponse.body;
  const decision = await owner.request(
    `/api/v1/connector-authorizations/${authorization.id}/decision`,
    {
      method: 'POST',
      body: {
        decision: 'approve',
        promptDigestConfirmation: authorization.promptDigest,
      },
    },
  );
  assert.equal(decision.status, 200);
  const revocation = await owner.request(
    `/api/v1/connector-authorizations/${authorization.id}/revoke`,
    { method: 'POST' },
  );
  assert.equal(revocation.status, 200);
  assert.equal(revocation.body.status, 'revoked');
  assert.equal(revocation.body.consumedAt, null);
  assert.equal(revocation.body.consumedRequestId, null);

  const requestId = randomUUID();
  const { renderedRequest: _renderedRequest, ...request } = authorizationInput;
  return {
    authorizationId: authorization.id,
    requestId,
    taskId: assignment.body.id,
    payload: {
      version: 'omnis.synthetic-task-run.v1',
      authorizationId: authorization.id,
      requestId,
      request: { ...request, promptDigest: authorization.promptDigest },
      renderedRequest,
      correlationId: authorization.correlationId,
    },
  };
}

async function postWorkerAdmission(services, fixture) {
  const response = await fetch(
    `${services.workerUrl}/internal/v1/tasks/${encodeURIComponent(fixture.taskId)}/synthetic-runs`,
    {
      method: 'POST',
      headers: {
        'x-omnis-internal-token': services.internalToken,
        'idempotency-key': fixture.requestId,
        'content-type': 'application/json',
      },
      body: JSON.stringify(fixture.payload),
    },
  );
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

async function readWorkerAdmissionState(auditPool, runId, authorizationId, requestId) {
  const result = await auditPool.query(
    `SELECT run.status AS run_status,
       (SELECT count(*)::int FROM omnis.runs
          WHERE status = ANY($4::text[])) AS active_run_slots,
       (SELECT count(*)::int FROM omnis.runs WHERE id=$1) AS run_count,
       (SELECT count(*)::int FROM omnis.connector_execution_attempts
          WHERE authorization_id=$2 AND request_id=$3) AS attempts,
       COALESCE((SELECT array_agg(id::text ORDER BY id::text)
          FROM omnis.connector_execution_attempts WHERE authorization_id=$2 AND request_id=$3), ARRAY[]::text[]) AS attempt_ids,
       (SELECT count(*)::int FROM omnis.connector_authorization_audit
          WHERE authorization_id=$2 AND request_id=$3
            AND event_type='connector.authorization_consumed') AS reservations,
       COALESCE((SELECT array_agg(attempt_id::text ORDER BY attempt_id::text)
          FROM omnis.connector_authorization_audit WHERE authorization_id=$2 AND request_id=$3
            AND event_type='connector.authorization_consumed' AND attempt_id IS NOT NULL), ARRAY[]::text[]) AS reservation_attempt_ids
     FROM omnis.runs AS run
     WHERE run.id=$1 AND run.connector_authorization_id=$2 AND run.connector_request_id=$3`,
    [runId, authorizationId, requestId, activeRunStatuses],
  );
  const row = result.rows[0];
  if (!row) {
    return {
      runStatus: null,
      activeRunSlots: 0,
      runCount: 0,
      attempts: 0,
      attemptIds: [],
      reservations: 0,
      reservationAttemptIds: [],
    };
  }
  return {
    runStatus: row.run_status,
    activeRunSlots: row.active_run_slots,
    runCount: row.run_count,
    attempts: row.attempts,
    attemptIds: row.attempt_ids,
    reservations: row.reservations,
    reservationAttemptIds: row.reservation_attempt_ids,
  };
}

function cookieFrom(response) {
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  if (!cookie) throw new Error('Isolated owner session cookie was not set.');
  return cookie;
}
