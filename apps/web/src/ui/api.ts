import { ApiErrorSchema } from '@omnis/contracts';

export class ApiRequestError extends Error {
  readonly status: number | null;
  readonly code: string;
  readonly requestId: string | null;
  readonly outcome: 'rejected' | 'uncertain' | 'invalid-response';

  constructor(input: {
    message: string;
    status: number | null;
    code: string;
    requestId?: string | null;
    outcome: 'rejected' | 'uncertain' | 'invalid-response';
  }) {
    super(input.message);
    this.name = 'ApiRequestError';
    this.status = input.status;
    this.code = input.code;
    this.requestId = input.requestId ?? null;
    this.outcome = input.outcome;
  }
}

/** Bounded deadlines. A read is safe to repeat; a mutation may have been applied, so it is longer. */
export const READ_TIMEOUT_MS = 15_000;
export const MUTATION_TIMEOUT_MS = 30_000;

const isRead = (init: RequestInit) =>
  ['GET', 'HEAD'].includes((init.method ?? 'GET').toUpperCase());

/**
 * One deadline covers the whole exchange: connecting, headers and reading the body. When it fires
 * the request is abandoned, but a mutation is reported as `uncertain` (never `rejected`) because the
 * server may still have applied it. Nothing here retries; recovery is the caller's explicit action.
 */
export async function request<T>(
  path: string,
  init: RequestInit = {},
  parse: (value: unknown) => T,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const read = isRead(init);
  const timeoutMs = options.timeoutMs ?? (read ? READ_TIMEOUT_MS : MUTATION_TIMEOUT_MS);
  const deadline = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    deadline.abort();
  }, timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;
  const timeoutError = () =>
    new ApiRequestError({
      message: read
        ? 'Omnis OS did not respond in time. Check your connection and retry.'
        : 'Omnis OS did not confirm this action in time. It may or may not have been applied. Check the current state before repeating it.',
      status: null,
      code: read ? 'request_timeout' : 'mutation_timeout',
      outcome: 'uncertain',
    });
  try {
    return await exchange(
      path,
      init,
      signal,
      parse,
      () => timedOut && !init.signal?.aborted,
      timeoutError,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function exchange<T>(
  path: string,
  init: RequestInit,
  signal: AbortSignal,
  parse: (value: unknown) => T,
  deadlineFired: () => boolean,
  timeoutError: () => ApiRequestError,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      signal,
      headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    });
  } catch {
    if (deadlineFired()) throw timeoutError();
    throw new ApiRequestError({
      message: "Can't reach Omnis OS. Check your connection and retry.",
      status: null,
      code: 'network_error',
      outcome: 'uncertain',
    });
  }
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    if (deadlineFired() && payload === null) throw timeoutError();
    const error = ApiErrorSchema.safeParse(payload);
    throw new ApiRequestError({
      message: error.success
        ? error.data.error.message
        : `Omnis OS could not complete this request (${response.status}).`,
      status: response.status,
      code: error.success ? error.data.error.code : 'http_error',
      ...(error.success && error.data.error.requestId
        ? { requestId: error.data.error.requestId }
        : {}),
      outcome: response.status >= 500 ? 'uncertain' : 'rejected',
    });
  }
  if (response.status === 204) return undefined as T;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (deadlineFired()) throw timeoutError();
    throw new ApiRequestError({
      message:
        'Omnis OS returned a response this interface could not verify. Do not repeat the action automatically.',
      status: response.status,
      code: 'invalid_response',
      outcome: 'invalid-response',
    });
  }
  try {
    return parse(body);
  } catch {
    throw new ApiRequestError({
      message:
        'Omnis OS returned a response this interface could not verify. Do not repeat the action automatically.',
      status: response.status,
      code: 'invalid_response',
      outcome: 'invalid-response',
    });
  }
}
