import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AgentDirectoryResponseSchema,
  AgentProfileWriteInputSchema,
  AgentProfileResponseSchema,
  AgentProfileVersionResponseSchema,
  AgentProfileVersionsResponseSchema,
  AgentVersionQuerySchema,
  AgentProfileDraftResponseSchema,
  AgentMutationReceiptSchema,
  AgentIdentityUpdateReceiptSchema,
  UpdateAgentIdentityInputSchema,
  CreateAgentInputSchema,
  SaveAgentProfileDraftInputSchema,
  PublishAgentProfileInputSchema,
  CreateDepartmentSchema,
  DepartmentListResponseSchema,
  CreateProjectSchema,
  CreateTaskSchema,
  SetTaskProjectSchema,
  SetTaskExecutionAssignmentSchema,
  TaskSchema,
  UpdateProjectSchema,
  ArchiveProjectSchema,
  CreateMilestoneSchema,
  UpdateMilestoneSchema,
  MilestoneListQuerySchema,
  MilestoneSchema,
  MilestoneListResponseSchema,
  CreateEpicSchema,
  UpdateEpicSchema,
  ArchiveEpicSchema,
  EpicSchema,
  EpicListQuerySchema,
  EpicListResponseSchema,
  SetTaskEpicSchema,
  TaskEpicAssociationSchema,
  TaskEpicResponseSchema,
  ProjectEpicTaskPageSchema,
  ProjectListResponseSchema,
  ProjectWorkspaceQuerySchema,
  ProjectWorkspaceResponseSchema,
  RunEventSchema,
  MissionEventSchema,
  RunSchema,
  RunStatusSchema,
} from './index.ts';

describe('project epic management contracts', () => {
  const projectId = 'prj_0123456789abcdef0123456789abcdef';
  const epic = {
    id: 'epc_0123456789abcdef0123456789abcdef',
    projectId,
    title: 'Secure launch',
    description: null,
    status: 'planned',
    revision: 1,
    archivedAt: null,
    createdAt: '2026-11-06T00:00:00.000Z',
    updatedAt: '2026-11-06T00:00:00.000Z',
  } as const;

  it('validates strict bounded inputs, revision updates, and archive requests', () => {
    assert.equal(CreateEpicSchema.safeParse({ title: 'Secure launch' }).success, true);
    assert.equal(CreateEpicSchema.safeParse({ title: '  ' }).success, false);
    assert.equal(CreateEpicSchema.safeParse({ title: 'x'.repeat(121) }).success, false);
    assert.equal(CreateEpicSchema.safeParse({ title: 'Launch', taskId: 'tsk_1' }).success, false);
    assert.equal(
      UpdateEpicSchema.safeParse({ expectedRevision: 1, status: 'in_progress' }).success,
      true,
    );
    assert.equal(UpdateEpicSchema.safeParse({ expectedRevision: 1 }).success, false);
    assert.equal(
      UpdateEpicSchema.safeParse({ expectedRevision: 1, status: 'archived' }).success,
      false,
    );
    assert.equal(ArchiveEpicSchema.safeParse({ expectedRevision: 1 }).success, true);
    assert.equal(ArchiveEpicSchema.safeParse({ expectedRevision: 0 }).success, false);
  });

  it('validates Epic lifecycle shape and bounded complete pagination', () => {
    assert.equal(EpicSchema.safeParse(epic).success, true);
    assert.equal(EpicSchema.safeParse({ ...epic, status: 'archived' }).success, false);
    assert.deepEqual(EpicListQuerySchema.parse({ limit: '100' }), {
      limit: 100,
    });
    assert.equal(EpicListQuerySchema.safeParse({ limit: '101' }).success, false);
    assert.equal(EpicListQuerySchema.safeParse({ extra: true }).success, false);
    assert.equal(
      EpicListResponseSchema.safeParse({
        epics: [epic],
        page: { observedTotal: 1, complete: true, nextCursor: null },
      }).success,
      true,
    );
    assert.equal(
      EpicListResponseSchema.safeParse({
        epics: [epic],
        page: { observedTotal: 1, complete: false, nextCursor: null },
      }).success,
      false,
    );
  });
});

describe('Mission Lane event contract', () => {
  const base = {
    globalSequence: '1',
    eventId: '016c99e3-9d49-4b35-9730-fd9fa0023210',
    sourceKey: 'run:run-0001:1',
    sourceKind: 'run',
    sourceRecordId: 'evt-run-0001-0001',
    type: 'run.queued',
    actor: 'service:omnis-worker',
    origin: 'mock-worker',
    synthetic: true,
    taskId: 'task-0001',
    runId: 'run-0001',
    projectId: null,
    previousProjectId: null,
    occurredAt: '2026-11-09T12:00:00.000Z',
    payload: {},
  } as const;

  it('accepts strict synthetic Run events and rejects unsafe or inconsistent payloads', () => {
    assert.equal(MissionEventSchema.parse(base).globalSequence, '1');
    assert.equal(
      MissionEventSchema.safeParse({
        ...base,
        type: 'run.queued',
        actor: 'service:omnis-runtime',
        origin: 'api',
      }).success,
      false,
    );
    assert.equal(
      MissionEventSchema.safeParse({
        ...base,
        type: 'run.started',
        actor: 'service:omnis-runtime',
        origin: 'api',
      }).success,
      false,
    );
    assert.equal(MissionEventSchema.safeParse({ ...base, message: 'raw output' }).success, false);
    assert.equal(MissionEventSchema.safeParse({ ...base, synthetic: false }).success, false);
    assert.equal(
      MissionEventSchema.safeParse({
        ...base,
        type: 'run.provider_submission_requested',
      }).success,
      false,
    );
    assert.equal(
      MissionEventSchema.safeParse({ ...base, type: 'task.epic_assigned' }).success,
      false,
    );
    assert.equal(
      MissionEventSchema.safeParse({
        ...base,
        sourceKind: 'task',
        runId: null,
        type: 'task.status_changed',
        actor: 'service:omnis-runtime',
        origin: 'api',
        synthetic: true,
        payload: { from: 'open', to: 'in_progress', unexpected: 'value' },
      }).success,
      false,
    );
  });
});

describe('Epic-to-task association contracts', () => {
  const projectId = 'prj_0123456789abcdef0123456789abcdef';
  const epic = {
    id: 'epc_0123456789abcdef0123456789abcdef',
    projectId,
    title: 'Secure launch',
    description: null,
    status: 'archived',
    revision: 2,
    archivedAt: '2026-11-06T01:00:00.000Z',
    createdAt: '2026-11-06T00:00:00.000Z',
    updatedAt: '2026-11-06T01:00:00.000Z',
  } as const;

  it('validates assignment, unlink, and owner-facing Epic lookup shapes', () => {
    assert.equal(
      SetTaskEpicSchema.safeParse({
        expectedAssociationRevision: 1,
        epicId: epic.id,
      }).success,
      true,
    );
    assert.equal(
      SetTaskEpicSchema.safeParse({
        expectedAssociationRevision: 2,
        epicId: null,
      }).success,
      true,
    );
    assert.equal(
      SetTaskEpicSchema.safeParse({
        expectedAssociationRevision: 0,
        epicId: null,
      }).success,
      false,
    );
    assert.equal(
      SetTaskEpicSchema.safeParse({
        expectedAssociationRevision: 1,
        epicId: epic.id,
        extra: true,
      }).success,
      false,
    );
    assert.equal(
      TaskEpicAssociationSchema.safeParse({
        taskId: 'task-001',
        projectId,
        epicId: epic.id,
        associationRevision: 3,
      }).success,
      true,
    );
    assert.equal(
      TaskEpicResponseSchema.safeParse({
        taskId: 'task-001',
        projectId,
        epic,
        associationRevision: 3,
      }).success,
      true,
    );
    assert.equal(
      TaskEpicResponseSchema.safeParse({
        taskId: 'task-001',
        projectId: 'prj_ffffffffffffffffffffffffffffffff',
        epic,
        associationRevision: 3,
      }).success,
      false,
    );
  });

  it('uses the existing bounded complete task-page response for Epic listings', () => {
    assert.deepEqual(
      ProjectEpicTaskPageSchema.parse({
        tasks: [],
        page: { observedTotal: 0, complete: true, nextCursor: null },
      }),
      {
        tasks: [],
        page: { observedTotal: 0, complete: true, nextCursor: null },
      },
    );
    assert.equal(
      ProjectEpicTaskPageSchema.safeParse({
        tasks: [],
        page: { observedTotal: 1, complete: false, nextCursor: null },
      }).success,
      false,
    );
  });
});

describe('project workspace read contracts', () => {
  const project = {
    id: 'prj_0123456789abcdef0123456789abcdef',
    ownerId: 'owner',
    key: 'AO-105',
    name: 'Project workspace',
    objective: 'Read the project task workspace.',
    status: 'archived',
    priority: 'normal',
    revision: 2,
    createdAt: '2026-11-04T00:00:00.000Z',
    updatedAt: '2026-11-05T00:00:00.000Z',
  } as const;
  const task = {
    id: 'task-0001',
    title: 'Review project workspace',
    status: 'completed',
    createdAt: '2026-11-04T01:00:00.000Z',
    projectId: project.id,
    associationRevision: 1,
    latestRun: {
      id: 'run-0001',
      status: 'failed',
      createdAt: '2026-11-04T02:00:00.000Z',
      updatedAt: '2026-11-04T03:00:00.000Z',
    },
  } as const;

  it('validates strict bounded pagination and narrow task/run summaries', () => {
    assert.deepEqual(ProjectWorkspaceQuerySchema.parse({ limit: '100' }), {
      limit: 100,
    });
    assert.equal(ProjectWorkspaceQuerySchema.safeParse({ limit: '0' }).success, false);
    assert.equal(ProjectWorkspaceQuerySchema.safeParse({ limit: '101' }).success, false);
    assert.equal(ProjectWorkspaceQuerySchema.safeParse({ limit: '1.5' }).success, false);
    assert.equal(ProjectWorkspaceQuerySchema.safeParse({ unknown: 'value' }).success, false);
    assert.equal(
      ProjectWorkspaceResponseSchema.safeParse({
        project,
        tasks: [task],
        page: { observedTotal: 1, complete: true, nextCursor: null },
      }).success,
      true,
    );
    assert.equal(
      ProjectWorkspaceResponseSchema.safeParse({
        project,
        tasks: [{ ...task, latestRun: null, detail: 'must not be exposed' }],
        page: { observedTotal: 1, complete: true, nextCursor: null },
      }).success,
      false,
    );
    assert.equal(
      ProjectWorkspaceResponseSchema.safeParse({
        project,
        tasks: [task],
        page: { observedTotal: 1, complete: false, nextCursor: null },
      }).success,
      false,
    );
  });
});

describe('task project association contracts', () => {
  const task = {
    id: 'task-0001',
    title: 'Review a synthetic report',
    detail: 'Read the local report and summarize it.',
    status: 'open',
    createdAt: '2026-11-05T00:00:00.000Z',
  };
  const projectId = 'prj_0123456789abcdef0123456789abcdef';

  it('keeps legacy task payloads valid and represents unassigned association explicitly', () => {
    assert.equal(TaskSchema.parse(task).id, task.id);
    assert.deepEqual(TaskSchema.parse({ ...task, projectId: null, associationRevision: 1 }), {
      ...task,
      projectId: null,
      associationRevision: 1,
      agentId: null,
      profileVersion: null,
      runtimeId: null,
      assignmentRevision: 1,
    });
  });

  it('accepts optional project assignment on task creation and validates project reassignment', () => {
    assert.equal(CreateTaskSchema.parse({ ...task, projectId }).projectId, projectId);
    assert.equal(CreateTaskSchema.parse(task).projectId, undefined);
    assert.equal(
      SetTaskProjectSchema.safeParse({
        projectId,
        expectedAssociationRevision: 1,
      }).success,
      true,
    );
    assert.equal(
      SetTaskProjectSchema.safeParse({
        projectId: null,
        expectedAssociationRevision: 1,
      }).success,
      true,
    );
    assert.equal(
      SetTaskProjectSchema.safeParse({
        projectId: 'unknown',
        expectedAssociationRevision: 1,
      }).success,
      false,
    );
    assert.equal(
      SetTaskProjectSchema.safeParse({
        projectId,
        expectedAssociationRevision: 0,
      }).success,
      false,
    );
    assert.equal(
      SetTaskProjectSchema.safeParse({
        projectId,
        expectedAssociationRevision: 1,
        extra: true,
      }).success,
      false,
    );
  });

  it('accepts only a complete, explicitly synthetic task execution assignment', () => {
    const assigned = {
      agentId: 'agent-001',
      profileVersion: 2,
      runtimeId: 'mock',
      assignmentRevision: 3,
    };
    assert.deepEqual(TaskSchema.parse({ ...task, ...assigned }), {
      ...task,
      ...assigned,
    });
    assert.equal(
      TaskSchema.safeParse({ ...task, agentId: 'agent-001', profileVersion: 2 }).success,
      false,
    );
    assert.equal(TaskSchema.safeParse({ ...task, ...assigned, runtimeId: 'codex' }).success, false);
    assert.equal(
      SetTaskExecutionAssignmentSchema.safeParse({
        agentId: 'agent-001',
        profileVersion: 2,
        runtimeId: 'mock',
        expectedAssignmentRevision: 3,
      }).success,
      true,
    );
    assert.equal(
      SetTaskExecutionAssignmentSchema.safeParse({
        agentId: 'agent-001',
        profileVersion: 2,
        runtimeId: null,
        expectedAssignmentRevision: 3,
      }).success,
      false,
    );
    assert.equal(
      SetTaskExecutionAssignmentSchema.safeParse({
        agentId: null,
        profileVersion: null,
        runtimeId: null,
        expectedAssignmentRevision: 3,
        extra: 'rejected',
      }).success,
      false,
    );
  });
});

describe('run contracts', () => {
  it('accepts only events marked as synthetic mock activity', () => {
    const event = {
      id: 'evt-run-0001-0001',
      runId: 'run-0001',
      sequence: 1,
      at: '2026-11-02T00:00:00.000Z',
      type: 'run.queued',
      source: 'mock',
      synthetic: true,
      message: 'Queued.',
    };
    assert.equal(RunEventSchema.parse(event).synthetic, true);
    assert.equal(
      RunEventSchema.safeParse({ ...event, source: 'hermes', synthetic: false }).success,
      false,
    );
  });

  it('keeps unavailable usage unknown rather than presenting zero', () => {
    const run = {
      id: 'run-0001',
      taskId: 'task-0001',
      taskTitle: 'Read the file list',
      status: 'queued',
      runtimeKind: 'mock',
      synthetic: true,
      usage: {
        quality: 'unknown',
        inputTokens: null,
        outputTokens: null,
        cost: null,
      },
      createdAt: '2026-11-02T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
    };
    assert.equal(RunSchema.parse(run).usage.inputTokens, null);
    assert.equal(
      RunSchema.safeParse({
        ...run,
        usage: { quality: 'measured', inputTokens: 0 },
      }).success,
      false,
    );
  });

  it('carries a nullable authorization identity for linked Run audit history', () => {
    const run = {
      id: 'run-0001',
      taskId: 'task-0001',
      taskTitle: 'Read the file list',
      status: 'queued',
      runtimeKind: 'mock',
      synthetic: true,
      usage: {
        quality: 'unknown',
        inputTokens: null,
        outputTokens: null,
        cost: null,
      },
      createdAt: '2026-11-02T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
    };
    assert.equal(
      RunSchema.parse({
        ...run,
        authorizationId: 'b7cece2c-2e6f-4b3b-92da-f0352c24debb',
      }).authorizationId,
      'b7cece2c-2e6f-4b3b-92da-f0352c24debb',
    );
    assert.equal(RunSchema.parse({ ...run, authorizationId: null }).authorizationId, null);
    assert.equal(RunSchema.safeParse({ ...run, authorizationId: 'invalid' }).success, false);
  });

  it('represents interrupted execution explicitly and as synthetic mock evidence', () => {
    const event = RunEventSchema.parse({
      id: 'evt-run-0001-0004',
      runId: 'run-0001',
      sequence: 4,
      at: '2026-11-02T00:00:00.000Z',
      type: 'run.interrupted',
      source: 'mock',
      synthetic: true,
      message: 'The worker stopped before the run reached a terminal state.',
    });
    assert.equal(event.type, 'run.interrupted');
    assert.equal(RunStatusSchema.parse('interrupted'), 'interrupted');
  });

  it('distinguishes requested provider submission and uncertain outcomes from interruption', () => {
    const submission = RunEventSchema.parse({
      id: 'evt-run-0001-0003',
      runId: 'run-0001',
      sequence: 3,
      at: '2026-11-02T00:00:00.000Z',
      type: 'run.provider_submission_requested',
      source: 'mock',
      synthetic: true,
      message: 'Provider acceptance is not yet confirmed.',
    });
    const unknown = RunEventSchema.parse({
      ...submission,
      id: 'evt-run-0001-0004',
      sequence: 4,
      type: 'run.outcome_unknown',
      message: 'The provider outcome is unknown. Do not resubmit this request.',
    });
    assert.equal(submission.type, 'run.provider_submission_requested');
    assert.equal(unknown.type, 'run.outcome_unknown');
  });
});

describe('project management contracts', () => {
  const project = {
    id: 'prj_0123456789abcdef0123456789abcdef',
    ownerId: 'owner',
    key: 'OMNIS-OS',
    name: 'Omnis OS',
    objective: 'A synthetic project objective.',
    status: 'proposed',
    priority: 'normal',
    revision: 1,
    createdAt: '2026-11-04T00:00:00.000Z',
    updatedAt: '2026-11-04T00:00:00.000Z',
  };

  it('validates bounded owner-created project input and defaults priority', () => {
    assert.deepEqual(
      CreateProjectSchema.parse({
        key: 'OMNIS-OS',
        name: ' Omnis OS ',
        objective: ' Objective ',
      }),
      {
        key: 'OMNIS-OS',
        name: 'Omnis OS',
        objective: 'Objective',
        priority: 'normal',
      },
    );
    assert.equal(
      CreateProjectSchema.safeParse({
        key: 'bad key',
        name: 'x',
        objective: 'y',
      }).success,
      false,
    );
    assert.equal(
      CreateProjectSchema.safeParse({
        key: 'OK',
        name: 'x',
        objective: 'y',
        status: 'active',
      }).success,
      false,
    );
    assert.equal(
      CreateProjectSchema.safeParse({
        key: 'OK',
        name: 'x',
        objective: 'y',
        extra: true,
      }).success,
      false,
    );
    assert.equal(
      CreateProjectSchema.safeParse({
        key: 'OK',
        name: 'x\0y',
        objective: 'objective',
      }).success,
      false,
    );
  });

  it('requires list completeness, accurate totals, and stable unique project keys', () => {
    const summary = {
      id: project.id,
      ownerId: project.ownerId,
      key: project.key,
      name: project.name,
      status: project.status,
      priority: project.priority,
      revision: project.revision,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
    assert.equal(
      ProjectListResponseSchema.safeParse({
        projects: [summary],
        total: 1,
        complete: true,
      }).success,
      true,
    );
    assert.equal(
      ProjectListResponseSchema.safeParse({
        projects: [project],
        total: 1,
        complete: true,
      }).success,
      false,
    );
    assert.equal(
      ProjectListResponseSchema.safeParse({
        projects: [project],
        total: 2,
        complete: true,
      }).success,
      false,
    );
    assert.equal(
      ProjectListResponseSchema.safeParse({
        projects: [project],
        total: 1,
        complete: false,
      }).success,
      false,
    );
  });

  it('validates partial project updates with an expected revision', () => {
    assert.deepEqual(UpdateProjectSchema.parse({ expectedRevision: 3, name: ' New name ' }), {
      expectedRevision: 3,
      name: 'New name',
    });
    assert.equal(UpdateProjectSchema.safeParse({ expectedRevision: 1 }).success, false);
    assert.equal(
      UpdateProjectSchema.safeParse({ expectedRevision: 0, name: 'Name' }).success,
      false,
    );
    assert.equal(
      UpdateProjectSchema.safeParse({ expectedRevision: 1, key: 'NEW-KEY' }).success,
      false,
    );
    assert.equal(
      UpdateProjectSchema.safeParse({ expectedRevision: 1, name: '   ' }).success,
      false,
    );
    assert.equal(
      UpdateProjectSchema.safeParse({ expectedRevision: 1, objective: 'x\0y' }).success,
      false,
    );
    assert.equal(ArchiveProjectSchema.safeParse({ expectedRevision: 2 }).success, true);
    assert.equal(
      ArchiveProjectSchema.safeParse({ expectedRevision: 2, restore: true }).success,
      false,
    );
  });
});

describe('project milestone contracts', () => {
  const milestone = {
    id: 'mil_0123456789abcdef0123456789abcdef',
    projectId: 'prj_0123456789abcdef0123456789abcdef',
    title: 'Release candidate',
    description: null,
    status: 'planned',
    targetDate: '2027-02-28',
    revision: 1,
    archivedAt: null,
    createdAt: '2026-11-05T00:00:00.000Z',
    updatedAt: '2026-11-05T00:00:00.000Z',
  } as const;

  it('validates bounded milestone input, date-only targets, and expected revisions', () => {
    assert.deepEqual(CreateMilestoneSchema.parse({ title: '  Release candidate  ' }), {
      title: 'Release candidate',
    });
    assert.equal(CreateMilestoneSchema.safeParse({ title: 'x', unexpected: true }).success, false);
    assert.equal(CreateMilestoneSchema.safeParse({ title: '  ' }).success, false);
    assert.equal(
      CreateMilestoneSchema.safeParse({
        title: 'Review',
        targetDate: '2027-02-29',
      }).success,
      false,
    );
    assert.equal(
      CreateMilestoneSchema.safeParse({
        title: 'Review',
        targetDate: '0000-01-01',
      }).success,
      false,
    );
    assert.equal(
      UpdateMilestoneSchema.safeParse({ expectedRevision: 1, title: 'Updated' }).success,
      true,
    );
    assert.equal(UpdateMilestoneSchema.safeParse({ expectedRevision: 1 }).success, false);
    assert.equal(
      UpdateMilestoneSchema.safeParse({
        expectedRevision: 1,
        status: 'archived',
      }).success,
      false,
    );
  });

  it('validates milestone lifecycle response and bounded pagination contracts', () => {
    assert.equal(MilestoneSchema.safeParse(milestone).success, true);
    assert.equal(MilestoneSchema.safeParse({ ...milestone, status: 'archived' }).success, false);
    assert.deepEqual(MilestoneListQuerySchema.parse({ cursor: 'signed', limit: '20' }), {
      cursor: 'signed',
      limit: 20,
    });
    assert.equal(MilestoneListQuerySchema.safeParse({ limit: '101' }).success, false);
    assert.equal(
      MilestoneListResponseSchema.safeParse({
        milestones: [milestone],
        page: { observedTotal: 1, complete: true, nextCursor: null },
      }).success,
      true,
    );
  });
});

describe('agent profile read contracts', () => {
  const at = '2026-11-02T00:00:00.000Z';
  const agent = {
    id: 'agt_atlas',
    identityRevision: 1,
    name: 'Atlas',
    slug: 'atlas',
    department: {
      id: 'dep_engineering',
      slug: 'engineering',
      name: 'Engineering',
    },
    lifecycle: 'available',
    archivedAt: null,
    currentVersion: {
      versionNo: 2,
      profession: 'Systems Architect',
      seniority: 'senior',
    },
    provenance: 'owner_created',
    createdAt: at,
    updatedAt: at,
  };

  it('validates optimistic identity updates and strict, versioned receipts', () => {
    const input = {
      expectedIdentityRevision: 1,
      name: ' Atlas ',
      slug: 'atlas-next',
    };
    assert.deepEqual(UpdateAgentIdentityInputSchema.parse(input), {
      expectedIdentityRevision: 1,
      name: 'Atlas',
      slug: 'atlas-next',
    });
    assert.equal(
      UpdateAgentIdentityInputSchema.safeParse({ ...input, isOwner: true }).success,
      false,
    );
    assert.equal(
      UpdateAgentIdentityInputSchema.safeParse({ ...input, slug: 'Atlas' }).success,
      false,
    );
    assert.equal(
      AgentIdentityUpdateReceiptSchema.safeParse({
        requestId: '123e4567-e89b-12d3-a456-426614174000',
        operation: 'agent.identity_updated',
        agentId: 'agt_atlas',
        name: 'Atlas',
        slug: 'atlas-next',
        identityRevision: 2,
        updatedAt: at,
      }).success,
      true,
    );
  });
  const createdBy = { id: 'owner', displayName: 'Director' };
  const version = {
    versionId: 'apv_atlas_2',
    agentId: agent.id,
    versionNo: 2,
    profession: 'Systems Architect',
    seniority: 'senior',
    specialties: ['system-design'],
    personality: {
      traits: ['methodical'],
      tone: 'professional',
      principles: ['explain tradeoffs'],
    },
    behavior: { autonomy: null, escalation: 'request director review' },
    instructions: 'Use clear, evidence-based reasoning.',
    createdBy,
    createdAt: at,
  };

  it('represents an honestly empty, complete directory and validates bounded complete lists', () => {
    const empty = AgentDirectoryResponseSchema.parse({
      agents: [],
      page: { total: 0, complete: true, nextCursor: null },
    });
    assert.equal(empty.page.total, 0);
    assert.equal(
      AgentDirectoryResponseSchema.safeParse({
        agents: [agent],
        page: { total: 2, complete: true, nextCursor: null },
      }).success,
      false,
    );
    assert.equal(
      AgentDirectoryResponseSchema.safeParse({
        agents: [agent],
        page: { total: 1, complete: false, nextCursor: 'next' },
      }).success,
      false,
    );
  });

  it('keeps lifecycle separate from activity and ties draft state to no published version', () => {
    assert.equal(
      AgentDirectoryResponseSchema.safeParse({
        agents: [{ ...agent, lifecycle: 'busy' }],
        page: { total: 1, complete: true, nextCursor: null },
      }).success,
      false,
    );
    assert.equal(
      AgentDirectoryResponseSchema.safeParse({
        agents: [{ ...agent, lifecycle: 'draft', currentVersion: null }],
        page: { total: 1, complete: true, nextCursor: null },
      }).success,
      true,
    );
    assert.equal(
      AgentDirectoryResponseSchema.safeParse({
        agents: [{ ...agent, lifecycle: 'archived', archivedAt: null }],
        page: { total: 1, complete: true, nextCursor: null },
      }).success,
      false,
    );
  });

  it('validates immutable snapshot shape and exact version identity', () => {
    assert.equal(
      AgentProfileVersionResponseSchema.safeParse({
        agent,
        version,
        isCurrent: true,
      }).success,
      true,
    );
    assert.equal(
      AgentProfileVersionResponseSchema.safeParse({
        agent,
        version: { ...version, agentId: 'agt_other' },
        isCurrent: true,
      }).success,
      false,
    );
    assert.equal(
      AgentProfileVersionResponseSchema.safeParse({
        agent,
        version: { ...version, versionNo: 1 },
        isCurrent: true,
      }).success,
      false,
    );
    assert.equal(
      AgentProfileVersionResponseSchema.safeParse({
        agent,
        version: { ...version, instructions: 'x'.repeat(16_385) },
        isCurrent: true,
      }).success,
      false,
    );
  });

  it('validates current-version consistency and descending version pages', () => {
    assert.equal(
      AgentProfileResponseSchema.safeParse({ agent, currentVersion: version }).success,
      true,
    );
    assert.equal(
      AgentProfileResponseSchema.safeParse({
        agent,
        currentVersion: { ...version, versionNo: 1 },
      }).success,
      false,
    );
    const versionSummary = {
      versionId: version.versionId,
      versionNo: 2,
      profession: version.profession,
      seniority: version.seniority,
      createdAt: at,
      createdBy,
      isCurrent: true,
    };
    assert.equal(
      AgentProfileVersionsResponseSchema.safeParse({
        agent,
        versions: [versionSummary],
        page: { total: 2, complete: false, nextCursor: 'cursor-1' },
      }).success,
      true,
    );
    assert.equal(
      AgentProfileVersionsResponseSchema.safeParse({
        agent,
        versions: [versionSummary, { ...versionSummary, versionNo: 3 }],
        page: { total: 2, complete: true, nextCursor: null },
      }).success,
      false,
    );
    assert.equal(
      AgentProfileVersionsResponseSchema.safeParse({
        agent,
        versions: [{ ...versionSummary, isCurrent: false }],
        page: { total: 2, complete: false, nextCursor: 'cursor-1' },
      }).success,
      false,
    );
  });

  it('accepts only bounded canonical version pagination parameters', () => {
    assert.deepEqual(AgentVersionQuerySchema.parse({ limit: '50' }), {
      limit: 50,
    });
    assert.deepEqual(AgentVersionQuerySchema.parse({ cursor: 'opaque_cursor', limit: '10' }), {
      cursor: 'opaque_cursor',
      limit: 10,
    });
    assert.deepEqual(AgentVersionQuerySchema.parse({ limit: '1' }), {
      limit: 1,
    });
    assert.deepEqual(AgentVersionQuerySchema.parse({ limit: '100' }), {
      limit: 100,
    });
    for (const query of [{ limit: '0' }, { limit: '01' }, { limit: '101' }, { other: 'x' }]) {
      assert.equal(AgentVersionQuerySchema.safeParse(query).success, false);
    }
  });
});

describe('AO-104 management input contracts', () => {
  const profileInput = {
    profession: 'Systems Analyst',
    seniority: null,
    specialties: [],
    personality: { traits: [], tone: null, principles: [] },
    behavior: { autonomy: null, escalation: null },
    instructions: 'Use verified evidence.',
  };

  it('validates owner-managed agent creation and expected profile revisions', () => {
    assert.deepEqual(
      CreateAgentInputSchema.parse({
        name: 'Atlas',
        slug: 'atlas',
        departmentId: null,
      }),
      { name: 'Atlas', slug: 'atlas', departmentId: null },
    );
    assert.equal(
      CreateAgentInputSchema.safeParse({
        name: 'Atlas',
        slug: 'Atlas',
        departmentId: null,
      }).success,
      false,
    );
    assert.equal(
      SaveAgentProfileDraftInputSchema.safeParse({
        expectedDraftRevision: 0,
        baseVersionNo: null,
        profile: profileInput,
      }).success,
      true,
    );
    assert.equal(
      SaveAgentProfileDraftInputSchema.safeParse({
        expectedDraftRevision: Number.MAX_SAFE_INTEGER,
        baseVersionNo: null,
        profile: profileInput,
      }).success,
      false,
    );
    assert.equal(
      PublishAgentProfileInputSchema.safeParse({
        expectedVersionNo: null,
        expectedDraftRevision: 1,
      }).success,
      true,
    );
    assert.equal(
      PublishAgentProfileInputSchema.safeParse({
        expectedVersionNo: 0,
        expectedDraftRevision: 1,
      }).success,
      false,
    );
  });

  it('represents resumable empty and populated profile drafts with safe revision counters', () => {
    const base = {
      agentId: 'agt_atlas',
      draftRevision: 0,
      baseVersionNo: null,
    };
    assert.equal(
      AgentProfileDraftResponseSchema.safeParse({
        ...base,
        profile: null,
        updatedAt: null,
      }).success,
      true,
    );
    assert.equal(
      AgentProfileDraftResponseSchema.safeParse({
        ...base,
        draftRevision: 1,
        profile: profileInput,
        updatedAt: '2026-11-04T00:00:00.000Z',
      }).success,
      true,
    );
    assert.equal(
      AgentProfileDraftResponseSchema.safeParse({
        ...base,
        draftRevision: 1.5,
        profile: profileInput,
        updatedAt: '2026-11-04T00:00:00.000Z',
      }).success,
      false,
    );
    assert.equal(
      AgentProfileDraftResponseSchema.safeParse({
        ...base,
        profile: null,
        updatedAt: '2026-11-04T00:00:00.000Z',
      }).success,
      false,
    );
  });

  it('accepts only stable metadata in mutation receipts', () => {
    const receipt = {
      requestId: '123e4567-e89b-42d3-a456-426614174000',
      operation: 'profile.published',
      agentId: 'agt_atlas',
      lifecycle: 'available',
      versionId: 'apv_atlas_1',
      versionNo: 1,
      draftRevision: 1,
      occurredAt: '2026-11-04T00:00:00.000Z',
    };
    assert.equal(AgentMutationReceiptSchema.safeParse(receipt).success, true);
    assert.equal(
      AgentMutationReceiptSchema.safeParse({
        ...receipt,
        instructions: 'must not be echoed',
      }).success,
      false,
    );
  });

  it('bounds every profile field and retains the existing 16 KiB instruction limit', () => {
    const profile = {
      profession: 'Systems Analyst',
      seniority: null,
      specialties: [],
      personality: { traits: [], tone: null, principles: [] },
      behavior: { autonomy: null, escalation: null },
      instructions: 'x'.repeat(16_384),
    };
    assert.equal(AgentProfileWriteInputSchema.safeParse(profile).success, true);
    assert.equal(
      AgentProfileWriteInputSchema.safeParse({
        ...profile,
        instructions: 'x'.repeat(16_385),
      }).success,
      false,
    );
    assert.equal(
      AgentProfileWriteInputSchema.safeParse({ ...profile, extra: 'ignored?' }).success,
      false,
    );
  });

  it('rejects malformed department input and requires complete directory metadata', () => {
    assert.equal(
      CreateDepartmentSchema.safeParse({
        slug: 'Engineering',
        name: 'Engineering',
      }).success,
      false,
    );
    assert.equal(
      CreateDepartmentSchema.safeParse({
        slug: 'engineering',
        name: ' Engineering ',
      }).success,
      true,
    );
    assert.equal(
      DepartmentListResponseSchema.safeParse({ departments: [], total: 0 }).success,
      true,
    );
    assert.equal(
      DepartmentListResponseSchema.safeParse({ departments: [], total: 1 }).success,
      false,
    );
  });
});
