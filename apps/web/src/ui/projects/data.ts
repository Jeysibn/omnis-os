import {
  ProjectListResponseSchema,
  ProjectSchema,
  ProjectWorkspaceResponseSchema,
  type CreateProjectInput,
  type Project,
  type ProjectListResponse,
  type ProjectWorkspaceResponse,
} from '@omnis/contracts';
import { ApiRequestError, request } from '../api.js';

/** The strict schema plus the integrity rule that ids are unique. */
export function parseProjectList(value: unknown): ProjectListResponse {
  const result = ProjectListResponseSchema.parse(value);
  if (new Set(result.projects.map((item) => item.id)).size !== result.projects.length)
    throw new Error('Duplicate project id.');
  return result;
}

export const fetchProjects = (signal?: AbortSignal) =>
  request('/api/v1/projects', signal ? { signal } : {}, parseProjectList);

export const fetchProject = (id: string, signal?: AbortSignal) =>
  request(`/api/v1/projects/${encodeURIComponent(id)}`, signal ? { signal } : {}, (value) => {
    const project = ProjectSchema.parse(value);
    if (project.id !== id) throw new Error('Response does not match the request.');
    return project;
  });

export const PAGE_SIZE = 25;

/**
 * One page of project task summaries. The route also returns the project, which this screen
 * does not use: the dedicated project read stays the source of the project's own state.
 * Task detail is not read here; no task-detail endpoint exists.
 */
export const fetchProjectTasks = (
  id: string,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<ProjectWorkspaceResponse> => {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor) params.set('cursor', cursor);
  return request(
    `/api/v1/projects/${encodeURIComponent(id)}/tasks?${params.toString()}`,
    signal ? { signal } : {},
    (value) => {
      const page = ProjectWorkspaceResponseSchema.parse(value);
      if (page.project.id !== id || page.tasks.some((task) => task.projectId !== id))
        throw new Error('Response does not match the request.');
      return page;
    },
  );
};

function mustMatch(ok: boolean): void {
  if (!ok) throw new Error('Response does not match the request.');
}

function mutationHeaders(csrfToken: string, idempotencyKey: string) {
  return { 'x-omnis-csrf': csrfToken, 'idempotency-key': idempotencyKey };
}

/** A 2xx is only confirmation when the body is a valid Project that matches the request. */
export const createProject = (input: CreateProjectInput, key: string, csrfToken: string) =>
  request(
    '/api/v1/projects',
    { method: 'POST', headers: mutationHeaders(csrfToken, key), body: JSON.stringify(input) },
    (value) => {
      const project = ProjectSchema.parse(value);
      mustMatch(
        project.key === input.key &&
          project.name === input.name &&
          project.objective === input.objective &&
          project.priority === input.priority,
      );
      return project;
    },
  );

export type ProjectEdit = {
  expectedRevision: number;
  name?: string;
  objective?: string;
  priority?: Project['priority'];
};

export const updateProject = (id: string, edit: ProjectEdit, key: string, csrfToken: string) =>
  request(
    `/api/v1/projects/${encodeURIComponent(id)}`,
    { method: 'PATCH', headers: mutationHeaders(csrfToken, key), body: JSON.stringify(edit) },
    (value) => {
      const project = ProjectSchema.parse(value);
      mustMatch(
        project.id === id &&
          project.revision === edit.expectedRevision + 1 &&
          (edit.name === undefined || project.name === edit.name) &&
          (edit.objective === undefined || project.objective === edit.objective) &&
          (edit.priority === undefined || project.priority === edit.priority),
      );
      return project;
    },
  );

export const archiveProject = (
  id: string,
  expectedRevision: number,
  key: string,
  csrfToken: string,
) =>
  request(
    `/api/v1/projects/${encodeURIComponent(id)}/archive`,
    {
      method: 'POST',
      headers: mutationHeaders(csrfToken, key),
      body: JSON.stringify({ expectedRevision }),
    },
    (value) => {
      const project = ProjectSchema.parse(value);
      mustMatch(
        project.id === id &&
          project.status === 'archived' &&
          project.revision === expectedRevision + 1,
      );
      return project;
    },
  );

export type ReadFailure =
  | { kind: 'notFound' }
  | { kind: 'forbidden' }
  | { kind: 'unexpected' }
  | { kind: 'limit' }
  | { kind: 'failure'; message: string };

/** Maps a failed read to a UI state. Returns null for 401, which the shell handles. */
export function classifyReadError(
  cause: unknown,
  onUnauthorized: (cause: unknown) => void,
): ReadFailure | null {
  if (!(cause instanceof ApiRequestError)) return { kind: 'failure', message: 'Loading failed.' };
  if (cause.status === 401) {
    onUnauthorized(cause);
    return null;
  }
  if (cause.status === 404) return { kind: 'notFound' };
  if (cause.status === 403) return { kind: 'forbidden' };
  // 422 means this UI sent a query the API refused: a contract problem, not user error.
  if (cause.outcome === 'invalid-response' || cause.status === 422) return { kind: 'unexpected' };
  if (cause.status === 503 && cause.code === 'limit') return { kind: 'limit' };
  return { kind: 'failure', message: cause.message };
}

export type MutationFailure =
  | { evidence: 'unauthorized' }
  | { evidence: 'rejected'; status: 403 | 404 | 409 | 422 | 503; code: string }
  | { evidence: 'unknown' };

/**
 * Evidence level of a failed mutation. Only a definitive response with a valid error envelope is
 * a rejection. The project store refuses a full directory with 503 `limit` before writing, so that
 * one 503 is definitive; every other 5xx, network failure or unverifiable body leaves the
 * outcome unknown.
 */
export function classifyMutationFailure(cause: unknown): MutationFailure {
  if (!(cause instanceof ApiRequestError)) return { evidence: 'unknown' };
  if (cause.status === 401) return { evidence: 'unauthorized' };
  if (cause.code === 'http_error' || cause.code === 'invalid_response')
    return { evidence: 'unknown' };
  if (
    cause.status === 403 ||
    cause.status === 404 ||
    cause.status === 409 ||
    cause.status === 422 ||
    (cause.status === 503 && cause.code === 'limit')
  )
    return { evidence: 'rejected', status: cause.status, code: cause.code };
  return { evidence: 'unknown' };
}
