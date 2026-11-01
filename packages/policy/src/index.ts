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
