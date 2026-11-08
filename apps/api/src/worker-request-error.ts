import type { ApiError } from '@omnis/contracts';

export class WorkerRequestError extends Error {
  readonly statusCode: number;
  readonly body: ApiError;

  constructor(statusCode: number, body: ApiError) {
    super(body.error.message);
    this.statusCode = statusCode;
    this.body = body;
  }
}
