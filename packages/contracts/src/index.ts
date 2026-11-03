import { z } from 'zod';

export const RunStatusSchema = z.enum([
  'queued',
  'running',
  'stopping',
  'completed',
  'cancelled',
  'failed',
  'interrupted',
  'unknown',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const TaskStatusSchema = z.enum(['open', 'in_progress', 'completed']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(120),
  detail: z.string().max(2000),
  status: TaskStatusSchema,
  createdAt: z.string().datetime(),
});
export type Task = z.infer<typeof TaskSchema>;

export const CreateTaskSchema = z.object({
  title: z.string().trim().min(3).max(120),
  detail: z.string().trim().min(10).max(2000),
});
export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;

export const UsageSchema = z.object({
  quality: z.literal('unknown'),
  inputTokens: z.null(),
  outputTokens: z.null(),
  cost: z.null(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const RunSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  taskTitle: z.string().min(1),
  status: RunStatusSchema,
  runtimeKind: z.literal('mock'),
  synthetic: z.literal(true),
  usage: UsageSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Run = z.infer<typeof RunSchema>;

export const RunEventTypeSchema = z.enum([
  'run.queued',
  'run.started',
  'run.output',
  'run.stop_requested',
  'run.completed',
  'run.cancelled',
  'run.failed',
  'run.interrupted',
]);
export type RunEventType = z.infer<typeof RunEventTypeSchema>;

export const RunEventSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  sequence: z.number().int().positive(),
  at: z.string().datetime(),
  type: RunEventTypeSchema,
  source: z.literal('mock'),
  synthetic: z.literal(true),
  message: z.string().max(2000),
});
export type RunEvent = z.infer<typeof RunEventSchema>;

export const CreateRunSchema = z.object({
  taskId: z.string().min(1),
  authorizationId: z.string().uuid(),
});
export type CreateRunInput = z.infer<typeof CreateRunSchema>;

export const CreateAuthorizationSchema = z.object({ taskId: z.string().min(1) }).strict();
export const AuthorizationDecisionSchema = z
  .object({ decision: z.enum(['approve', 'deny']) })
  .strict();
export const AuthorizationSchema = z
  .object({
    id: z.string().uuid(),
    requestingActor: z.literal('owner'),
    runtimeId: z.literal('mock'),
    operation: z.literal('execute_task'),
    taskId: z.string().min(1),
    capabilities: z.array(z.literal('mock.execute')),
    scope: z.object({ kind: z.literal('task'), taskId: z.string().min(1) }).strict(),
    status: z.enum(['pending', 'authorized', 'denied', 'revoked', 'expired']),
    policyVersion: z.string().min(1),
    correlationId: z.string().min(1),
    expiresAt: z.string().datetime(),
    createdAt: z.string().datetime(),
    decidedAt: z.string().datetime().nullable(),
    decidedBy: z.literal('owner').nullable(),
    revokedAt: z.string().datetime().nullable(),
    revokedBy: z.literal('owner').nullable(),
    consumedAt: z.string().datetime().nullable(),
    consumedRunId: z.string().nullable(),
  })
  .strict();
export type Authorization = z.infer<typeof AuthorizationSchema>;

export const CapabilitiesSchema = z.object({
  runtimeKind: z.literal('mock'),
  allowedUse: z.literal('both'),
  canStreamEvents: z.literal(true),
  canCancel: z.literal(true),
  canReportUsage: z.literal(false),
  synthetic: z.literal(true),
});
export type RuntimeCapabilities = z.infer<typeof CapabilitiesSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), requestId: z.string().optional() }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
