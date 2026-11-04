import type { Department } from '@omnis/contracts';
import type { Msg } from './messages.js';

/** What the user asked for. Values are already trimmed and schema-valid. */
export type Op =
  | { kind: 'create'; slug: string; name: string }
  | {
      kind: 'rename';
      id: string;
      previous: { slug: string; name: string };
      slug: string;
      name: string;
    };

/** `unknown`: the mutation outcome is unknown. `conflict`: a rename 409 whose cause needs diagnosing. */
export type RecoveryMode = 'unknown' | 'conflict';
export type RecoveryAction = 'checkAgain' | 'close' | 'tryAgain' | 'editCurrent' | 'editValues';

export type Conclusion = {
  messages: Msg[];
  actions: RecoveryAction[];
  /** True while the operation that could be repeated must stay unavailable (spec 7.4). */
  blocking: boolean;
  /** The form closes and the list is re-read. */
  closeForm: boolean;
  /** A field-level message for the slug field, shown in the form instead of the status region. */
  slugProblem: Msg | null;
  /** Current server values, used by "Edit current values". */
  current: { name: string; slug: string } | null;
  /** The observation fully resolves the check; no banner remains. */
  settled: boolean;
};

const base: Conclusion = {
  messages: [],
  actions: [],
  blocking: false,
  closeForm: false,
  slugProblem: null,
  current: null,
  settled: false,
};

/**
 * Turns one successful (or failed) read-only recheck into a message, using only what that single
 * response shows (spec 7.4 to 7.7). Pure and deterministic. `list` is null when the recheck failed
 * or its response was invalid; that never becomes an observation.
 */
export function analyse(
  op: Op,
  mode: RecoveryMode,
  list: readonly Department[] | null,
): Conclusion {
  if (op.kind === 'create') {
    if (list === null)
      return {
        ...base,
        messages: [{ key: 'unknown.create.recheckFailed' }],
        actions: ['checkAgain'],
        blocking: true,
      };
    const row = list.find((item) => item.slug === op.slug);
    if (row && row.name === op.name)
      return {
        ...base,
        messages: [{ key: 'unknown.create.matchingRow' }],
        actions: ['close', 'checkAgain'],
        blocking: true,
      };
    if (row) {
      const message: Msg = {
        key: 'unknown.create.slugTaken',
        params: { name: row.name, archived: row.archivedAt !== null },
      };
      return { ...base, messages: [message], slugProblem: message, actions: ['checkAgain'] };
    }
    return {
      ...base,
      messages: [{ key: 'unknown.create.noMatch' }],
      actions: ['checkAgain', 'tryAgain', 'editValues'],
    };
  }

  const row = list?.find((item) => item.id === op.id);
  if (mode === 'conflict') {
    if (list === null)
      return {
        ...base,
        messages: [{ key: 'rejected.rename.readbackFailed' }],
        actions: ['checkAgain'],
      };
    if (!row)
      return { ...base, messages: [{ key: 'rejected.rename.absent' }], actions: ['checkAgain'] };
    if (row.archivedAt !== null)
      return {
        ...base,
        messages: [{ key: 'rejected.rename.archived' }],
        closeForm: true,
        settled: true,
      };
    if (list.some((item) => item.id !== op.id && item.slug === op.slug)) {
      const message: Msg = { key: 'rejected.rename.conflictOtherSlug' };
      return { ...base, messages: [message], slugProblem: message, settled: true };
    }
    return {
      ...base,
      messages: [{ key: 'rejected.rename.inconclusive' }],
      actions: ['checkAgain'],
    };
  }

  if (list === null)
    return {
      ...base,
      messages: [{ key: 'unknown.rename.recheckFailed' }],
      actions: ['checkAgain'],
      blocking: true,
    };
  if (!row)
    return {
      ...base,
      messages: [{ key: 'unknown.rename.absent' }],
      actions: ['checkAgain'],
      blocking: true,
    };
  if (row.archivedAt !== null)
    return {
      ...base,
      messages: [{ key: 'unknown.rename.archived' }],
      closeForm: true,
      settled: true,
    };
  if (row.slug === op.slug && row.name === op.name)
    return {
      ...base,
      messages: [
        { key: 'unknown.rename.requestedValues', params: { name: row.name, slug: row.slug } },
      ],
      closeForm: true,
      settled: true,
    };
  if (row.slug === op.previous.slug && row.name === op.previous.name)
    return {
      ...base,
      messages: [{ key: 'unknown.rename.previousValues' }],
      actions: ['tryAgain', 'editValues', 'checkAgain'],
    };
  // Other values: submit stays unavailable until the user chooses "Edit current values".
  return {
    ...base,
    messages: [{ key: 'unknown.rename.otherValues', params: { name: row.name, slug: row.slug } }],
    actions: ['editCurrent', 'checkAgain'],
    blocking: true,
    current: { name: row.name, slug: row.slug },
  };
}
