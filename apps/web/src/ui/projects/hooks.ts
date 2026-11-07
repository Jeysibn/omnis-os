import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Project,
  ProjectListResponse,
  ProjectWorkspacePage,
  ProjectWorkspaceTaskSummary,
} from '@omnis/contracts';
import { ApiRequestError } from '../api.js';
import {
  classifyReadError,
  fetchProject,
  fetchProjects,
  fetchProjectTasks,
  type ReadFailure,
} from './data.js';

export type Loaded<T> =
  { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; error: ReadFailure };

type Keyed<T> = { key: string; value: Loaded<T> };

/**
 * One keyed read with abort, race protection and reload. State is stored with the key it was read
 * for, so a response for a previous key can never be shown for the current one.
 */
function useKeyedRead<T>(
  key: string,
  enabled: boolean,
  read: (signal: AbortSignal) => Promise<T>,
  onUnauthorized: (cause: unknown) => void,
) {
  const [state, setState] = useState<Keyed<T>>({ key, value: { status: 'loading' } });
  const [attempt, setAttempt] = useState(0);
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;
  const readRef = useRef(read);
  readRef.current = read;

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    setState({ key, value: { status: 'loading' } });
    readRef
      .current(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ key, value: { status: 'ready', data } });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const error = classifyReadError(cause, (value) => unauthorizedRef.current(value));
        if (error) setState({ key, value: { status: 'error', error } });
      });
    return () => controller.abort();
  }, [key, enabled, attempt]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  const replace = useCallback(
    (data: T) => setState((current) => ({ ...current, value: { status: 'ready', data } })),
    [],
  );
  const value: Loaded<T> = state.key === key ? state.value : { status: 'loading' };
  return { value, reload, replace };
}

export const useProjectList = (enabled: boolean, onUnauthorized: (cause: unknown) => void) =>
  useKeyedRead<ProjectListResponse>(
    'list',
    enabled,
    (signal) => fetchProjects(signal),
    onUnauthorized,
  );

export const useProject = (
  projectId: string,
  enabled: boolean,
  onUnauthorized: (cause: unknown) => void,
) =>
  useKeyedRead<Project>(
    projectId,
    enabled,
    (signal) => fetchProject(projectId, signal),
    onUnauthorized,
  );

export type TaskListState = {
  /** First-page read. A failure here replaces the list. */
  first: Loaded<null>;
  tasks: ProjectWorkspaceTaskSummary[];
  /** The page object of the most recently read page. Not a project-wide count when incomplete. */
  page: ProjectWorkspacePage | null;
  loadingMore: boolean;
  /** A failure reading a later page keeps the tasks already shown. */
  moreError: { kind: 'cursor' } | { kind: 'failure'; message: string } | null;
};

const initialTasks: TaskListState = {
  first: { status: 'loading' },
  tasks: [],
  page: null,
  loadingMore: false,
  moreError: null,
};

/** Cursor-paged task summaries for one project. Never invents a total: see `page`. */
export function useProjectTasks(
  projectId: string,
  enabled: boolean,
  onUnauthorized: (cause: unknown) => void,
) {
  const [state, setState] = useState<{ key: string; value: TaskListState }>({
    key: projectId,
    value: initialTasks,
  });
  const [attempt, setAttempt] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const loadingMore = useRef(false);
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;
  const current = state.key === projectId ? state.value : initialTasks;
  const currentRef = useRef(current);
  currentRef.current = current;

  useEffect(() => {
    if (!enabled) return undefined;
    const abort = new AbortController();
    controller.current = abort;
    loadingMore.current = false;
    setState({ key: projectId, value: initialTasks });
    fetchProjectTasks(projectId, null, abort.signal)
      .then((response) => {
        if (abort.signal.aborted) return;
        setState({
          key: projectId,
          value: {
            ...initialTasks,
            first: { status: 'ready', data: null },
            tasks: response.tasks,
            page: response.page,
          },
        });
      })
      .catch((cause: unknown) => {
        if (abort.signal.aborted) return;
        const error = classifyReadError(cause, (value) => unauthorizedRef.current(value));
        if (error)
          setState({
            key: projectId,
            value: { ...initialTasks, first: { status: 'error', error } },
          });
      });
    return () => abort.abort();
  }, [projectId, enabled, attempt]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  const loadMore = useCallback(() => {
    const snapshot = currentRef.current;
    const cursor = snapshot.page?.nextCursor;
    const abort = controller.current;
    if (!cursor || loadingMore.current || !abort || abort.signal.aborted) return;
    loadingMore.current = true;
    setState((existing) => ({
      ...existing,
      value: { ...existing.value, loadingMore: true, moreError: null },
    }));
    fetchProjectTasks(projectId, cursor, abort.signal)
      .then((response) => {
        if (abort.signal.aborted) return;
        loadingMore.current = false;
        setState((existing) => {
          // A task moved between requests can appear twice; keep the first copy only.
          const seen = new Set(existing.value.tasks.map((task) => task.id));
          const added = response.tasks.filter((task) => !seen.has(task.id));
          return {
            key: existing.key,
            value: {
              ...existing.value,
              tasks: [...existing.value.tasks, ...added],
              page: response.page,
              loadingMore: false,
            },
          };
        });
      })
      .catch((cause: unknown) => {
        if (abort.signal.aborted) return;
        loadingMore.current = false;
        let moreError: TaskListState['moreError'] = {
          kind: 'failure',
          message: cause instanceof ApiRequestError ? cause.message : 'Loading more tasks failed.',
        };
        if (cause instanceof ApiRequestError) {
          if (cause.status === 401) {
            unauthorizedRef.current(cause);
            return;
          }
          if (cause.code === 'invalid_cursor') moreError = { kind: 'cursor' };
        }
        setState((existing) => ({
          ...existing,
          value: { ...existing.value, loadingMore: false, moreError },
        }));
      });
  }, [projectId]);

  return { state: current, reload, loadMore };
}
