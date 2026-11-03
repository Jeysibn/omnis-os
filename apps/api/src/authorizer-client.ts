import { ApiErrorSchema } from '@omnis/contracts';
import type { ApiError } from '@omnis/contracts';
import { env } from './env.ts';

export class AuthorizerRequestError extends Error {
  readonly statusCode: number;
  readonly body: ApiError;

  constructor(statusCode: number, body: ApiError) {
    super(body.error.message);
    this.statusCode = statusCode;
    this.body = body;
  }
}

export async function authorizerRequest<T>(
  path: string,
  init: RequestInit = {},
  parse: (value: unknown) => T,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('x-omnis-authorizer-token', env.authorizerToken);
  if (init.body) headers.set('content-type', 'application/json');

  let response: Response;
  try {
    response = await fetch(`${env.authorizerUrl}${path}`, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(5_000),
    });
  } catch {
    throw new AuthorizerRequestError(503, {
      error: {
        code: 'authorizer_unavailable',
        message:
          'The authorization decision was not committed. Retry after checking service health.',
      },
    });
  }

  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsedError = ApiErrorSchema.safeParse(value);
    throw new AuthorizerRequestError(
      response.status,
      parsedError.success
        ? parsedError.data
        : {
            error: {
              code: 'authorizer_error',
              message: 'The authorization service returned an invalid response.',
            },
          },
    );
  }
  return parse(value);
}
