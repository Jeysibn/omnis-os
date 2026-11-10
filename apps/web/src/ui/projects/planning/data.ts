import {
  EpicListResponseSchema,
  EpicSchema,
  MilestoneListResponseSchema,
  MilestoneSchema,
  ProjectEpicTaskPageSchema,
  TaskEpicAssociationSchema,
  TaskEpicResponseSchema,
  type CreateEpicInput,
  type CreateMilestoneInput,
  type Epic,
  type Milestone,
  type ProjectEpicTaskPage,
  type TaskEpicAssociation,
  type TaskEpicResponse,
  type UpdateEpicInput,
  type UpdateMilestoneInput,
} from '@omnis/contracts';
import { request } from '../../api.js';

/**
 * Epics, milestones and the task-to-epic association, over the merged owner API. Every response is
 * parsed with the strict contract schema and then checked against the request, so a body for a
 * different project, epic or task is never shown as the answer.
 */
export const PLANNING_PAGE_SIZE = 50;

const mustMatch = (ok: boolean): void => {
  if (!ok) throw new Error('Response does not match the request.');
};
const unique = (ids: readonly string[]) => new Set(ids).size === ids.length;
const mutationHeaders = (csrfToken: string, idempotencyKey: string) => ({
  'x-omnis-csrf': csrfToken,
  'idempotency-key': idempotencyKey,
});
const pageQuery = (cursor: string | null) => {
  const params = new URLSearchParams({ limit: String(PLANNING_PAGE_SIZE) });
  if (cursor) params.set('cursor', cursor);
  return params.toString();
};
const enc = encodeURIComponent;

/* ---------------------------------- epics ---------------------------------- */

export const fetchEpics = (projectId: string, cursor: string | null, signal?: AbortSignal) =>
  request(
    `/api/v1/projects/${enc(projectId)}/epics?${pageQuery(cursor)}`,
    signal ? { signal } : {},
    (value) => {
      const result = EpicListResponseSchema.parse(value);
      mustMatch(
        result.epics.every((epic) => epic.projectId === projectId) &&
          unique(result.epics.map((epic) => epic.id)),
      );
      return result;
    },
  );

export const fetchEpic = (projectId: string, epicId: string, signal?: AbortSignal) =>
  request(
    `/api/v1/projects/${enc(projectId)}/epics/${enc(epicId)}`,
    signal ? { signal } : {},
    (value) => {
      const epic = EpicSchema.parse(value);
      mustMatch(epic.id === epicId && epic.projectId === projectId);
      return epic;
    },
  );

export const createEpic = (
  projectId: string,
  input: CreateEpicInput,
  key: string,
  csrfToken: string,
) =>
  request(
    `/api/v1/projects/${enc(projectId)}/epics`,
    { method: 'POST', headers: mutationHeaders(csrfToken, key), body: JSON.stringify(input) },
    (value) => {
      const epic = EpicSchema.parse(value);
      mustMatch(
        epic.projectId === projectId &&
          epic.title === input.title &&
          epic.description === (input.description ?? null) &&
          epic.status === 'planned',
      );
      return epic;
    },
  );

export const updateEpic = (
  projectId: string,
  epicId: string,
  edit: UpdateEpicInput,
  key: string,
  csrfToken: string,
) =>
  request(
    `/api/v1/projects/${enc(projectId)}/epics/${enc(epicId)}`,
    { method: 'PATCH', headers: mutationHeaders(csrfToken, key), body: JSON.stringify(edit) },
    (value) => {
      const epic = EpicSchema.parse(value);
      mustMatch(
        epic.id === epicId &&
          epic.projectId === projectId &&
          epic.revision === edit.expectedRevision + 1 &&
          (edit.title === undefined || epic.title === edit.title) &&
          (edit.description === undefined || epic.description === edit.description) &&
          (edit.status === undefined || epic.status === edit.status),
      );
      return epic;
    },
  );

export const archiveEpic = (
  projectId: string,
  epicId: string,
  expectedRevision: number,
  key: string,
  csrfToken: string,
) =>
  request(
    `/api/v1/projects/${enc(projectId)}/epics/${enc(epicId)}/archive`,
    {
      method: 'POST',
      headers: mutationHeaders(csrfToken, key),
      body: JSON.stringify({ expectedRevision }),
    },
    (value) => {
      const epic = EpicSchema.parse(value);
      mustMatch(
        epic.id === epicId &&
          epic.projectId === projectId &&
          epic.status === 'archived' &&
          epic.revision === expectedRevision + 1,
      );
      return epic;
    },
  );

export const fetchEpicTasks = (
  projectId: string,
  epicId: string,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<ProjectEpicTaskPage> =>
  request(
    `/api/v1/projects/${enc(projectId)}/epics/${enc(epicId)}/tasks?${pageQuery(cursor)}`,
    signal ? { signal } : {},
    (value) => {
      const page = ProjectEpicTaskPageSchema.parse(value);
      mustMatch(
        page.tasks.every((task) => task.projectId === projectId) &&
          unique(page.tasks.map((task) => task.id)),
      );
      return page;
    },
  );

/* -------------------------------- milestones -------------------------------- */

export const fetchMilestones = (projectId: string, cursor: string | null, signal?: AbortSignal) =>
  request(
    `/api/v1/projects/${enc(projectId)}/milestones?${pageQuery(cursor)}`,
    signal ? { signal } : {},
    (value) => {
      const result = MilestoneListResponseSchema.parse(value);
      mustMatch(
        result.milestones.every((milestone) => milestone.projectId === projectId) &&
          unique(result.milestones.map((milestone) => milestone.id)),
      );
      return result;
    },
  );

export const fetchMilestone = (projectId: string, milestoneId: string, signal?: AbortSignal) =>
  request(
    `/api/v1/projects/${enc(projectId)}/milestones/${enc(milestoneId)}`,
    signal ? { signal } : {},
    (value) => {
      const milestone = MilestoneSchema.parse(value);
      mustMatch(milestone.id === milestoneId && milestone.projectId === projectId);
      return milestone;
    },
  );

export const createMilestone = (
  projectId: string,
  input: CreateMilestoneInput,
  key: string,
  csrfToken: string,
) =>
  request(
    `/api/v1/projects/${enc(projectId)}/milestones`,
    { method: 'POST', headers: mutationHeaders(csrfToken, key), body: JSON.stringify(input) },
    (value) => {
      const milestone = MilestoneSchema.parse(value);
      mustMatch(
        milestone.projectId === projectId &&
          milestone.title === input.title &&
          milestone.description === (input.description ?? null) &&
          milestone.targetDate === (input.targetDate ?? null) &&
          milestone.status === 'planned',
      );
      return milestone;
    },
  );

export const updateMilestone = (
  projectId: string,
  milestoneId: string,
  edit: UpdateMilestoneInput,
  key: string,
  csrfToken: string,
) =>
  request(
    `/api/v1/projects/${enc(projectId)}/milestones/${enc(milestoneId)}`,
    { method: 'PATCH', headers: mutationHeaders(csrfToken, key), body: JSON.stringify(edit) },
    (value) => {
      const milestone = MilestoneSchema.parse(value);
      mustMatch(
        milestone.id === milestoneId &&
          milestone.projectId === projectId &&
          milestone.revision === edit.expectedRevision + 1 &&
          (edit.title === undefined || milestone.title === edit.title) &&
          (edit.description === undefined || milestone.description === edit.description) &&
          (edit.targetDate === undefined || milestone.targetDate === edit.targetDate) &&
          (edit.status === undefined || milestone.status === edit.status),
      );
      return milestone;
    },
  );

export const archiveMilestone = (
  projectId: string,
  milestoneId: string,
  expectedRevision: number,
  key: string,
  csrfToken: string,
) =>
  request(
    `/api/v1/projects/${enc(projectId)}/milestones/${enc(milestoneId)}/archive`,
    {
      method: 'POST',
      headers: mutationHeaders(csrfToken, key),
      body: JSON.stringify({ expectedRevision }),
    },
    (value) => {
      const milestone = MilestoneSchema.parse(value);
      mustMatch(
        milestone.id === milestoneId &&
          milestone.projectId === projectId &&
          milestone.status === 'archived' &&
          milestone.revision === expectedRevision + 1,
      );
      return milestone;
    },
  );

/* ------------------------------ task <-> epic ------------------------------ */

export const fetchTaskEpic = (taskId: string, signal?: AbortSignal): Promise<TaskEpicResponse> =>
  request(`/api/v1/tasks/${enc(taskId)}/epic`, signal ? { signal } : {}, (value) => {
    const response = TaskEpicResponseSchema.parse(value);
    mustMatch(response.taskId === taskId);
    return response;
  });

export const setTaskEpic = (
  taskId: string,
  expectedAssociationRevision: number,
  epicId: string | null,
  key: string,
  csrfToken: string,
): Promise<TaskEpicAssociation> =>
  request(
    `/api/v1/tasks/${enc(taskId)}/epic`,
    {
      method: 'PUT',
      headers: mutationHeaders(csrfToken, key),
      body: JSON.stringify({ expectedAssociationRevision, epicId }),
    },
    (value) => {
      const association = TaskEpicAssociationSchema.parse(value);
      mustMatch(
        association.taskId === taskId &&
          association.epicId === epicId &&
          association.associationRevision >= expectedAssociationRevision,
      );
      return association;
    },
  );

export type { Epic, Milestone };
