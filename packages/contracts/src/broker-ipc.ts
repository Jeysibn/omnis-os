import { z } from 'zod';
import {
  createRenderedRequestDigest,
  ConnectorAuthorizationRequestSchema,
  ConnectorExecutionAttemptSchema,
} from './connector-authorization.ts';
import {
  ConnectorDecisionEnvelopeSchema,
  SyntheticProviderEventSchema,
} from './connector-broker.ts';

const Uuid = z.string().uuid();
const Version = z.literal('omnis.broker-authorizer-ipc.v1');
const FakeProviderSubmissionId = z.string().regex(/^[A-Za-z0-9._~-]{1,128}$/);

export const BrokerConsumeRequestSchema = z
  .object({
    version: Version,
    authorizationId: Uuid,
    requestId: Uuid,
    request: ConnectorAuthorizationRequestSchema,
  })
  .strict();
export type BrokerConsumeRequest = z.infer<typeof BrokerConsumeRequestSchema>;

export const BrokerConsumeResponseSchema = z
  .object({
    version: Version,
    attempt: ConnectorExecutionAttemptSchema,
    envelope: ConnectorDecisionEnvelopeSchema,
  })
  .strict();

export const BrokerBeginSubmissionRequestSchema = z
  .object({
    version: Version,
    attemptId: Uuid,
    envelope: ConnectorDecisionEnvelopeSchema,
    renderedRequest: z
      .string()
      .min(1)
      .max(32_000)
      .refine((value) => !value.includes('\0') && value.trim().length > 0),
  })
  .strict();

export const BrokerRecordEventRequestSchema = z
  .object({
    version: Version,
    attemptId: Uuid,
    event: SyntheticProviderEventSchema,
  })
  .strict();

export const BrokerAttemptResponseSchema = z
  .object({ version: Version, attempt: ConnectorExecutionAttemptSchema })
  .strict();

export const BrokerRecoveryRequestSchema = z
  .object({
    version: Version,
    limit: z.number().int().min(1).max(100),
    afterAttemptId: Uuid.nullable(),
  })
  .strict();
export const BrokerRecoveryAttemptSchema = ConnectorExecutionAttemptSchema.omit({
  responseText: true,
});
export const BrokerRecoveryResponseSchema = z
  .object({
    version: Version,
    attempts: z.array(BrokerRecoveryAttemptSchema).max(100),
  })
  .strict();

export const SyntheticFakeProviderSubmissionRequestSchema = z
  .object({
    version: z.literal('omnis.fake-provider.v1'),
    attemptId: Uuid,
    envelope: ConnectorDecisionEnvelopeSchema,
    renderedRequest: z
      .string()
      .min(1)
      .max(32_000)
      .refine((value) => !value.includes('\0') && value.trim().length > 0),
  })
  .strict()
  .refine(
    (request) =>
      request.envelope.claims.attemptId === request.attemptId &&
      createRenderedRequestDigest(request.renderedRequest) === request.envelope.claims.promptDigest,
  );
export const SyntheticFakeProviderEventResponseSchema = z
  .object({
    version: z.literal('omnis.fake-provider.v1'),
    attemptId: Uuid,
    event: SyntheticProviderEventSchema,
  })
  .strict()
  .refine(
    (response) =>
      response.event.providerSubmissionId === undefined ||
      FakeProviderSubmissionId.safeParse(response.event.providerSubmissionId).success,
  );
export const SyntheticFakeProviderSubmissionResponseSchema = z
  .object({
    version: z.literal('omnis.fake-provider.v1'),
    attemptId: Uuid,
    providerSubmissionId: FakeProviderSubmissionId,
    event: SyntheticProviderEventSchema,
  })
  .strict()
  .refine(
    (response) =>
      response.event.providerSubmissionId === response.providerSubmissionId &&
      ['accepted', 'completed', 'failed'].includes(response.event.status),
  );

export const SyntheticFakeProviderCancellationRequestSchema = z
  .object({
    version: z.literal('omnis.fake-provider.v1'),
    attemptId: Uuid,
    providerSubmissionId: FakeProviderSubmissionId,
  })
  .strict();
export const SyntheticFakeProviderCancellationResponseSchema = z
  .object({
    version: z.literal('omnis.fake-provider.v1'),
    attemptId: Uuid,
    cancellation: z.enum(['requested', 'confirmed', 'unknown']),
    event: SyntheticProviderEventSchema.optional(),
  })
  .strict()
  .refine((response) =>
    response.cancellation === 'confirmed'
      ? response.event?.status === 'interrupted'
      : response.event?.status !== 'interrupted',
  )
  .refine(
    (response) =>
      response.event?.providerSubmissionId === undefined ||
      FakeProviderSubmissionId.safeParse(response.event.providerSubmissionId).success,
  );
