import { createHash, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

const ownerPassword = process.env.OMNIS_TEST_OWNER_PASSWORD;
const frontendOrigin = process.env.OMNIS_TEST_FRONTEND_ORIGIN;
const taskDetail = 'Verify that a synthetic task persists through the owner Tasks page and reload.';
const syntheticProjectId = process.env.OMNIS_TEST_SYNTHETIC_PROJECT_ID;

if (!frontendOrigin) throw new Error('The integration frontend Origin is not configured.');
if (!ownerPassword) throw new Error('The disposable owner password is not configured.');

test('owner creates an unassigned task that persists after reload', async ({ page }) => {
  const taskTitle = `Full-stack browser smoke ${randomUUID()}`;
  let taskCreateRequests = 0;
  let taskListRequests = 0;
  let csrfBootstrapRequests = 0;
  let ownerLoginResponses = 0;
  const ownerLoginStatuses: number[] = [];
  let ownerSessionRequests = 0;
  const apiRequestOrigins: string[] = [];
  const forbiddenMutationPaths: string[] = [];

  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/auth/csrf' && request.method() === 'GET') {
      csrfBootstrapRequests += 1;
      apiRequestOrigins.push(url.origin);
    }
    if (url.pathname === '/api/v1/me' && request.method() === 'GET') {
      ownerSessionRequests += 1;
      apiRequestOrigins.push(url.origin);
    }
    if (url.pathname === '/api/v1/tasks' && request.method() === 'POST') {
      taskCreateRequests += 1;
      apiRequestOrigins.push(url.origin);
    }
    if (url.pathname === '/api/v1/tasks' && request.method() === 'GET') {
      taskListRequests += 1;
      apiRequestOrigins.push(url.origin);
    }
    if (
      request.method() === 'POST' &&
      /^\/api\/v1\/(?:runs|authorizations)(?:\/|$)/.test(url.pathname)
    ) {
      forbiddenMutationPaths.push(url.pathname);
    }
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname === '/api/v1/auth/login' && response.request().method() === 'POST') {
      ownerLoginResponses += 1;
      ownerLoginStatuses.push(response.status());
    }
  });

  await page.goto('/');

  const signInButton = page.getByRole('button', { name: 'Sign in', exact: true });
  await page.getByLabel('Owner password').fill(ownerPassword);
  await expect(signInButton).toBeEnabled();
  await signInButton.click();

  const navigation = page.getByRole('navigation', { name: 'Primary navigation' });
  await navigation.getByRole('link', { name: 'Tasks', exact: true }).click();
  await expect(page).toHaveURL(/#tasks$/);
  await expect(page.getByRole('heading', { name: 'Create a task', exact: true })).toBeVisible();
  expect(csrfBootstrapRequests).toBeGreaterThan(0);
  expect(ownerLoginResponses).toBe(1);
  expect(ownerLoginStatuses).toEqual([200]);
  expect(ownerSessionRequests).toBeGreaterThan(0);
  expect(apiRequestOrigins.length).toBeGreaterThan(0);
  expect(new Set(apiRequestOrigins)).toEqual(new Set([frontendOrigin]));

  await page.getByLabel('Task title', { exact: true }).fill(taskTitle);
  await page.getByLabel('Task detail', { exact: true }).fill(taskDetail);

  const createResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/v1/tasks' && response.request().method() === 'POST';
  });
  await page.getByRole('button', { name: 'Create task', exact: true }).click();
  const createResponse = await createResponsePromise;
  expect(createResponse.status()).toBe(201);
  expect(new URL(createResponse.url()).origin).toBe(frontendOrigin);

  const taskSelectButton = page.getByRole('button').filter({
    has: page.getByText(taskTitle, { exact: true }),
  });
  await expect(taskSelectButton).toHaveCount(1);
  await expect(taskSelectButton).toContainText(taskDetail);

  const taskListRequestsBeforeReload = taskListRequests;
  await page.reload();

  const persistedTaskButton = page.getByRole('button').filter({
    has: page.getByText(taskTitle, { exact: true }),
  });
  await expect(persistedTaskButton).toHaveCount(1);
  await expect(persistedTaskButton).toContainText(taskDetail);
  expect(taskListRequests).toBeGreaterThan(taskListRequestsBeforeReload);
  expect(taskCreateRequests).toBe(1);
  expect(forbiddenMutationPaths).toEqual([]);
});

test('owner sees an authorized synthetic broker Run, ordered events, result and usage provenance', async ({
  page,
}) => {
  test.skip(
    !syntheticProjectId,
    'The disposable backend harness did not enable synthetic broker integration.',
  );
  const runTaskTitle = `Synthetic broker browser run ${randomUUID()}`;
  const runTaskDetail = 'Return the fixed synthetic provider fixture result.';

  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('link', { name: 'Tasks', exact: true })
    .click();
  await page.getByLabel('Task title', { exact: true }).fill(runTaskTitle);
  await page.getByLabel('Task detail', { exact: true }).fill(runTaskDetail);
  const taskResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/v1/tasks' && response.request().method() === 'POST';
  });
  await page.getByRole('button', { name: 'Create task', exact: true }).click();
  const taskResponse = await taskResponsePromise;
  expect(taskResponse.status()).toBe(201);
  const createdTask = await taskResponse.json();

  const projectResponse = await ownerRequest(page, `/api/v1/projects/${syntheticProjectId}`);
  expect(projectResponse.status).toBe(200);
  const project = projectResponse.body;
  expect(project.status).toBe('active');
  const assigned = await ownerRequest(page, `/api/v1/tasks/${createdTask.id}/project`, {
    method: 'PUT',
    idempotencyKey: randomUUID(),
    body: { projectId: project.id, expectedAssociationRevision: createdTask.associationRevision },
  });
  expect(assigned.status).toBe(200);

  const agentCreated = await ownerRequest(page, '/api/v1/agents', {
    method: 'POST',
    idempotencyKey: randomUUID(),
    body: {
      name: 'Synthetic broker integration agent',
      slug: `synthetic-broker-${randomUUID().slice(0, 8)}`,
      departmentId: null,
    },
  });
  expect(agentCreated.status).toBe(201);
  const agentId = agentCreated.body.agentId;
  const profile = {
    profession: 'Synthetic test assistant',
    seniority: null,
    specialties: ['integration testing'],
    personality: { traits: ['careful'], tone: 'plain', principles: ['report only fixture data'] },
    behavior: { autonomy: 'No external actions.', escalation: null },
    instructions: 'Return the exact synthetic fixture result.',
  };
  const savedProfile = await ownerRequest(page, `/api/v1/agents/${agentId}/draft-profile`, {
    method: 'PUT',
    idempotencyKey: randomUUID(),
    body: { expectedDraftRevision: 0, baseVersionNo: null, profile },
  });
  expect(savedProfile.status).toBe(200);
  const published = await ownerRequest(page, `/api/v1/agents/${agentId}/publish`, {
    method: 'POST',
    idempotencyKey: randomUUID(),
    body: { expectedVersionNo: null, expectedDraftRevision: 1 },
  });
  expect(published.status).toBe(201);
  const profileResponse = await ownerRequest(page, `/api/v1/agents/${agentId}/versions/1`);
  expect(profileResponse.status).toBe(200);
  const profileVersion = profileResponse.body.version;

  // Exercise the owner assignment interface against the real API and PostgreSQL store before
  // asking the independently authorized synthetic connector to consume the profile.
  await page.reload();
  await expect(page.getByLabel('Agent profile')).toBeVisible();
  await page.getByLabel('Agent profile').selectOption(agentId);
  await expect(page.getByLabel('Runtime')).toHaveValue('mock');
  await page.getByRole('button', { name: 'Save assignment', exact: true }).click();
  await expect(page.getByText('Synthetic mock assignment saved.')).toBeVisible();

  const renderedRequest = JSON.stringify({
    version: 'omnis.synthetic-connector-request.v1',
    task: { id: assigned.body.id, title: assigned.body.title, detail: assigned.body.detail },
    agentProfile: {
      agentId: profileVersion.agentId,
      versionNo: profileVersion.versionNo,
      profession: profileVersion.profession,
      seniority: profileVersion.seniority,
      specialties: profileVersion.specialties,
      personality: profileVersion.personality,
      behavior: profileVersion.behavior,
      instructions: profileVersion.instructions,
    },
  });
  const promptDigest = `sha256:${createHash('sha256')
    .update('omnis-os/rendered-connector-request/v1\0', 'utf8')
    .update(renderedRequest, 'utf8')
    .digest('hex')}`;
  const limits = {
    maxInputTokens: 100,
    maxOutputTokens: 100,
    maxDurationSeconds: 30,
    maxConcurrentRuns: 1,
    maxUsageUnits: 100,
    maxCostMicrousd: 100,
  };
  const authorizationInput = {
    projectId: project.id,
    projectRevision: project.revision,
    taskId: assigned.body.id,
    taskRevision: assigned.body.associationRevision,
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
  const authorizationResponse = await ownerRequest(page, '/api/v1/connector-authorizations', {
    method: 'POST',
    idempotencyKey: randomUUID(),
    body: authorizationInput,
  });
  expect(authorizationResponse.status).toBe(201);
  const authorization = authorizationResponse.body;
  expect(authorization.promptDigest).toBe(promptDigest);
  expect(authorization.status).toBe('pending');
  const approved = await ownerRequest(
    page,
    `/api/v1/connector-authorizations/${authorization.id}/decision`,
    {
      method: 'POST',
      body: { decision: 'approve', promptDigestConfirmation: authorization.promptDigest },
    },
  );
  expect(approved.status).toBe(200);
  expect(approved.body.status).toBe('authorized');

  const syntheticRun = await ownerRequest(
    page,
    `/api/v1/tasks/${assigned.body.id}/synthetic-runs`,
    {
      method: 'POST',
      idempotencyKey: randomUUID(),
      body: {
        authorizationId: authorization.id,
        request: {
          projectId: authorizationInput.projectId,
          projectRevision: authorizationInput.projectRevision,
          taskId: authorizationInput.taskId,
          taskRevision: authorizationInput.taskRevision,
          agentId: authorizationInput.agentId,
          profileVersion: authorizationInput.profileVersion,
          connectorId: authorizationInput.connectorId,
          connectorVersion: authorizationInput.connectorVersion,
          providerId: authorizationInput.providerId,
          modelId: authorizationInput.modelId,
          operation: authorizationInput.operation,
          capabilities: [],
          limits,
          promptDigest: authorization.promptDigest,
        },
        renderedRequest,
      },
    },
  );
  expect(syntheticRun.status).toBe(202);
  const runId = syntheticRun.body.id;
  let persistedRun;
  let persistedAttemptStatus;
  await expect
    .poll(
      async () => {
        const state = await ownerRequest(page, `/api/v1/runs/${runId}`);
        persistedRun = state.body;
        const detail = await ownerRequest(
          page,
          `/api/v1/tasks/${assigned.body.id}/synthetic-runs/${authorization.id}`,
        );
        persistedAttemptStatus = detail.body?.attempt?.status;
        return { runStatus: state.body.status, attemptStatus: persistedAttemptStatus };
      },
      { timeout: 15_000 },
    )
    .toEqual({ runStatus: 'completed', attemptStatus: 'completed' });
  expect(persistedRun.runtimeKind).toBe('mock');
  expect(persistedRun.synthetic).toBe(true);
  expect(persistedRun.authorizationId).toBe(authorization.id);

  const detail = await ownerRequest(
    page,
    `/api/v1/tasks/${assigned.body.id}/synthetic-runs/${authorization.id}`,
  );
  expect(detail.status).toBe(200);
  expect(detail.body.attempt.status).toBe('completed');
  expect(detail.body.usage).toEqual({
    kind: 'measured',
    source: 'synthetic-provider',
    inputUnits: 1,
    outputUnits: 1,
    billingExposure: 'synthetic-only',
  });

  await page.goto(`/#runs/${runId}`);
  // The task and run were created through direct owner requests above, so the
  // browser's workspace cache predates this Run. Reload to verify that the
  // persisted run list and SSE replay restore its durable event history.
  await page.reload();
  const inspector = page.getByRole('region', { name: `Event history for ${runTaskTitle}` });
  await expect(inspector).toContainText('queued');
  await expect(inspector).toContainText('started');
  await expect(inspector).toContainText('provider submission requested');
  await expect(inspector).toContainText('completed');
  await expect(inspector).toContainText('Synthetic provider response.');
  await expect(page.getByText('completed', { exact: true })).toBeVisible();
});

async function signIn(page) {
  await page.goto('/');
  const signInButton = page.getByRole('button', { name: 'Sign in', exact: true });
  await page.getByLabel('Owner password').fill(ownerPassword);
  await expect(signInButton).toBeEnabled();
  await signInButton.click();
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
}

async function ownerRequest(page, path, options = {}) {
  const csrfToken = await page.evaluate(async () => {
    const response = await fetch('/api/v1/auth/csrf', { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Owner CSRF token could not be refreshed.');
    return (await response.json()).csrfToken;
  });
  return page.evaluate(
    async ({ path, method, body, idempotencyKey, csrfToken }) => {
      const headers = { 'x-omnis-csrf': csrfToken };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (method !== 'GET' && idempotencyKey) headers['idempotency-key'] = idempotencyKey;
      const response = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
    {
      path,
      method: options.method ?? 'GET',
      ...(options.body === undefined ? {} : { body: options.body }),
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      csrfToken,
    },
  );
}
