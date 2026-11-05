import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

const ownerPassword = 'test-owner-password-2026';
const frontendOrigin = process.env.OMNIS_TEST_FRONTEND_ORIGIN;
const taskDetail = 'Verify that a synthetic task persists through the owner Tasks page and reload.';

if (!frontendOrigin) throw new Error('The integration frontend Origin is not configured.');

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
