import { request as httpRequest } from 'node:http';
import {
  SyntheticFakeProviderCancellationResponseSchema,
  SyntheticFakeProviderEventResponseSchema,
  SyntheticFakeProviderSubmissionResponseSchema,
} from '@omnis/contracts/broker-ipc';
import type { ConnectorDecisionEnvelope } from '@omnis/contracts/connector-broker';
import { readBoundedResponse } from './bounded-http-response.ts';

const origin = 'http://omnis-synthetic-provider:8787';

export class FakeProviderResponseError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Fake provider returned status ${status}.`);
    this.status = status;
  }
}

export class FakeProviderClient {
  private readonly token: string;

  constructor(token: string) {
    this.token = token;
  }

  async submit(attemptId: string, envelope: ConnectorDecisionEnvelope, renderedRequest: string) {
    const response = await this.send(
      '/v1/submissions',
      'POST',
      {
        version: 'omnis.fake-provider.v1',
        attemptId,
        envelope,
        renderedRequest,
      },
      5_000,
    );
    return SyntheticFakeProviderSubmissionResponseSchema.parse(response);
  }

  async events(attemptId: string, providerSubmissionId: string) {
    const path = `/v1/submissions/${encodeURIComponent(providerSubmissionId)}/events`;
    const response = await this.send(path, 'GET');
    const parsed = SyntheticFakeProviderEventResponseSchema.parse(response);
    if (
      parsed.attemptId !== attemptId ||
      parsed.event.providerSubmissionId !== providerSubmissionId
    )
      throw new Error('Fake provider event correlation mismatch.');
    return parsed;
  }

  async cancel(attemptId: string, providerSubmissionId: string) {
    const response = await this.send(
      `/v1/submissions/${encodeURIComponent(providerSubmissionId)}`,
      'DELETE',
      {
        version: 'omnis.fake-provider.v1',
        attemptId,
        providerSubmissionId,
      },
      2_000,
    );
    const parsed = SyntheticFakeProviderCancellationResponseSchema.parse(response);
    if (
      parsed.attemptId !== attemptId ||
      (parsed.cancellation === 'confirmed' &&
        parsed.event?.providerSubmissionId !== providerSubmissionId)
    )
      throw new Error('Fake provider cancellation correlation mismatch.');
    return parsed;
  }

  private send(path: string, method: string, value?: unknown, timeoutMs = 2_000): Promise<unknown> {
    const url = new URL(path, origin);
    if (
      url.origin !== origin ||
      url.hostname !== 'omnis-synthetic-provider' ||
      url.port !== '8787'
    ) {
      throw new Error('Fake provider destination is not allowlisted.');
    }
    const payload = value === undefined ? undefined : Buffer.from(JSON.stringify(value));
    if (payload && payload.length > 64 * 1024)
      throw new Error('Fake provider request exceeds its limit.');
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          // The fixed Docker subnet is also the broker's only systemd IPAddressAllow.
          // Host-header remains the documented service name; no resolver or caller DNS is used.
          hostname: '172.29.87.10',
          port: 8787,
          path: `${url.pathname}${url.search}`,
          method,
          headers: {
            host: 'omnis-synthetic-provider:8787',
            connection: 'close',
            authorization: `Bearer ${this.token}`,
            ...(payload
              ? { 'content-type': 'application/json', 'content-length': payload.length }
              : {}),
          },
          timeout: timeoutMs,
        },
        (response) => {
          if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
            response.destroy();
            reject(new Error('Fake provider redirects are prohibited.'));
            return;
          }
          void readBoundedResponse(response, 64 * 1024, 'Fake provider response exceeds its limit.')
            .then((body) => {
              if (response.statusCode !== 200 && response.statusCode !== 202) {
                reject(new FakeProviderResponseError(response.statusCode ?? 0));
                return;
              }
              try {
                resolve(JSON.parse(body.toString('utf8')) as unknown);
              } catch {
                reject(new Error('Fake provider response was invalid.'));
              }
            })
            .catch(reject);
        },
      );
      request.on('timeout', () => request.destroy(new Error('Fake provider request timed out.')));
      request.on('error', reject);
      request.end(payload);
    });
  }
}
