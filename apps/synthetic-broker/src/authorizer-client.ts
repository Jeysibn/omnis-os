import { request as httpRequest } from 'node:http';
import {
  BrokerAttemptResponseSchema,
  BrokerConsumeResponseSchema,
  BrokerRecoveryResponseSchema,
} from '@omnis/contracts/broker-ipc';
import type { ConnectorAuthorizationRequest } from '@omnis/contracts/connector-authorization';
import type {
  ConnectorDecisionEnvelope,
  SyntheticProviderEvent,
} from '@omnis/contracts/connector-broker';

const version = 'omnis.broker-authorizer-ipc.v1' as const;

export class AuthorizerClient {
  private readonly socketPath: string;
  private readonly token: string;

  constructor(socketPath: string, token: string) {
    this.socketPath = socketPath;
    this.token = token;
  }

  async admit(authorizationId: string, requestId: string, request: ConnectorAuthorizationRequest) {
    const body = await this.post('/internal/broker/v1/admissions', {
      version,
      authorizationId,
      requestId,
      request,
    });
    return BrokerConsumeResponseSchema.parse(body);
  }

  async begin(attemptId: string, envelope: ConnectorDecisionEnvelope, renderedRequest: string) {
    const body = await this.post('/internal/broker/v1/submissions/begin', {
      version,
      attemptId,
      envelope,
      renderedRequest,
    });
    return BrokerAttemptResponseSchema.parse(body).attempt;
  }

  async record(attemptId: string, event: SyntheticProviderEvent) {
    const body = await this.post('/internal/broker/v1/provider-events', {
      version,
      attemptId,
      event,
    });
    return BrokerAttemptResponseSchema.parse(body).attempt;
  }

  async recovery(limit = 100, afterAttemptId: string | null = null) {
    const body = await this.post('/internal/broker/v1/recovery/list', {
      version,
      limit,
      afterAttemptId,
    });
    return BrokerRecoveryResponseSchema.parse(body).attempts;
  }

  private post(path: string, value: unknown): Promise<unknown> {
    const payload = Buffer.from(JSON.stringify(value));
    if (payload.length > 64 * 1024) throw new Error('Authorizer IPC request exceeds its limit.');
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          socketPath: this.socketPath,
          path,
          method: 'POST',
          headers: {
            host: 'localhost',
            connection: 'close',
            'content-type': 'application/json',
            'content-length': payload.length,
            authorization: `Bearer ${this.token}`,
            'x-omnis-service-identity': 'omnis-synthetic-broker',
          },
          timeout: 2_000,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 64 * 1024) {
              response.destroy(new Error('Authorizer IPC response exceeds its limit.'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (response.statusCode !== 200) {
              reject(
                new Error(`Authorizer operation failed closed with status ${response.statusCode}.`),
              );
              return;
            }
            try {
              resolve(JSON.parse(text) as unknown);
            } catch {
              reject(new Error('Authorizer IPC response was invalid.'));
            }
          });
        },
      );
      request.on('timeout', () => request.destroy(new Error('Authorizer IPC timed out.')));
      request.on('error', reject);
      request.end(payload);
    });
  }
}
