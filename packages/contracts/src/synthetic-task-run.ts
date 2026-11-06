import { z } from 'zod';
import { ConnectorAuthorizationRequestSchema } from './connector-authorization.ts';
import { ConnectorExecutionAttemptSchema } from './connector-authorization.ts';
import { ConnectorExecutionStatusSchema, UsageProvenanceSchema } from './connector-broker.ts';

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
    (value) => value.status !== 'completed' || value.responseText !== undefined,
    'Synthetic task run response identity or submission state is inconsistent.',
  );
export type SyntheticTaskRunResponse = z.infer<typeof SyntheticTaskRunResponseSchema>;

export const SyntheticTaskRunDetailSchema = z
  .object({
    version: z.literal('omnis.synthetic-task-run.v1'),
    taskId: z.string().min(1).max(128),
    attempt: ConnectorExecutionAttemptSchema,
    usage: UsageProvenanceSchema,
  })
  .strict();
export type SyntheticTaskRunDetail = z.infer<typeof SyntheticTaskRunDetailSchema>;

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
