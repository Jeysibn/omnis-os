import { request as httpRequest } from 'node:http';
import { z } from 'zod';
import {
  SyntheticTaskRunRequestSchema,
  SyntheticTaskRunResponseSchema,
  type SyntheticTaskRunRequest,
  type SyntheticTaskRunResponse,
} from '@omnis/contracts/synthetic-task-run';
import { ConnectorExecutionStatusSchema } from '@omnis/contracts/connector-broker';

const BrokerResponseSchema = z
  .object({
    attemptId: z.string().uuid(),
    status: ConnectorExecutionStatusSchema,
    submitted: z.boolean(),
    correlationId: z.string().uuid().optional(),
    responseText: z.string().min(1).max(32_000).optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.status !== 'completed' || value.responseText !== undefined) &&
      (value.correlationId !== undefined || (value.status === 'unknown' && value.submitted)),
  );

export interface SyntheticBrokerExecutor {
  execute(taskId: string, request: SyntheticTaskRunRequest): Promise<SyntheticTaskRunResponse>;
}

export class SyntheticBrokerClient implements SyntheticBrokerExecutor {
  private readonly socketPath: string;
  private readonly callerToken: string;

  constructor(socketPath: string, callerToken: string) {
    if (!socketPath.startsWith('/') || !/^[a-f0-9]{64,128}$/i.test(callerToken)) {
      throw new Error('Synthetic broker test IPC configuration is invalid.');
    }
    this.socketPath = socketPath;
    this.callerToken = callerToken;
  }

  async execute(
    taskId: string,
    requestInput: SyntheticTaskRunRequest,
  ): Promise<SyntheticTaskRunResponse> {
    const request = SyntheticTaskRunRequestSchema.parse(requestInput);
    if (request.request.taskId !== taskId) throw new Error('Synthetic broker task binding failed.');
    const brokerResult = BrokerResponseSchema.parse(
      await this.post({
        version: 'omnis.synthetic-broker.v1',
        authorizationId: request.authorizationId,
        requestId: request.requestId,
        request: request.request,
        renderedRequest: request.renderedRequest,
      }),
    );
    return SyntheticTaskRunResponseSchema.parse({
      version: 'omnis.synthetic-task-run.v1',
      taskId,
      authorizationId: request.authorizationId,
      requestId: request.requestId,
      correlationId: brokerResult.correlationId,
      attemptId: brokerResult.attemptId,
      status: brokerResult.status,
      submitted: brokerResult.submitted,
      usage:
        brokerResult.status === 'unknown'
          ? { kind: 'unknown', reason: 'submission_uncertain', billingExposure: 'unknown' }
          : { kind: 'unknown', reason: 'not_reported', billingExposure: 'unknown' },
      ...(brokerResult.responseText ? { responseText: brokerResult.responseText } : {}),
    });
  }

  private post(value: unknown): Promise<unknown> {
    const payload = Buffer.from(JSON.stringify(value));
    if (payload.length > 64 * 1024) throw new Error('Synthetic broker request exceeds its limit.');
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          socketPath: this.socketPath,
          path: '/internal/broker/v1/submit',
          method: 'POST',
          headers: {
            host: 'localhost',
            connection: 'close',
            'content-type': 'application/json',
            'content-length': payload.length,
            authorization: `Bearer ${this.callerToken}`,
          },
          timeout: 10_000,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 64 * 1024) {
              response.destroy(new Error('Synthetic broker response exceeds its limit.'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (response.statusCode !== 200 && response.statusCode !== 202) {
              reject(
                new Error(
                  `Synthetic broker rejected the request with status ${response.statusCode}.`,
                ),
              );
              return;
            }
            try {
              resolve(JSON.parse(text) as unknown);
            } catch {
              reject(new Error('Synthetic broker response was invalid.'));
            }
          });
        },
      );
      request.on('timeout', () =>
        request.destroy(new Error('Synthetic broker request timed out.')),
      );
      request.on('error', reject);
      request.end(payload);
    });
  }
}
