/**
 * The status lifecycle the backend enforces for epics and milestones (migrations 0018 and 0019):
 *
 *   planned -> in_progress -> completed, and planned -> completed
 *
 * Nothing moves backward, and `archived` is reached only through the archive action. Naming the
 * current status again is allowed and changes nothing. Offering only these steps means the form
 * cannot ask for a change the server will refuse.
 */
export type EditableStatus = 'planned' | 'in_progress' | 'completed';

const forward: Record<EditableStatus, readonly EditableStatus[]> = {
  planned: ['planned', 'in_progress', 'completed'],
  in_progress: ['in_progress', 'completed'],
  completed: ['completed'],
};

/** The statuses to offer for a record at `current`, the current one first. Archived has none. */
export function nextStatuses(current: string): readonly EditableStatus[] {
  return current === 'planned' || current === 'in_progress' || current === 'completed'
    ? forward[current]
    : [];
}

export const isValidStatusStep = (from: string, to: string): boolean =>
  (nextStatuses(from) as readonly string[]).includes(to);

export const statusLabel = (status: string): string =>
  status.replaceAll('_', ' ').replace(/^\w/, (c) => c.toUpperCase());
