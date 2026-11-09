import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const ownerPassword = process.env.OMNIS_TEST_OWNER_PASSWORD;
const frontendOrigin = process.env.OMNIS_TEST_FRONTEND_ORIGIN;
const taskDetail = 'Verify that a synthetic task persists through the owner Tasks page and reload.';
const syntheticProjectId = process.env.OMNIS_TEST_SYNTHETIC_PROJECT_ID;
const lostAckRequestId = process.env.OMNIS_TEST_SYNTHETIC_LOST_ACK_REQUEST_ID;
const cancellationRequestId = process.env.OMNIS_TEST_SYNTHETIC_CANCELLATION_REQUEST_ID;
const composeJourneyResultPath = process.env.OMNIS_COMPOSE_JOURNEY_RESULT_PATH;
const composeRecovery = process.env.OMNIS_COMPOSE_RECOVERY === '1';

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

test('Compose owner creates an authorized mock Run through the web gateway', async ({ page }) => {
  test.skip(
    !composeJourneyResultPath || composeRecovery,
    'Only runs in the disposable Compose smoke.',
  );
  test.setTimeout(120_000);
  const taskTitle = `Compose browser mock journey ${randomUUID()}`;
  await signIn(page);
  const csrfDenial = await page.evaluate(async () => {
    const response = await fetch('/api/v1/tasks', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-omnis-csrf': 'invalid-compose-token' },
      body: JSON.stringify({ title: 'Denied Compose mutation', detail: 'CSRF remains enforced.' }),
    });
    return response.status;
  });
  expect(csrfDenial).toBe(403);
  await page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('link', { name: 'Tasks', exact: true })
    .click();
  await page.getByLabel('Task title', { exact: true }).fill(taskTitle);
  await page
    .getByLabel('Task detail', { exact: true })
    .fill('Disposable authorized mock execution.');
  const taskResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/v1/tasks' && response.request().method() === 'POST';
  });
  await page.getByRole('button', { name: 'Create task', exact: true }).click();
  const taskResponse = await taskResponsePromise;
  expect(taskResponse.status()).toBe(201);
  const task = await taskResponse.json();

  const agent = await ownerRequest(page, '/api/v1/agents', {
    method: 'POST',
    idempotencyKey: randomUUID(),
    body: {
      name: 'Compose browser mock agent',
      slug: `compose-${randomUUID().slice(0, 8)}`,
      departmentId: null,
    },
  });
  expect(agent.status).toBe(201);
  const profile = {
    profession: 'Synthetic integration assistant',
    seniority: null,
    specialties: ['CI validation'],
    personality: { traits: ['careful'], tone: 'plain', principles: ['report only fixture data'] },
    behavior: { autonomy: 'No external actions.', escalation: null },
    instructions: 'Return the deterministic mock result.',
  };
  const draft = await ownerRequest(page, `/api/v1/agents/${agent.body.agentId}/draft-profile`, {
    method: 'PUT',
    idempotencyKey: randomUUID(),
    body: { expectedDraftRevision: 0, baseVersionNo: null, profile },
  });
  expect(draft.status).toBe(200);
  const published = await ownerRequest(page, `/api/v1/agents/${agent.body.agentId}/publish`, {
    method: 'POST',
    idempotencyKey: randomUUID(),
    body: { expectedVersionNo: null, expectedDraftRevision: 1 },
  });
  expect(published.status).toBe(201);

  await page.reload();
  await expect(page.getByLabel('Agent profile')).toBeVisible();
  await page.getByLabel('Agent profile').selectOption(agent.body.agentId);
  await expect(page.getByLabel('Runtime')).toHaveValue('mock');
  await page.getByRole('button', { name: 'Save assignment', exact: true }).click();
  await expect(page.getByText('Synthetic mock assignment saved.')).toBeVisible();

  const authorization = await ownerRequest(page, '/api/v1/authorizations', {
    method: 'POST',
    idempotencyKey: randomUUID(),
    body: { taskId: task.id },
  });
  expect(authorization.status).toBe(201);
  expect(authorization.body.status).toBe('pending');
  const approval = await ownerRequest(
    page,
    `/api/v1/authorizations/${authorization.body.id}/decision`,
    {
      method: 'POST',
      body: { decision: 'approve' },
    },
  );
  expect(approval.status).toBe(200);

  const idempotencyKey = randomUUID();
  const runRequest = { taskId: task.id, authorizationId: authorization.body.id };
  const admitted = await ownerRequest(page, '/api/v1/runs', {
    method: 'POST',
    idempotencyKey,
    body: runRequest,
  });
  expect(admitted.status).toBe(201);
  const replay = await ownerRequest(page, '/api/v1/runs', {
    method: 'POST',
    idempotencyKey,
    body: runRequest,
  });
  expect([200, 201]).toContain(replay.status);
  expect(replay.body.id).toBe(admitted.body.id);

  await expect
    .poll(async () => (await ownerRequest(page, `/api/v1/runs/${admitted.body.id}`)).body.status, {
      timeout: 45_000,
    })
    .toBe('completed');
  const run = (await ownerRequest(page, `/api/v1/runs/${admitted.body.id}`)).body;
  expect(run.runtimeKind).toBe('mock');
  expect(run.synthetic).toBe(true);
  const events = await readRunEvents(page, admitted.body.id);
  expect(events.some((event) => event.type === 'run.completed')).toBe(true);
  expect(events.every((event) => event.synthetic === true && event.source === 'mock')).toBe(true);
  expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));

  await page.goto(`/#runs/${admitted.body.id}`);
  await page.reload();
  await expect(page.getByRole('region', { name: `Event history for ${taskTitle}` })).toContainText(
    'completed',
  );
  const taskList = await ownerRequest(page, '/api/v1/tasks');
  expect(taskList.status).toBe(200);
  const persistedTask = taskList.body.find((item) => item.id === task.id);
  expect(persistedTask).toMatchObject({
    agentId: agent.body.agentId,
    profileVersion: 1,
    runtimeId: 'mock',
  });
  await writeFile(
    composeJourneyResultPath,
    JSON.stringify({
      taskId: task.id,
      taskTitle,
      agentId: agent.body.agentId,
      profileVersion: persistedTask.profileVersion,
      runtimeId: persistedTask.runtimeId,
      runId: admitted.body.id,
      events: eventIdentities(events),
    }),
    { mode: 0o600 },
  );
});

test('Compose recovery preserves the committed Task, Run and event identities', async ({
  page,
}) => {
  test.skip(
    !composeJourneyResultPath || !composeRecovery,
    'Only runs during Compose restart checks.',
  );
  test.setTimeout(45_000);
  const expected = JSON.parse(await readFile(composeJourneyResultPath!, 'utf8'));
  await signIn(page);
  const tasks = await ownerRequest(page, '/api/v1/tasks');
  expect(tasks.status).toBe(200);
  const persistedTask = tasks.body.find((task) => task.id === expected.taskId);
  expect(persistedTask).toMatchObject({
    agentId: expected.agentId,
    profileVersion: expected.profileVersion,
    runtimeId: expected.runtimeId,
  });
  const run = await ownerRequest(page, `/api/v1/runs/${expected.runId}`);
  expect(run.status).toBe(200);
  expect(run.body.status).toBe('completed');
  expect(run.body.runtimeKind).toBe('mock');
  expect(run.body.synthetic).toBe(true);
  const events = await readRunEvents(page, expected.runId);
  expect(eventIdentities(events)).toEqual(expected.events);
  await page.goto(`/#runs/${expected.runId}`);
  await page.reload();
  await expect(
    page.getByRole('region', { name: `Event history for ${expected.taskTitle}` }),
  ).toContainText('completed');
});

test('owner sees an authorized synthetic broker Run, ordered events, result and usage provenance', async ({
  page,
}) => {
  test.setTimeout(180_000);
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
      { timeout: 100_000 },
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
  await expect(inspector).toContainText('outcome unknown');
  await expect(inspector).toContainText('completed');
  await expect(inspector).toContainText('Synthetic provider response.');
  await expect(page.getByText('completed', { exact: true })).toBeVisible();

  const cancellationTask = await ownerRequest(page, '/api/v1/tasks', {
    method: 'POST',
    idempotencyKey: randomUUID(),
    body: {
      title: `Synthetic broker cancellation ${randomUUID()}`,
      detail: 'Confirm owner cancellation after fake-provider acceptance.',
      projectId: project.id,
    },
  });
  expect(cancellationTask.status).toBe(201);
  const cancellationAssignment = await ownerRequest(
    page,
    `/api/v1/tasks/${cancellationTask.body.id}/execution-assignment`,
    {
      method: 'PUT',
      idempotencyKey: randomUUID(),
      body: {
        agentId,
        profileVersion: profileVersion.versionNo,
        runtimeId: 'mock',
        expectedAssignmentRevision: cancellationTask.body.assignmentRevision,
      },
    },
  );
  expect(cancellationAssignment.status).toBe(200);
  const cancellationRenderedRequest = JSON.stringify({
    version: 'omnis.synthetic-connector-request.v1',
    task: {
      id: cancellationAssignment.body.id,
      title: cancellationAssignment.body.title,
      detail: cancellationAssignment.body.detail,
    },
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
  const cancellationAuthorizationInput = {
    ...authorizationInput,
    taskId: cancellationAssignment.body.id,
    taskRevision: cancellationAssignment.body.associationRevision,
    renderedRequest: cancellationRenderedRequest,
  };
  const cancellationAuthorizationResponse = await ownerRequest(
    page,
    '/api/v1/connector-authorizations',
    {
      method: 'POST',
      idempotencyKey: randomUUID(),
      body: cancellationAuthorizationInput,
    },
  );
  expect(cancellationAuthorizationResponse.status).toBe(201);
  const cancellationAuthorization = cancellationAuthorizationResponse.body;
  const cancellationApproval = await ownerRequest(
    page,
    `/api/v1/connector-authorizations/${cancellationAuthorization.id}/decision`,
    {
      method: 'POST',
      body: {
        decision: 'approve',
        promptDigestConfirmation: cancellationAuthorization.promptDigest,
      },
    },
  );
  expect(cancellationApproval.status).toBe(200);
  expect(cancellationRequestId).toMatch(/^[0-9a-f-]{36}$/i);
  const cancellationRun = await ownerRequest(
    page,
    `/api/v1/tasks/${cancellationAssignment.body.id}/synthetic-runs`,
    {
      method: 'POST',
      idempotencyKey: cancellationRequestId,
      body: {
        authorizationId: cancellationAuthorization.id,
        request: {
          projectId: cancellationAuthorizationInput.projectId,
          projectRevision: cancellationAuthorizationInput.projectRevision,
          taskId: cancellationAuthorizationInput.taskId,
          taskRevision: cancellationAuthorizationInput.taskRevision,
          agentId: cancellationAuthorizationInput.agentId,
          profileVersion: cancellationAuthorizationInput.profileVersion,
          connectorId: cancellationAuthorizationInput.connectorId,
          connectorVersion: cancellationAuthorizationInput.connectorVersion,
          providerId: cancellationAuthorizationInput.providerId,
          modelId: cancellationAuthorizationInput.modelId,
          operation: cancellationAuthorizationInput.operation,
          capabilities: [],
          limits,
          promptDigest: cancellationAuthorization.promptDigest,
        },
        renderedRequest: cancellationRenderedRequest,
      },
    },
  );
  expect(cancellationRun.status).toBe(202);
  const cancellationRunId = cancellationRun.body.id;
  await expect
    .poll(
      async () => {
        const detail = await ownerRequest(
          page,
          `/api/v1/tasks/${cancellationAssignment.body.id}/synthetic-runs/${cancellationAuthorization.id}`,
        );
        return detail.body?.attempt?.status;
      },
      { timeout: 15_000 },
    )
    .toBe('accepted');

  await page.goto(`/#runs/${cancellationRunId}`);
  await page.reload();
  const stopButton = page.getByRole('button', { name: 'Request stop', exact: true });
  await expect(stopButton).toBeVisible();
  const stopResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === `/api/v1/runs/${cancellationRunId}/stop` &&
      response.request().method() === 'POST'
    );
  });
  await stopButton.click();
  const stopResponse = await stopResponsePromise;
  expect(stopResponse.status()).toBe(200);
  await expect(page.getByRole('button', { name: 'Stop requested', exact: true })).toBeVisible();

  await expect
    .poll(
      async () => {
        const state = await ownerRequest(page, `/api/v1/runs/${cancellationRunId}`);
        const detail = await ownerRequest(
          page,
          `/api/v1/tasks/${cancellationAssignment.body.id}/synthetic-runs/${cancellationAuthorization.id}`,
        );
        return { runStatus: state.body.status, attemptStatus: detail.body?.attempt?.status };
      },
      { timeout: 50_000 },
    )
    .toEqual({ runStatus: 'cancelled', attemptStatus: 'interrupted' });

  await page.reload();
  const cancelledInspector = page.getByRole('region', {
    name: `Event history for ${cancellationAssignment.body.title}`,
  });
  await expect(cancelledInspector).toContainText('stop requested');
  await expect(cancelledInspector).toContainText('cancelled');

  expect(lostAckRequestId).toMatch(/^[0-9a-f-]{36}$/i);
  const lostAckTaskTitle = `Synthetic broker lost acknowledgement ${randomUUID()}`;
  const lostAckTaskCreated = await ownerRequest(page, '/api/v1/tasks', {
    method: 'POST',
    idempotencyKey: randomUUID(),
    body: {
      title: lostAckTaskTitle,
      detail: 'Verify a provider acceptance with a lost broker acknowledgement.',
      projectId: project.id,
    },
  });
  expect(lostAckTaskCreated.status).toBe(201);
  const lostAckTaskProject = await ownerRequest(
    page,
    `/api/v1/tasks/${lostAckTaskCreated.body.id}/project`,
    {
      method: 'PUT',
      idempotencyKey: randomUUID(),
      body: {
        projectId: project.id,
        expectedAssociationRevision: lostAckTaskCreated.body.associationRevision,
      },
    },
  );
  expect(lostAckTaskProject.status).toBe(200);
  const lostAckTaskAssignment = await ownerRequest(
    page,
    `/api/v1/tasks/${lostAckTaskCreated.body.id}/execution-assignment`,
    {
      method: 'PUT',
      idempotencyKey: randomUUID(),
      body: {
        agentId,
        profileVersion: profileVersion.versionNo,
        runtimeId: 'mock',
        expectedAssignmentRevision: lostAckTaskCreated.body.assignmentRevision,
      },
    },
  );
  expect(lostAckTaskAssignment.status).toBe(200);
  const lostAckRenderedRequest = JSON.stringify({
    version: 'omnis.synthetic-connector-request.v1',
    task: {
      id: lostAckTaskAssignment.body.id,
      title: lostAckTaskAssignment.body.title,
      detail: lostAckTaskAssignment.body.detail,
    },
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
  const lostAckAuthorizationInput = {
    ...authorizationInput,
    taskId: lostAckTaskAssignment.body.id,
    taskRevision: lostAckTaskAssignment.body.associationRevision,
    renderedRequest: lostAckRenderedRequest,
  };
  const lostAckAuthorizationResponse = await ownerRequest(
    page,
    '/api/v1/connector-authorizations',
    {
      method: 'POST',
      idempotencyKey: randomUUID(),
      body: lostAckAuthorizationInput,
    },
  );
  expect(
    lostAckAuthorizationResponse.status,
    JSON.stringify(lostAckAuthorizationResponse.body),
  ).toBe(201);
  const lostAckAuthorization = lostAckAuthorizationResponse.body;
  const lostAckApproval = await ownerRequest(
    page,
    `/api/v1/connector-authorizations/${lostAckAuthorization.id}/decision`,
    {
      method: 'POST',
      body: {
        decision: 'approve',
        promptDigestConfirmation: lostAckAuthorization.promptDigest,
      },
    },
  );
  expect(lostAckApproval.status).toBe(200);
  const lostAckRunRequestBody = {
    authorizationId: lostAckAuthorization.id,
    request: {
      projectId: lostAckAuthorizationInput.projectId,
      projectRevision: lostAckAuthorizationInput.projectRevision,
      taskId: lostAckAuthorizationInput.taskId,
      taskRevision: lostAckAuthorizationInput.taskRevision,
      agentId: lostAckAuthorizationInput.agentId,
      profileVersion: lostAckAuthorizationInput.profileVersion,
      connectorId: lostAckAuthorizationInput.connectorId,
      connectorVersion: lostAckAuthorizationInput.connectorVersion,
      providerId: lostAckAuthorizationInput.providerId,
      modelId: lostAckAuthorizationInput.modelId,
      operation: lostAckAuthorizationInput.operation,
      capabilities: [],
      limits,
      promptDigest: lostAckAuthorization.promptDigest,
    },
    renderedRequest: lostAckRenderedRequest,
  };
  const lostAckRun = await ownerRequest(
    page,
    `/api/v1/tasks/${lostAckTaskAssignment.body.id}/synthetic-runs`,
    {
      method: 'POST',
      idempotencyKey: lostAckRequestId,
      body: lostAckRunRequestBody,
    },
  );
  expect(lostAckRun.status).toBe(202);
  const lostAckRunId = lostAckRun.body.id;
  const lostAckRunReplay = await ownerRequest(
    page,
    `/api/v1/tasks/${lostAckTaskAssignment.body.id}/synthetic-runs`,
    {
      method: 'POST',
      idempotencyKey: lostAckRequestId,
      body: lostAckRunRequestBody,
    },
  );
  expect(lostAckRunReplay.status).toBe(200);
  expect(lostAckRunReplay.body.id).toBe(lostAckRunId);
  await expect
    .poll(
      async () => {
        const state = await ownerRequest(page, `/api/v1/runs/${lostAckRunId}`);
        const detail = await ownerRequest(
          page,
          `/api/v1/tasks/${lostAckTaskAssignment.body.id}/synthetic-runs/${lostAckAuthorization.id}`,
        );
        return { runStatus: state.body?.status, attemptStatus: detail.body?.attempt?.status };
      },
      { timeout: 70_000 },
    )
    .toEqual({ runStatus: 'unknown', attemptStatus: 'unknown' });
  const lostAckRunAfterRecoveryReplay = await ownerRequest(
    page,
    `/api/v1/tasks/${lostAckTaskAssignment.body.id}/synthetic-runs`,
    {
      method: 'POST',
      idempotencyKey: lostAckRequestId,
      body: lostAckRunRequestBody,
    },
  );
  expect(lostAckRunAfterRecoveryReplay.status).toBe(200);
  expect(lostAckRunAfterRecoveryReplay.body.id).toBe(lostAckRunId);
  const lostAckDetail = await ownerRequest(
    page,
    `/api/v1/tasks/${lostAckTaskAssignment.body.id}/synthetic-runs/${lostAckAuthorization.id}`,
  );
  expect(lostAckDetail.body.attempt.providerSubmissionId).toBeNull();
  expect(lostAckDetail.body.usage.kind).toBe('unknown');
  await page.goto(`/#runs/${lostAckRunId}`);
  await page.reload();
  await expect(
    page.getByRole('region', { name: `Event history for ${lostAckTaskTitle}` }),
  ).toContainText('unknown');
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

async function readRunEvents(page, runId) {
  return page.evaluate(async (id) => {
    const controller = new AbortController();
    const response = await fetch(`/api/v1/runs/${id}/events`, {
      credentials: 'same-origin',
      signal: controller.signal,
    });
    if (response.status !== 200 || !response.body) {
      throw new Error(`Run event stream returned HTTP ${response.status}.`);
    }
    const reader = response.body.getReader();
    const events = [];
    let buffer = '';
    const deadline = Date.now() + 10_000;
    try {
      while (Date.now() < deadline && !events.some((event) => event.type === 'run.completed')) {
        const item = await Promise.race([
          reader.read(),
          new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 1_000)),
        ]);
        if ('timeout' in item || item.done) break;
        buffer += new TextDecoder().decode(item.value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
        }
      }
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }
    return events;
  }, runId);
}

function eventIdentities(events) {
  return events.map(({ sequence, type, synthetic, source }) => ({
    sequence,
    type,
    synthetic,
    source,
  }));
}
