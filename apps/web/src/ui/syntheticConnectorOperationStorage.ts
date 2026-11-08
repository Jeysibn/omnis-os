import { z } from 'zod';

const storageVersion = 1 as const;
const pendingOperationStorageKey = 'omnis.synthetic-connector-operation.v1';

export type PendingOperation = {
  ownerId: string;
  taskId: string;
  projectId: string;
  profileVersion: number;
  assignmentRevision: number;
  idempotencyKey: string;
  authorizationId: string | null;
};

function storageKey(ownerId: string, taskId: string) {
  return `${pendingOperationStorageKey}:${encodeURIComponent(ownerId)}:${encodeURIComponent(taskId)}`;
}

export function storePendingOperation(
  operation: PendingOperation,
  ownerId: string,
  taskId: string,
) {
  sessionStorage.setItem(
    storageKey(ownerId, taskId),
    JSON.stringify({ version: storageVersion, ...operation }),
  );
}

export function clearPendingOperation(ownerId: string, taskId: string) {
  sessionStorage.removeItem(storageKey(ownerId, taskId));
}

export function readPendingOperation(ownerId: string, taskId: string): PendingOperation | null {
  try {
    const value: unknown = JSON.parse(
      sessionStorage.getItem(storageKey(ownerId, taskId)) ?? 'null',
    );
    if (typeof value !== 'object' || value === null) return null;
    const parsed = pendingOperationSchema.safeParse(value);
    if (!parsed.success) {
      clearPendingOperation(ownerId, taskId);
      return null;
    }
    if (parsed.data.ownerId !== ownerId || parsed.data.taskId !== taskId) {
      clearPendingOperation(ownerId, taskId);
      return null;
    }
    return parsed.data;
  } catch {
    clearPendingOperation(ownerId, taskId);
    return null;
  }
}

const pendingOperationSchema = z
  .object({
    version: z.literal(storageVersion),
    ownerId: z.string().min(1).max(128),
    taskId: z.string().min(1).max(128),
    projectId: z.string().min(1).max(128),
    profileVersion: z.number().int().positive(),
    assignmentRevision: z.number().int().positive(),
    idempotencyKey: z.string().uuid(),
    authorizationId: z.string().uuid().nullable(),
  })
  .strict();
