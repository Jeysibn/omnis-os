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

export const ProjectIdSchema = z.string().regex(/^prj_[0-9a-f]{32}$/);
export const TaskIdSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !value.includes('\0'));

export const TaskSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1).max(120),
    detail: z.string().max(2000),
    status: TaskStatusSchema,
    createdAt: z.string().datetime(),
    projectId: ProjectIdSchema.nullable().optional(),
    associationRevision: z.number().int().positive().safe().optional(),
    agentId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/)
      .nullable()
      .default(null),
    profileVersion: z.number().int().positive().safe().nullable().default(null),
    runtimeId: z.literal('mock').nullable().default(null),
    assignmentRevision: z.number().int().positive().safe().default(1),
  })
  .superRefine((task, context) => {
    const assigned = [task.agentId, task.profileVersion, task.runtimeId].filter(
      (value) => value !== undefined && value !== null,
    ).length;
    if (assigned !== 0 && assigned !== 3) {
      context.addIssue({ code: 'custom', message: 'Task execution assignment must be complete.' });
    }
  });
export type Task = z.infer<typeof TaskSchema>;

export const CreateTaskSchema = z.object({
  title: z.string().trim().min(3).max(120),
  detail: z.string().trim().min(10).max(2000),
  projectId: ProjectIdSchema.nullable().optional(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;

export const SetTaskProjectSchema = z
  .object({
    projectId: ProjectIdSchema.nullable(),
    expectedAssociationRevision: z.number().int().positive().safe(),
  })
  .strict();
export type SetTaskProjectInput = z.infer<typeof SetTaskProjectSchema>;

export const SetTaskExecutionAssignmentSchema = z
  .object({
    agentId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/)
      .nullable(),
    profileVersion: z.number().int().positive().safe().nullable(),
    runtimeId: z.literal('mock').nullable(),
    expectedAssignmentRevision: z.number().int().positive().safe(),
  })
  .strict()
  .refine(
    (assignment) =>
      (assignment.agentId === null &&
        assignment.profileVersion === null &&
        assignment.runtimeId === null) ||
      (assignment.agentId !== null &&
        assignment.profileVersion !== null &&
        assignment.runtimeId !== null),
    'Task execution assignment must be complete or cleared.',
  );
export type SetTaskExecutionAssignmentInput = z.infer<typeof SetTaskExecutionAssignmentSchema>;

export const ProjectStatusSchema = z.enum([
  'proposed',
  'active',
  'paused',
  'completed',
  'archived',
]);
export const ProjectPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
export const ProjectRevisionSchema = z.number().int().positive().safe();
export const CreateProjectSchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(2)
      .max(32)
      .regex(/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/),
    name: z.string().trim().min(1).max(120),
    objective: z.string().trim().min(1).max(4000),
    priority: ProjectPrioritySchema.default('normal'),
  })
  .strict()
  .refine(
    (project) =>
      !project.key.includes('\0') &&
      !project.name.includes('\0') &&
      !project.objective.includes('\0'),
    'Project text cannot contain NUL characters.',
  );
export type CreateProjectInput = z.infer<typeof CreateProjectSchema>;

export const UpdateProjectSchema = z
  .object({
    expectedRevision: ProjectRevisionSchema,
    name: z.string().trim().min(1).max(120).optional(),
    objective: z.string().trim().min(1).max(4000).optional(),
    priority: ProjectPrioritySchema.optional(),
  })
  .strict()
  .refine(
    (project) =>
      project.name !== undefined ||
      project.objective !== undefined ||
      project.priority !== undefined,
    'At least one project field must be changed.',
  )
  .refine(
    (project) => !project.name?.includes('\0') && !project.objective?.includes('\0'),
    'Project text cannot contain NUL characters.',
  );
export type UpdateProjectInput = z.infer<typeof UpdateProjectSchema>;

export const ArchiveProjectSchema = z.object({ expectedRevision: ProjectRevisionSchema }).strict();
export type ArchiveProjectInput = z.infer<typeof ArchiveProjectSchema>;

export const ProjectSummarySchema = z
  .object({
    id: ProjectIdSchema,
    ownerId: z.literal('owner'),
    key: z.string().min(2).max(32),
    name: z.string().min(1).max(120),
    status: ProjectStatusSchema,
    priority: ProjectPrioritySchema,
    revision: ProjectRevisionSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const ProjectSchema = ProjectSummarySchema.extend({
  objective: z.string().min(1).max(4000),
}).strict();
export type Project = z.infer<typeof ProjectSchema>;

export const EpicIdSchema = z.string().regex(/^epc_[0-9a-f]{32}$/);
export const EpicStatusSchema = z.enum(['planned', 'in_progress', 'completed', 'archived']);
export const EpicRevisionSchema = z.number().int().positive().safe();
const EpicTextSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !value.includes('\0'));

export const CreateEpicSchema = z
  .object({
    title: EpicTextSchema.max(120),
    description: z
      .string()
      .trim()
      .max(2000)
      .refine((value) => !value.includes('\0'))
      .optional(),
  })
  .strict();
export type CreateEpicInput = z.infer<typeof CreateEpicSchema>;

export const UpdateEpicSchema = z
  .object({
    expectedRevision: EpicRevisionSchema,
    title: EpicTextSchema.max(120).optional(),
    description: z
      .string()
      .trim()
      .max(2000)
      .refine((value) => !value.includes('\0'))
      .nullable()
      .optional(),
    status: z.enum(['planned', 'in_progress', 'completed']).optional(),
  })
  .strict()
  .refine(
    (epic) =>
      epic.title !== undefined || epic.description !== undefined || epic.status !== undefined,
    'At least one Epic field must be changed.',
  );
export type UpdateEpicInput = z.infer<typeof UpdateEpicSchema>;

export const ArchiveEpicSchema = z.object({ expectedRevision: EpicRevisionSchema }).strict();
export type ArchiveEpicInput = z.infer<typeof ArchiveEpicSchema>;

export const EpicSchema = z
  .object({
    id: EpicIdSchema,
    projectId: ProjectIdSchema,
    title: z.string().min(1).max(120),
    description: z.string().max(2000).nullable(),
    status: EpicStatusSchema,
    revision: EpicRevisionSchema,
    archivedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .refine((epic) => (epic.status === 'archived') === (epic.archivedAt !== null));
export type Epic = z.infer<typeof EpicSchema>;

export const SetTaskEpicSchema = z
  .object({
    expectedAssociationRevision: z.number().int().positive().safe(),
    epicId: EpicIdSchema.nullable(),
  })
  .strict();
export type SetTaskEpicInput = z.infer<typeof SetTaskEpicSchema>;

export const TaskEpicAssociationSchema = z
  .object({
    taskId: TaskIdSchema,
    projectId: ProjectIdSchema.nullable(),
    epicId: EpicIdSchema.nullable(),
    associationRevision: z.number().int().positive().safe(),
  })
  .strict();
export type TaskEpicAssociation = z.infer<typeof TaskEpicAssociationSchema>;

export const EpicListQuerySchema = z
  .object({
    cursor: z.string().min(1).max(1024).optional(),
    limit: z
      .union([
        z
          .string()
          .regex(/^[1-9][0-9]*$/)
          .transform(Number),
        z.number().int(),
      ])
      .pipe(z.number().int().min(1).max(100))
      .optional(),
  })
  .strict();
export type EpicListQuery = z.infer<typeof EpicListQuerySchema>;

export const MilestoneIdSchema = z.string().regex(/^mil_[0-9a-f]{32}$/);
export const MilestoneStatusSchema = z.enum(['planned', 'in_progress', 'completed', 'archived']);
export const MilestoneRevisionSchema = z.number().int().positive().safe();
export const MilestoneTargetDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    if (value.startsWith('0000-')) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
  }, 'Target date must be a valid calendar date.');

const MilestoneTextSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !value.includes('\0'));

export const CreateMilestoneSchema = z
  .object({
    title: MilestoneTextSchema.max(120),
    description: z
      .string()
      .trim()
      .max(2000)
      .refine((value) => !value.includes('\0'))
      .optional(),
    targetDate: MilestoneTargetDateSchema.nullable().optional(),
  })
  .strict();
export type CreateMilestoneInput = z.infer<typeof CreateMilestoneSchema>;

export const UpdateMilestoneSchema = z
  .object({
    expectedRevision: MilestoneRevisionSchema,
    title: MilestoneTextSchema.max(120).optional(),
    description: z
      .string()
      .trim()
      .max(2000)
      .refine((value) => !value.includes('\0'))
      .nullable()
      .optional(),
    targetDate: MilestoneTargetDateSchema.nullable().optional(),
    status: z.enum(['planned', 'in_progress', 'completed']).optional(),
  })
  .strict()
  .refine(
    (milestone) =>
      milestone.title !== undefined ||
      milestone.description !== undefined ||
      milestone.targetDate !== undefined ||
      milestone.status !== undefined,
    'At least one milestone field must be changed.',
  );
export type UpdateMilestoneInput = z.infer<typeof UpdateMilestoneSchema>;

export const ArchiveMilestoneSchema = z
  .object({ expectedRevision: MilestoneRevisionSchema })
  .strict();
export type ArchiveMilestoneInput = z.infer<typeof ArchiveMilestoneSchema>;

export const MilestoneSchema = z
  .object({
    id: MilestoneIdSchema,
    projectId: ProjectIdSchema,
    title: z.string().min(1).max(120),
    description: z.string().max(2000).nullable(),
    status: MilestoneStatusSchema,
    targetDate: MilestoneTargetDateSchema.nullable(),
    revision: MilestoneRevisionSchema,
    archivedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .refine((milestone) => (milestone.status === 'archived') === (milestone.archivedAt !== null));
export type Milestone = z.infer<typeof MilestoneSchema>;

export const MilestoneListQuerySchema = z
  .object({
    cursor: z.string().min(1).max(1024).optional(),
    limit: z
      .union([
        z
          .string()
          .regex(/^[1-9][0-9]*$/)
          .transform(Number),
        z.number().int(),
      ])
      .pipe(z.number().int().min(1).max(100))
      .optional(),
  })
  .strict();
export type MilestoneListQuery = z.infer<typeof MilestoneListQuerySchema>;

export const ProjectWorkspaceQuerySchema = z
  .object({
    cursor: z.string().min(1).max(1024).optional(),
    limit: z
      .union([
        z
          .string()
          .regex(/^[1-9][0-9]*$/)
          .transform(Number),
        z.number().int(),
      ])
      .pipe(z.number().int().min(1).max(100))
      .optional(),
  })
  .strict();
export type ProjectWorkspaceQuery = z.infer<typeof ProjectWorkspaceQuerySchema>;

export const ProjectWorkspaceTaskSummarySchema = z
  .object({
    id: TaskIdSchema,
    title: z.string().min(1).max(120),
    status: TaskStatusSchema,
    createdAt: z.string().datetime(),
    projectId: ProjectIdSchema,
    associationRevision: z.number().int().positive().safe(),
    latestRun: z
      .object({
        id: z.string().min(1),
        status: RunStatusSchema,
        createdAt: z.string().datetime(),
        updatedAt: z.string().datetime(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type ProjectWorkspaceTaskSummary = z.infer<typeof ProjectWorkspaceTaskSummarySchema>;

export const TaskEpicResponseSchema = z
  .object({
    taskId: TaskIdSchema,
    projectId: ProjectIdSchema.nullable(),
    epic: EpicSchema.nullable(),
    associationRevision: z.number().int().positive().safe(),
  })
  .strict()
  .refine((response) => response.epic === null || response.epic.projectId === response.projectId);
export type TaskEpicResponse = z.infer<typeof TaskEpicResponseSchema>;

export const ProjectWorkspacePageSchema = z
  .object({
    observedTotal: z.number().int().nonnegative().safe(),
    complete: z.boolean(),
    nextCursor: z.string().min(1).max(1024).nullable(),
  })
  .strict()
  .refine((page) => page.complete === (page.nextCursor === null));
export type ProjectWorkspacePage = z.infer<typeof ProjectWorkspacePageSchema>;

export const MilestoneListResponseSchema = z
  .object({
    milestones: z.array(MilestoneSchema).max(100),
    page: ProjectWorkspacePageSchema,
  })
  .strict()
  .refine((response) => response.page.observedTotal >= response.milestones.length);
export type MilestoneListResponse = z.infer<typeof MilestoneListResponseSchema>;

export const EpicListResponseSchema = z
  .object({
    epics: z.array(EpicSchema).max(100),
    page: ProjectWorkspacePageSchema,
  })
  .strict()
  .refine((response) => response.page.observedTotal >= response.epics.length);
export type EpicListResponse = z.infer<typeof EpicListResponseSchema>;

export const ProjectWorkspaceTaskPageSchema = z
  .object({
    tasks: z.array(ProjectWorkspaceTaskSummarySchema).max(100),
    page: ProjectWorkspacePageSchema,
  })
  .strict()
  .refine((result) => result.page.observedTotal >= result.tasks.length);
export type ProjectWorkspaceTaskPage = z.infer<typeof ProjectWorkspaceTaskPageSchema>;

export const ProjectEpicTaskPageSchema = ProjectWorkspaceTaskPageSchema;
export type ProjectEpicTaskPage = z.infer<typeof ProjectEpicTaskPageSchema>;

export const ProjectWorkspaceResponseSchema = z
  .object({
    project: ProjectSchema,
    tasks: z.array(ProjectWorkspaceTaskSummarySchema).max(100),
    page: ProjectWorkspacePageSchema,
  })
  .strict()
  .refine((result) => result.page.observedTotal >= result.tasks.length);
export type ProjectWorkspaceResponse = z.infer<typeof ProjectWorkspaceResponseSchema>;

export const ProjectListResponseSchema = z
  .object({
    projects: z.array(ProjectSummarySchema).max(500),
    total: z.number().int().nonnegative(),
    complete: z.literal(true),
  })
  .strict()
  .refine(
    (result) =>
      result.total === result.projects.length &&
      new Set(result.projects.map((project) => project.id)).size === result.projects.length &&
      new Set(result.projects.map((project) => project.key)).size === result.projects.length,
  );
export type ProjectListResponse = z.infer<typeof ProjectListResponseSchema>;

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
  authorizationId: z.string().uuid().nullable().optional(),
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
  'run.provider_submission_requested',
  'run.output',
  'run.stop_requested',
  'run.completed',
  'run.cancelled',
  'run.failed',
  'run.interrupted',
  'run.outcome_unknown',
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

export const AgentProfileWriteInputSchema = z
  .object({
    profession: z.string().trim().min(1).max(160),
    seniority: z.string().max(80).nullable(),
    specialties: z.array(z.string().min(1).max(100)).max(32),
    personality: z
      .object({
        traits: z.array(z.string().min(1).max(100)).max(32),
        tone: z.string().max(120).nullable(),
        principles: z.array(z.string().min(1).max(240)).max(32),
      })
      .strict(),
    behavior: z
      .object({
        autonomy: z.string().max(500).nullable(),
        escalation: z.string().max(1000).nullable(),
      })
      .strict(),
    instructions: z.string().max(16_384),
  })
  .strict();
export type AgentProfileWriteInput = z.infer<typeof AgentProfileWriteInputSchema>;

export const AgentIdempotencyKeySchema = z.string().uuid();
export const CreateAgentInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(80),
    departmentId: OpaqueIdSchema.nullable(),
  })
  .strict();
export type CreateAgentInput = z.infer<typeof CreateAgentInputSchema>;

export const SaveAgentProfileDraftInputSchema = z
  .object({
    expectedDraftRevision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    baseVersionNo: z.number().int().positive().max(2_147_483_647).nullable(),
    profile: AgentProfileWriteInputSchema,
  })
  .strict();
export type SaveAgentProfileDraftInput = z.infer<typeof SaveAgentProfileDraftInputSchema>;

export const PublishAgentProfileInputSchema = z
  .object({
    expectedVersionNo: z.number().int().positive().max(2_147_483_647).nullable(),
    expectedDraftRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type PublishAgentProfileInput = z.infer<typeof PublishAgentProfileInputSchema>;

export const AgentProfileDraftResponseSchema = z
  .object({
    agentId: OpaqueIdSchema,
    draftRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    baseVersionNo: z.number().int().positive().max(2_147_483_647).nullable(),
    profile: AgentProfileWriteInputSchema.nullable(),
    updatedAt: AgentTimestampSchema.nullable(),
  })
  .strict()
  .refine((draft) =>
    draft.profile === null
      ? draft.baseVersionNo === null && draft.updatedAt === null
      : draft.draftRevision > 0 && draft.updatedAt !== null,
  );
export type AgentProfileDraftResponse = z.infer<typeof AgentProfileDraftResponseSchema>;

export const AgentMutationReceiptSchema = z
  .object({
    requestId: AgentIdempotencyKeySchema,
    operation: z.enum([
      'agent.created',
      'profile.draft_saved',
      'profile.published',
      'agent.archived',
    ]),
    agentId: OpaqueIdSchema,
    lifecycle: AgentLifecycleSchema,
    versionId: OpaqueIdSchema.nullable(),
    versionNo: z.number().int().positive().max(2_147_483_647).nullable(),
    draftRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    occurredAt: AgentTimestampSchema,
  })
  .strict()
  .refine(
    (receipt) =>
      (receipt.versionId === null) === (receipt.versionNo === null) &&
      (receipt.operation === 'profile.published') === (receipt.versionId !== null),
  );
export type AgentMutationReceipt = z.infer<typeof AgentMutationReceiptSchema>;

export const DepartmentIdSchema = OpaqueIdSchema;
export const DepartmentSchema = z
  .object({
    id: DepartmentIdSchema,
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(80),
    name: z.string().trim().min(1).max(120),
    archivedAt: AgentTimestampSchema.nullable(),
    createdAt: AgentTimestampSchema,
    updatedAt: AgentTimestampSchema,
  })
  .strict();
export type Department = z.infer<typeof DepartmentSchema>;

export const DepartmentListQuerySchema = z
  .object({ includeArchived: z.enum(['true', 'false']).optional() })
  .strict();
export const DepartmentListResponseSchema = z
  .object({ departments: z.array(DepartmentSchema).max(500), total: z.number().int().min(0) })
  .strict()
  .refine((result) => result.departments.length === result.total);
export type DepartmentListResponse = z.infer<typeof DepartmentListResponseSchema>;

export const CreateDepartmentSchema = z
  .object({
    slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(80),
    name: z.string().trim().min(1).max(120),
  })
  .strict();
export type CreateDepartmentInput = z.infer<typeof CreateDepartmentSchema>;
export const UpdateDepartmentSchema = CreateDepartmentSchema;

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
