import { z } from 'zod';

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
