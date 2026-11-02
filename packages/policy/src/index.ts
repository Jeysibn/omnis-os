import { z } from 'zod';

export const AllowedUseSchema = z.enum(['interactive', 'background', 'both', 'disabled']);
export type AllowedUse = z.infer<typeof AllowedUseSchema>;

export function evaluateAllowedUse(
  allowedUse: AllowedUse,
  requestedUse: 'interactive' | 'background',
) {
  const parsed = AllowedUseSchema.safeParse(allowedUse);
  if (!parsed.success) return { allowed: false as const, reason: 'invalid_policy' as const };
  if (parsed.data === 'disabled')
    return { allowed: false as const, reason: 'runtime_disabled' as const };
  if (parsed.data === 'both' || parsed.data === requestedUse) return { allowed: true as const };
  return { allowed: false as const, reason: 'use_not_authorized' as const };
}

export const RuntimeAuthorizationSchema = z
  .object({
    id: z.string().min(1),
    actorId: z.string().min(1),
    runtimeId: z.string().min(1),
    operation: z.enum(['start_task', 'execute_task']),
    capabilities: z.array(z.enum(['mock.execute'])),
    scope: z.object({ kind: z.literal('all_tasks') }).strict(),
    approvalRequired: z.boolean(),
    status: z.enum(['authorized', 'denied', 'pending']),
    policyVersion: z.string().min(1),
    expiresAt: z.number().int().positive(),
    revokedAt: z.number().int().positive().nullable(),
    provenance: z.string().min(1),
  })
  .strict();
export type RuntimeAuthorization = z.infer<typeof RuntimeAuthorizationSchema>;

export interface RuntimeAuthorizationRequest {
  actorId: string;
  runtimeId: string;
  operation: RuntimeAuthorization['operation'];
  requiredCapabilities: readonly RuntimeAuthorization['capabilities'][number][];
  taskId: string;
}

export interface RuntimeAuthorizer {
  authorize(request: RuntimeAuthorizationRequest, now?: number): RuntimeAuthorization | undefined;
}

/** Omnis-owned policy records; adapter capabilities are descriptive and grant no authority. */
export class StaticRuntimeAuthorizer implements RuntimeAuthorizer {
  private readonly records: RuntimeAuthorization[];

  constructor(records: readonly RuntimeAuthorization[]) {
    this.records = records.map((record) => RuntimeAuthorizationSchema.parse(record));
  }

  authorize(
    request: RuntimeAuthorizationRequest,
    now = Date.now(),
  ): RuntimeAuthorization | undefined {
    return this.records.find(
      (record) =>
        record.actorId === request.actorId &&
        record.runtimeId === request.runtimeId &&
        record.operation === request.operation &&
        record.status === 'authorized' &&
        record.approvalRequired === false &&
        record.expiresAt > now &&
        record.revokedAt === null &&
        request.requiredCapabilities.every((capability) =>
          record.capabilities.includes(capability),
        ) &&
        request.taskId.length > 0 &&
        record.scope.kind === 'all_tasks',
    );
  }

  revoke(id: string, at = Date.now()): void {
    for (const record of this.records) {
      if (record.id === id) record.revokedAt = at;
    }
  }
}
