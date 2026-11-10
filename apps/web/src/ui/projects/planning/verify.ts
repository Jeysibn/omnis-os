/**
 * Whether a successful task-to-epic response proves the change it was sent for.
 *
 * The API advances `associationRevision` by exactly one when an association really changes
 * (set, move or clear). Asking for the epic the task is already in is a documented no-op: nothing
 * changes and the revision stays where it was. A response that only looks successful, with the
 * wrong task or epic, an unchanged revision for a real change, or a jump, is not a confirmation.
 */
export type AssociationResponse = {
  taskId: string;
  epicId: string | null;
  associationRevision: number;
};

export function associationConfirmed(
  response: AssociationResponse,
  sent: {
    taskId: string;
    epicId: string | null;
    expectedAssociationRevision: number;
    /** The epic the task was in when the revision was read. */
    currentEpicId: string | null;
  },
): boolean {
  if (response.taskId !== sent.taskId || response.epicId !== sent.epicId) return false;
  const noOp = sent.epicId === sent.currentEpicId;
  return response.associationRevision === sent.expectedAssociationRevision + (noOp ? 0 : 1);
}
