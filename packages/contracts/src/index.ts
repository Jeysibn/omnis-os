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

const OpaqueIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._~-]*$/);
const AgentTimestampSchema = z.string().datetime();

export const AgentLifecycleSchema = z.enum(['draft', 'available', 'archived']);
export type AgentLifecycle = z.infer<typeof AgentLifecycleSchema>;

export const AgentDepartmentSummarySchema = z.object({
  id: OpaqueIdSchema,
  slug: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
});
export type AgentDepartmentSummary = z.infer<typeof AgentDepartmentSummarySchema>;

export const AgentCreatedBySchema = z.object({
  id: OpaqueIdSchema,
  displayName: z.string().min(1).max(120),
});
export type AgentCreatedBy = z.infer<typeof AgentCreatedBySchema>;

export const AgentCurrentVersionSummarySchema = z.object({
  versionNo: z.number().int().positive().max(2_147_483_647),
  profession: z.string().min(1).max(160),
  seniority: z.string().max(80).nullable(),
});
export type AgentCurrentVersionSummary = z.infer<typeof AgentCurrentVersionSummarySchema>;

export const AgentSummarySchema = z
  .object({
    id: OpaqueIdSchema,
    name: z.string().min(1).max(120),
    slug: z.string().min(1).max(80),
    department: AgentDepartmentSummarySchema.nullable(),
    lifecycle: AgentLifecycleSchema,
    archivedAt: AgentTimestampSchema.nullable(),
    currentVersion: AgentCurrentVersionSummarySchema.nullable(),
    provenance: z.enum(['owner_created', 'demo_seed']),
    createdAt: AgentTimestampSchema,
    updatedAt: AgentTimestampSchema,
  })
  .refine(
    (agent) =>
      (agent.lifecycle === 'archived') === (agent.archivedAt !== null) &&
      (agent.lifecycle === 'draft') === (agent.currentVersion === null),
    'Agent lifecycle, archive timestamp, and current version are inconsistent.',
  );
export type AgentSummary = z.infer<typeof AgentSummarySchema>;

export const AgentPageSchema = z
  .object({
    total: z.number().int().nonnegative(),
    complete: z.boolean(),
    nextCursor: z.string().min(1).max(1024).nullable(),
  })
  .refine((page) => page.complete === (page.nextCursor === null));
export type AgentPage = z.infer<typeof AgentPageSchema>;

export const AgentDirectoryResponseSchema = z
  .object({ agents: z.array(AgentSummarySchema).max(1000), page: AgentPageSchema })
  .refine(
    (result) =>
      result.page.complete &&
      result.page.total === result.agents.length &&
      new Set(result.agents.map((agent) => agent.id)).size === result.agents.length &&
      new Set(result.agents.map((agent) => agent.slug)).size === result.agents.length,
  );
export type AgentDirectoryResponse = z.infer<typeof AgentDirectoryResponseSchema>;

export const AgentProfileVersionSchema = z.object({
  versionId: OpaqueIdSchema,
  agentId: OpaqueIdSchema,
  versionNo: z.number().int().positive().max(2_147_483_647),
  profession: z.string().min(1).max(160),
  seniority: z.string().max(80).nullable(),
  specialties: z.array(z.string().min(1).max(100)).max(32),
  personality: z.object({
    traits: z.array(z.string().min(1).max(100)).max(32),
    tone: z.string().max(120).nullable(),
    principles: z.array(z.string().min(1).max(240)).max(32),
  }),
  behavior: z.object({
    autonomy: z.string().max(500).nullable(),
    escalation: z.string().max(1000).nullable(),
  }),
  instructions: z.string().max(16_384),
  createdBy: AgentCreatedBySchema,
  createdAt: AgentTimestampSchema,
});
export type AgentProfileVersion = z.infer<typeof AgentProfileVersionSchema>;

export const AgentProfileResponseSchema = z
  .object({
    agent: AgentSummarySchema,
    currentVersion: AgentProfileVersionSchema.nullable(),
  })
  .refine(
    (result) =>
      (result.agent.currentVersion === null && result.currentVersion === null) ||
      (result.agent.currentVersion !== null &&
        result.currentVersion !== null &&
        result.agent.currentVersion.versionNo === result.currentVersion.versionNo &&
        result.currentVersion.agentId === result.agent.id),
  );
export type AgentProfileResponse = z.infer<typeof AgentProfileResponseSchema>;

export const AgentProfileVersionSummarySchema = z.object({
  versionId: OpaqueIdSchema,
  versionNo: z.number().int().positive().max(2_147_483_647),
  profession: z.string().min(1).max(160),
  seniority: z.string().max(80).nullable(),
  createdAt: AgentTimestampSchema,
  createdBy: AgentCreatedBySchema,
  isCurrent: z.boolean(),
});
export type AgentProfileVersionSummary = z.infer<typeof AgentProfileVersionSummarySchema>;

export const AgentProfileVersionsResponseSchema = z
  .object({
    agent: AgentSummarySchema,
    versions: z.array(AgentProfileVersionSummarySchema).max(100),
    page: AgentPageSchema,
  })
  .refine(
    (result) =>
      new Set(result.versions.map((version) => version.versionNo)).size ===
        result.versions.length &&
      new Set(result.versions.map((version) => version.versionId)).size ===
        result.versions.length &&
      result.page.total >= result.versions.length &&
      result.versions.every(
        (version) =>
          version.isCurrent === (version.versionNo === result.agent.currentVersion?.versionNo),
      ) &&
      result.versions.every((version, index) => {
        const next = result.versions[index + 1];
        return !next || version.versionNo > next.versionNo;
      }),
  );
export type AgentProfileVersionsResponse = z.infer<typeof AgentProfileVersionsResponseSchema>;

export const AgentProfileVersionResponseSchema = z
  .object({
    agent: AgentSummarySchema,
    version: AgentProfileVersionSchema,
    isCurrent: z.boolean(),
  })
  .refine(
    (result) =>
      result.version.agentId === result.agent.id &&
      result.isCurrent === (result.agent.currentVersion?.versionNo === result.version.versionNo),
  );
export type AgentProfileVersionResponse = z.infer<typeof AgentProfileVersionResponseSchema>;

export const AgentIdSchema = OpaqueIdSchema;
export const AgentDirectoryQuerySchema = z.object({}).strict();
const PositiveQueryIntegerSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(100));
export const AgentVersionQuerySchema = z
  .object({
    cursor: z.string().min(1).max(1024).optional(),
    limit: PositiveQueryIntegerSchema.optional(),
  })
  .strict();
export type AgentVersionQuery = z.infer<typeof AgentVersionQuerySchema>;
export const AgentVersionRouteParamSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(2_147_483_647));

export const ApiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), requestId: z.string().optional() }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
