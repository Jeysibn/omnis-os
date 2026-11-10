import type { ProjectWorkspacePage, ProjectWorkspaceTaskSummary } from '@omnis/contracts';

export type TaskStatus = ProjectWorkspaceTaskSummary['status'];
export const taskStatuses: readonly TaskStatus[] = ['open', 'in_progress', 'completed'];

export type TaskSummary = {
  counts: Record<TaskStatus, number>;
  loaded: number;
  /** The number the API observed when it read the last page. */
  observed: number;
  /** Every page has been read. */
  complete: boolean;
  /** The counts may not describe every task: not all pages are loaded, or the set moved. */
  partial: boolean;
  text: string;
};

/**
 * Counts by status from the tasks actually loaded. The API reports no per-status totals, so these
 * counts are never presented as the epic's totals unless every page was read and the number
 * loaded matches the number the API observed.
 */
export function summariseTasks(
  tasks: readonly Pick<ProjectWorkspaceTaskSummary, 'status'>[],
  page: Pick<ProjectWorkspacePage, 'observedTotal' | 'complete'> | null,
): TaskSummary {
  const counts: Record<TaskStatus, number> = { open: 0, in_progress: 0, completed: 0 };
  for (const task of tasks) counts[task.status] += 1;
  const loaded = tasks.length;
  const observed = page?.observedTotal ?? loaded;
  const complete = page?.complete ?? false;
  const partial = !complete || loaded !== observed;
  const noun = (n: number) => `${n} ${n === 1 ? 'task' : 'tasks'}`;
  let text: string;
  if (!complete)
    text = `Counts cover the ${noun(loaded)} loaded so far; ${observed} were observed. Load more to count the rest.`;
  else if (loaded !== observed)
    text = `Counts cover ${noun(loaded)}; ${observed} were observed when the last page was read, so this may be out of date.`;
  else text = loaded === 0 ? 'No tasks.' : `All ${noun(loaded)} loaded.`;
  return { counts, loaded, observed, complete, partial, text };
}
