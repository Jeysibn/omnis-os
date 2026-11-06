import type { Project, ProjectListResponse } from '@omnis/contracts';
import type { MessageKey, MessageParams } from './messages.js';

/** What the owner asked for. Values are already trimmed and schema-valid. */
export type Op =
  | { kind: 'create'; key: string; name: string; objective: string; priority: Project['priority'] }
  | {
      kind: 'edit';
      id: string;
      expectedRevision: number;
      changes: { name?: string; objective?: string; priority?: Project['priority'] };
    }
  | { kind: 'archive'; id: string; expectedRevision: number };

export type RecoveryAction =
  'checkAgain' | 'tryAgain' | 'editValues' | 'openProject' | 'loadLatest' | 'keepEdits' | 'close';

/** What one read-only recheck showed. `failed` covers a failed or unverifiable read. */
export type Observation =
  | { kind: 'failed' }
  | { kind: 'absent' }
  | { kind: 'list'; list: ProjectListResponse }
  | { kind: 'project'; project: Project };

export type Conclusion = {
  message: { key: MessageKey; params?: MessageParams };
  actions: RecoveryAction[];
  /** True while repeating the operation must stay unavailable. */
  blocking: boolean;
  /** The observation fully resolves the operation. */
  settled: boolean;
  /** The project the observation showed, for Load latest / Keep my edits / Open. */
  project: Project | null;
  /** A field-level problem for the key field (create only). */
  keyProblem: boolean;
  /** The existing project to open, when a create probably succeeded. */
  openProjectId: string | null;
};

const base = {
  actions: [],
  blocking: false,
  settled: false,
  project: null,
  keyProblem: false,
  openProjectId: null,
};

/**
 * Turns one read-only recheck into a message, using only what that single response shows.
 * Pure and deterministic. A failed read is never an observation.
 */
export function analyse(op: Op, observation: Observation): Conclusion {
  if (op.kind === 'create') {
    if (observation.kind !== 'list')
      return {
        ...base,
        message: { key: 'unknown.create.recheckFailed' },
        actions: ['checkAgain'],
        blocking: true,
      };
    const row = observation.list.projects.find((item) => item.key === op.key);
    // The list summary has no objective, so a match on key, name and priority is "probably".
    if (row && row.name === op.name && row.priority === op.priority)
      return {
        ...base,
        message: { key: 'unknown.create.matchingRow', params: { name: row.name } },
        actions: ['openProject', 'checkAgain'],
        blocking: true,
        openProjectId: row.id,
      };
    if (row)
      return {
        ...base,
        message: { key: 'unknown.create.keyTaken', params: { name: row.name } },
        actions: ['checkAgain', 'editValues'],
        keyProblem: true,
      };
    return {
      ...base,
      message: { key: 'unknown.create.noMatch' },
      actions: ['tryAgain', 'checkAgain', 'editValues'],
    };
  }

  const kind = op.kind;
  const failed: MessageKey =
    kind === 'edit' ? 'unknown.edit.recheckFailed' : 'unknown.archive.recheckFailed';
  if (observation.kind === 'failed')
    return { ...base, message: { key: failed }, actions: ['checkAgain'], blocking: true };
  if (observation.kind === 'absent')
    return {
      ...base,
      message: { key: kind === 'edit' ? 'unknown.edit.absent' : 'unknown.archive.absent' },
      actions: ['checkAgain'],
      blocking: true,
    };
  if (observation.kind === 'list')
    return { ...base, message: { key: failed }, actions: ['checkAgain'], blocking: true };

  const project = observation.project;
  if (kind === 'archive') {
    if (project.status === 'archived')
      return { ...base, message: { key: 'unknown.archive.applied' }, settled: true, project };
    if (project.revision === op.expectedRevision)
      return {
        ...base,
        message: { key: 'unknown.archive.notApplied' },
        actions: ['tryAgain', 'checkAgain', 'close'],
        project,
      };
    return {
      ...base,
      message: { key: 'unknown.archive.changed' },
      actions: ['loadLatest'],
      blocking: true,
      project,
    };
  }

  if (project.status === 'archived')
    return { ...base, message: { key: 'unknown.edit.archived' }, settled: true, project };
  const requested = op.changes;
  const matches =
    (requested.name === undefined || project.name === requested.name) &&
    (requested.objective === undefined || project.objective === requested.objective) &&
    (requested.priority === undefined || project.priority === requested.priority);
  if (project.revision === op.expectedRevision + 1 && matches)
    return {
      ...base,
      message: { key: 'unknown.edit.applied', params: { revision: project.revision } },
      settled: true,
      project,
    };
  if (project.revision === op.expectedRevision)
    return {
      ...base,
      message: { key: 'unknown.edit.notApplied' },
      actions: ['tryAgain', 'checkAgain', 'editValues'],
      project,
    };
  return {
    ...base,
    message: { key: 'unknown.edit.changed' },
    actions: ['loadLatest', 'keepEdits', 'checkAgain'],
    blocking: true,
    project,
  };
}
