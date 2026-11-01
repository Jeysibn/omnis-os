import { ApiErrorSchema, RunSchema, TaskSchema, type ApiError } from '@omnis/contracts';
import { env } from './env.ts';

export class WorkerRequestError extends Error {
  readonly statusCode: number;
  readonly body: ApiError;

  constructor(statusCode: number, body: ApiError) {
    super(body.error.message);
    this.statusCode = statusCode;
    this.body = body;
  }
}

export async function workerRequest<T>(
  path: string,
  init: RequestInit = {},
  parse: (value: unknown) => T,
): Promise<T> {
  const suppliedHeaders = new Headers(init.headers);
  suppliedHeaders.set('x-omnis-internal-token', env.internalToken);
  if (init.body) suppliedHeaders.set('content-type', 'application/json');
  const response = await fetch(`${env.workerUrl}${path}`, {
    ...init,
    headers: suppliedHeaders,
  });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsedError = ApiErrorSchema.safeParse(value);
    throw new WorkerRequestError(
      response.status,
      parsedError.success
        ? parsedError.data
        : {
            error: {
              code: 'worker_error',
              message: 'The local worker returned an invalid response.',
            },
          },
    );
  }
  return parse(value);
}

export const parseTaskList = (value: unknown) => {
  if (!Array.isArray(value)) throw new Error('Worker task response is invalid.');
  return value.map((item) => TaskSchema.parse(item));
};
export const parseRunList = (value: unknown) => {
  if (!Array.isArray(value)) throw new Error('Worker run response is invalid.');
  return value.map((item) => RunSchema.parse(item));
};
export const parseTask = (value: unknown) => TaskSchema.parse(value);
export const parseRun = (value: unknown) => RunSchema.parse(value);

export async function workerEventStream(runId: string, afterSequence: number, signal: AbortSignal) {
  const response = await fetch(
    `${env.workerUrl}/internal/v1/runs/${encodeURIComponent(runId)}/events?after=${afterSequence}`,
    { headers: { 'x-omnis-internal-token': env.internalToken }, signal },
  );
  if (!response.ok || !response.body) {
    const value: unknown = await response.json().catch(() => null);
    const parsedError = ApiErrorSchema.safeParse(value);
    throw new WorkerRequestError(
      response.status,
      parsedError.success
        ? parsedError.data
        : {
            error: {
              code: 'worker_stream_error',
              message: 'The local worker event stream is unavailable.',
            },
          },
    );
  }
  return response.body;
}
