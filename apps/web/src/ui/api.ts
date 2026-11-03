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

export async function request<T>(
  path: string,
  init: RequestInit = {},
  parse: (value: unknown) => T,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    });
  } catch {
    throw new ApiRequestError({
      message: "Can't reach Omnis OS. Check your connection and retry.",
      status: null,
      code: 'network_error',
      outcome: 'uncertain',
    });
  }
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
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
  try {
    return parse(await response.json());
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
