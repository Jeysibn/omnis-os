import { RunSchema } from '@omnis/contracts';
import { ConnectorAuthorizationSchema } from '@omnis/contracts/connector-authorization';
import {
  SyntheticRunBindingSchema,
  SyntheticTaskRunDetailSchema,
} from '@omnis/contracts/synthetic-task-run';

type Forwarder = <TResult>(
  path: string,
  init: RequestInit,
  parse: (value: unknown) => TResult,
) => Promise<TResult>;

export async function stopSyntheticRunBeforeStandardStop(
  runId: string,
  forwarders: { forwardWorker: Forwarder; forwardAuthorizer: Forwarder },
) {
  let binding: ReturnType<typeof SyntheticRunBindingSchema.parse>;
  try {
    binding = await forwarders.forwardWorker(
      `/internal/v1/runs/${encodeURIComponent(runId)}/synthetic-binding`,
      {},
      (value) => SyntheticRunBindingSchema.parse(value),
    );
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  if (binding.runId !== runId) {
    throw new Error('Synthetic cancellation context does not match the requested Run.');
  }

  const authorization = await forwarders.forwardAuthorizer(
    `/internal/v1/connector-authorizations/${encodeURIComponent(binding.authorizationId)}`,
    {},
    (value) => ConnectorAuthorizationSchema.parse(value),
  );
  if (
    authorization.id !== binding.authorizationId ||
    authorization.taskId !== binding.taskId ||
    authorization.correlationId !== runId
  ) {
    throw new Error('The owner grant does not match the persisted Run binding.');
  }

  if (authorization.status === 'authorized') {
    await forwarders.forwardAuthorizer(
      `/internal/v1/connector-authorizations/${encodeURIComponent(binding.authorizationId)}/revoke`,
      { method: 'POST' },
      (value) => ConnectorAuthorizationSchema.parse(value),
    );
  } else if (authorization.status === 'expired' && authorization.consumedAt !== null) {
    const execution = await forwarders.forwardAuthorizer(
      `/internal/v1/connector-authorizations/${encodeURIComponent(binding.authorizationId)}/execution`,
      {},
      (value) => SyntheticTaskRunDetailSchema.parse(value),
    );
    if (hasActiveAttempt(execution)) {
      await forwarders.forwardAuthorizer(
        `/internal/v1/connector-authorizations/${encodeURIComponent(binding.authorizationId)}/revoke`,
        { method: 'POST' },
        (value) => ConnectorAuthorizationSchema.parse(value),
      );
    }
  } else if (authorization.status !== 'revoked' && authorization.status !== 'expired') {
    throw new Error('The connector grant is not cancellable.');
  }

  await forwarders.forwardWorker(
    `/internal/v1/synthetic-runs/${encodeURIComponent(runId)}/cancel`,
    {
      method: 'POST',
      body: JSON.stringify({ taskId: binding.taskId, authorizationId: binding.authorizationId }),
    },
    () => undefined,
  );
  const run = await forwarders.forwardWorker(
    `/internal/v1/runs/${encodeURIComponent(runId)}`,
    {},
    (value) => RunSchema.parse(value),
  );
  if (run.id !== runId || run.taskId !== binding.taskId) {
    throw new Error(
      'The returned Run does not match the persisted synthetic cancellation binding.',
    );
  }
  return run;
}

function hasActiveAttempt(value: ReturnType<typeof SyntheticTaskRunDetailSchema.parse>): boolean {
  return (
    value.attempt !== undefined &&
    ['admitted', 'submitting', 'accepted', 'running', 'unknown'].includes(value.attempt.status)
  );
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('statusCode' in error) || error.statusCode !== 404) {
    return false;
  }
  if (!('body' in error) || !error.body || typeof error.body !== 'object') return false;
  const body = error.body;
  return (
    'error' in body &&
    body.error !== null &&
    typeof body.error === 'object' &&
    'code' in body.error &&
    body.error.code === 'not_found'
  );
}
