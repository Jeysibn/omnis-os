/**
 * What one read-only recheck shows about a write whose outcome is unknown or rejected with 409.
 * Pure and deterministic. A failed read is never an observation, and matching values at the next
 * revision are reported as observed state: another session can make the identical change.
 */
export type Observation<T> = { kind: 'record'; value: T } | { kind: 'absent' } | { kind: 'failed' };

export type Verdict =
  /** The next revision with the requested values. Probably this request, but not proof of it. */
  | 'applied'
  /** Still at the expected revision: the write did not happen. */
  | 'not-applied'
  /** Another revision than expected: the record changed elsewhere. */
  | 'changed'
  | 'archived'
  | 'absent'
  | 'unreadable';

export function judgeEdit<T extends { revision: number; status: string }>(
  expectedRevision: number,
  observation: Observation<T>,
  matches: (value: T) => boolean,
): Verdict {
  if (observation.kind === 'failed') return 'unreadable';
  if (observation.kind === 'absent') return 'absent';
  const value = observation.value;
  if (value.revision === expectedRevision + 1 && matches(value)) return 'applied';
  if (value.revision === expectedRevision) return 'not-applied';
  if (value.status === 'archived') return 'archived';
  return 'changed';
}

export function judgeAssociation(
  expectedAssociationRevision: number,
  targetEpicId: string | null,
  observation: Observation<{ associationRevision: number; epic: { id: string } | null }>,
): Verdict {
  if (observation.kind === 'failed') return 'unreadable';
  if (observation.kind === 'absent') return 'absent';
  const { associationRevision, epic } = observation.value;
  if (
    associationRevision === expectedAssociationRevision + 1 &&
    (epic?.id ?? null) === targetEpicId
  )
    return 'applied';
  if (associationRevision === expectedAssociationRevision) return 'not-applied';
  return 'changed';
}
