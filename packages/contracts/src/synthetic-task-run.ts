import { z } from 'zod';
import { ConnectorAuthorizationRequestSchema } from './connector-authorization.ts';
import { ConnectorExecutionAttemptSchema } from './connector-authorization.ts';
import { ConnectorExecutionStatusSchema, UsageProvenanceSchema } from './connector-broker.ts';
import { RunSchema } from './index.ts';

export const SyntheticTaskRunRequestSchema = z
  .object({
    version: z.literal('omnis.synthetic-task-run.v1'),
    authorizationId: z.string().uuid(),
    requestId: z.string().uuid(),
    request: ConnectorAuthorizationRequestSchema,
    renderedRequest: z
      .string()
      .min(1)
      .max(32_000)
      .refine((value) => !value.includes('\0') && value.trim().length > 0),
  })
  .strict();
export type SyntheticTaskRunRequest = z.infer<typeof SyntheticTaskRunRequestSchema>;

/** API-to-worker contract. It contains no owner assertion or queued prompt payload. */
export const SyntheticTaskRunAdmissionRequestSchema = z
  .object({
    ...SyntheticTaskRunRequestSchema.shape,
    correlationId: z.string().uuid(),
  })
  .strict();
export type SyntheticTaskRunAdmissionRequest = z.infer<
  typeof SyntheticTaskRunAdmissionRequestSchema
>;

export const SyntheticTaskRunAdmissionResponseSchema = z
  .object({
    version: z.literal('omnis.synthetic-task-run.v1'),
    created: z.boolean(),
    run: RunSchema,
  })
  .strict();
export type SyntheticTaskRunAdmissionResponse = z.infer<
  typeof SyntheticTaskRunAdmissionResponseSchema
>;

export const SyntheticRunBindingSchema = z
  .object({
    version: z.literal('omnis.synthetic-task-run.v1'),
    runId: z.string().uuid(),
    taskId: z.string().min(1).max(128),
    authorizationId: z.string().uuid(),
  })
  .strict();
export type SyntheticRunBinding = z.infer<typeof SyntheticRunBindingSchema>;

export const SyntheticTaskRunResponseSchema = z
  .object({
    version: z.literal('omnis.synthetic-task-run.v1'),
    taskId: z.string().min(1).max(128),
    authorizationId: z.string().uuid(),
    requestId: z.string().uuid(),
    correlationId: z.string().uuid(),
    attemptId: z.string().uuid(),
    status: ConnectorExecutionStatusSchema,
    submitted: z.boolean(),
    usage: UsageProvenanceSchema,
    responseText: z.string().min(1).max(32_000).optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.status !== 'completed' || value.responseText !== undefined) &&
      (value.status !== 'unknown' || value.submitted),
    'Synthetic task run response submission state is inconsistent.',
  );
export type SyntheticTaskRunResponse = z.infer<typeof SyntheticTaskRunResponseSchema>;

export const SyntheticTaskRunDetailSchema = z
  .object({
    version: z.literal('omnis.synthetic-task-run.v1'),
    taskId: z.string().min(1).max(128),
    run: RunSchema.optional(),
    attempt: ConnectorExecutionAttemptSchema.optional(),
    usage: UsageProvenanceSchema,
  })
  .strict()
  .refine((value) => value.attempt !== undefined || value.run !== undefined);
export type SyntheticTaskRunDetail = z.infer<typeof SyntheticTaskRunDetailSchema>;

export const SyntheticTaskRunEventsQuerySchema = z
  .object({
    after: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,15})$/)
      .transform(Number)
      .pipe(z.number().int().min(0).safe())
      .optional()
      .transform((value) => value ?? 0),
    limit: z
      .string()
      .regex(/^[0-9]{1,3}$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(100))
      .optional()
      .transform((value) => value ?? 50),
  })
  .strict();
export type SyntheticTaskRunEventsQuery = z.infer<typeof SyntheticTaskRunEventsQuerySchema>;

export const SyntheticTaskRunEventSchema = z
  .object({
    attemptId: z.string().uuid(),
    sequence: z.number().int().positive().safe(),
    eventType: z.enum([
      'connector.authorization_consumed',
      'connector.submission_started',
      'connector.submission_accepted',
      'connector.execution_running',
      'connector.execution_completed',
      'connector.execution_failed',
      'connector.execution_interrupted',
      'connector.execution_unknown',
      'connector.cancellation_requested',
      'connector.cancellation_confirmed',
    ]),
    outcome: z.enum(['allowed', 'denied', 'recorded']),
    revocationGeneration: z.union([z.literal(0), z.literal(1)]),
    occurredAt: z.string().datetime(),
  })
  .strict();
export type SyntheticTaskRunEvent = z.infer<typeof SyntheticTaskRunEventSchema>;

export const SyntheticTaskRunEventsResponseSchema = z
  .object({
    version: z.literal('omnis.synthetic-task-run-events.v1'),
    authorizationId: z.string().uuid(),
    taskId: z.string().min(1).max(128),
    events: z.array(SyntheticTaskRunEventSchema).max(100),
    page: z.object({ nextAfter: z.number().int().positive().safe().nullable() }).strict(),
  })
  .strict()
  .refine(
    (value) =>
      value.page.nextAfter === null || value.page.nextAfter === value.events.at(-1)?.sequence,
    'The next event cursor must equal the last returned sequence.',
  )
  .refine(
    (value) =>
      value.events.every(
        (event, index) => index === 0 || event.sequence > value.events[index - 1]!.sequence,
      ),
    'Synthetic task-run event sequences must be strictly increasing.',
  );
export type SyntheticTaskRunEventsResponse = z.infer<typeof SyntheticTaskRunEventsResponseSchema>;

export const SyntheticTaskRunCancellationResponseSchema = z
  .object({
    requested: z.literal(true),
    confirmed: z.literal(false),
    authorizationId: z.string().uuid(),
    taskId: z.string().min(1).max(128),
  })
  .strict();

export function syntheticTaskRunTestMode(environment: {
  NODE_ENV?: string;
  OMNIS_SYNTHETIC_BROKER_TEST_MODE?: string;
}): boolean {
  const enabled = environment.OMNIS_SYNTHETIC_BROKER_TEST_MODE === '1';
  if (enabled && environment.NODE_ENV !== 'test') {
    throw new Error('Synthetic broker task routes may only be enabled in test mode.');
  }
  return enabled;
}
