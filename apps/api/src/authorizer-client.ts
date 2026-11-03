import { ApiErrorSchema } from '@omnis/contracts';
import type { ApiError } from '@omnis/contracts';
import { request as httpRequest } from 'node:http';
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
    response = await unixRequest(
      env.authorizerSocket,
      path,
      init.method ?? 'GET',
      headers,
      init.body,
    );
  } catch (error) {
    const outcomeUnknown = error instanceof AuthorizerTransportError && error.mayHaveCommitted;
    throw new AuthorizerRequestError(503, {
      error: {
        code: outcomeUnknown ? 'authorization_outcome_unknown' : 'authorizer_unavailable',
        message: outcomeUnknown
          ? 'The authorizer response was lost; the decision may have committed. Retry with the same idempotency key or read the authorization state.'
          : 'The authorizer could not be reached; no decision was submitted. Retry when the service is available.',
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
  try {
    return parse(value);
  } catch {
    if ((init.method ?? 'GET') !== 'GET') {
      throw new AuthorizerRequestError(503, {
        error: {
          code: 'authorization_outcome_unknown',
          message:
            'The authorizer response could not be validated; the decision may have committed. Read the authorization state or retry with the same idempotency key.',
        },
      });
    }
    throw new AuthorizerRequestError(503, {
      error: {
        code: 'authorizer_error',
        message: 'The authorization service returned an invalid response.',
      },
    });
  }
}

class AuthorizerTransportError extends Error {
  readonly mayHaveCommitted: boolean;

  constructor(mayHaveCommitted: boolean) {
    super('The authorizer transport failed.');
    this.mayHaveCommitted = mayHaveCommitted;
  }
}

function unixRequest(
  socketPath: string,
  path: string,
  method: string,
  headers: Headers,
  body: RequestInit['body'],
): Promise<Response> {
  return new Promise((resolve, reject) => {
    let requestMayHaveCommitted = false;
    const headerRecord: Record<string, string> = {};
    headers.forEach((value, key) => {
      headerRecord[key] = value;
    });
    const req = httpRequest({ socketPath, path, method, headers: headerRecord }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        data += chunk;
        if (data.length > 1024 * 1024) req.destroy(new Error('authorizer_response_too_large'));
      });
      res.once('end', () => resolve(new Response(data, { status: res.statusCode ?? 503 })));
    });
    const timer = setTimeout(() => req.destroy(new Error('authorizer_timeout')), 5_000);
    req.on('socket', (socket) => {
      // Unix sockets may already be connected by the time Node emits `socket`.
      requestMayHaveCommitted = !socket.connecting;
      socket.once('connect', () => {
        requestMayHaveCommitted = true;
      });
    });
    req.once('close', () => clearTimeout(timer));
    req.once('error', (error: NodeJS.ErrnoException) => {
      const definitelyBeforeConnect = ['ENOENT', 'EACCES', 'ECONNREFUSED', 'ENOTSOCK'].includes(
        error.code ?? '',
      );
      const mayHaveCommitted =
        requestMayHaveCommitted || (method !== 'GET' && !definitelyBeforeConnect);
      reject(new AuthorizerTransportError(mayHaveCommitted));
    });
    if (typeof body === 'string') req.end(body);
    else req.end();
  });
}
