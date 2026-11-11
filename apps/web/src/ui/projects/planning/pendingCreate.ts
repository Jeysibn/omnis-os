import { z } from 'zod';
import { CreateEpicSchema, CreateMilestoneSchema, ProjectIdSchema } from '@omnis/contracts';

/**
 * Durable protection for an epic or milestone create whose outcome is unknown.
 *
 * A create has no record id to read back, and the response can be lost after the server committed.
 * The one safe way to settle it is to send the SAME request again with the SAME Idempotency-Key.
 * So the request and its key are written to tab-scoped sessionStorage BEFORE the request is sent,
 * and survive a reload of the tab. This is not durable across closing the tab or browser, a
 * private session ending, or storage being cleared, and nothing here claims otherwise.
 *
 * What is stored is exactly what is needed to repeat the request and to recognise a record it may
 * have made: the owner, project and record type it is bound to, the normalised request body, the
 * idempotency key, when it was first attempted, and a bounded list of ids already known. No token,
 * cookie, CSRF value, password or other session data is ever stored.
 *
 * The state machine below is the single place that decides what each outcome means. Its invariant:
 * a pending request is cleared ONLY by (a) a valid confirmed response, (b) a refusal of the very
 * first attempt, or (c) the owner explicitly discarding it. A reload, a closed dialog, a matching
 * list record, an incomplete list, a timeout, an old key, a storage problem or a change of owner
 * never turns it into an ordinary new create.
 */
export type CreateKind = 'epic' | 'milestone';

export const ENVELOPE_VERSION = 1 as const;
export const STORAGE_PREFIX = 'omnis.planning-create.v1';
export const MAX_ENVELOPE_CHARS = 16 * 1024;
export const MAX_KNOWN_IDS = 200;
/**
 * How long a client treats the server as still remembering an idempotency key. The merged backend
 * keeps its idempotency ledger without a documented retention period, so this is a conservative
 * client-side safety policy, NOT a backend guarantee. After it, repeating the request could create
 * a duplicate if the receipt were gone, so it is not repeated automatically.
 */
export const REPLAY_WINDOW_MS = 15 * 60 * 1000;
/** Allowed difference between this browser's clock and a stored timestamp from the future. */
export const FUTURE_SKEW_MS = 5 * 60 * 1000;
const EARLIEST_ATTEMPT = Date.UTC(2020, 0, 1);

export type CreateRequest = { title: string; description?: string; targetDate?: string };
export type PendingEnvelope = {
  version: typeof ENVELOPE_VERSION;
  ownerId: string;
  projectId: string;
  kind: CreateKind;
  request: CreateRequest;
  idempotencyKey: string;
  /** Browser time of the first attempt (milliseconds). */
  attemptedAt: number;
  /** Ids already known when the request was first sent, so a later read can tell what is new. */
  knownIds?: string[];
};
export type Scope = { ownerId: string; projectId: string; kind: CreateKind };

export const storageKey = (scope: Scope) =>
  `${STORAGE_PREFIX}:${encodeURIComponent(scope.ownerId)}:${scope.projectId}:${scope.kind}`;

const idPattern = /^(epc|mil)_[0-9a-f]{32}$/;
const envelopeSchema = z
  .object({
    version: z.literal(ENVELOPE_VERSION),
    ownerId: z.string().min(1).max(128),
    projectId: ProjectIdSchema,
    kind: z.enum(['epic', 'milestone']),
    request: z.record(z.string(), z.unknown()),
    idempotencyKey: z.string().uuid(),
    attemptedAt: z.number().int().safe(),
    knownIds: z.array(z.string().regex(idPattern)).max(MAX_KNOWN_IDS).optional(),
  })
  .strict();

export type UnsafeReason =
  /** Storage cannot be read or written, so recovery information cannot be kept. */
  | 'storage-unavailable'
  /** What is stored cannot be parsed or fails validation. */
  | 'corrupt'
  /** A newer or unknown envelope version. */
  | 'incompatible'
  /** The stored envelope belongs to another owner, project or record type. */
  | 'foreign'
  /** The stored timestamp is impossible. */
  | 'clock';

export type ReadResult =
  | { status: 'none' }
  | { status: 'found'; envelope: PendingEnvelope }
  | { status: 'blocked'; reason: UnsafeReason };

/** The part of the Storage API this uses, so tests and the app can supply any implementation. */
export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const browserStorage = (): StorageLike | null => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

/** Strictly parses and validates one stored value for exactly this scope. Fails closed. */
export function parseEnvelope(raw: string, scope: Scope, now: number): ReadResult {
  if (raw.length > MAX_ENVELOPE_CHARS) return { status: 'blocked', reason: 'corrupt' };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: 'blocked', reason: 'corrupt' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return { status: 'blocked', reason: 'corrupt' };
  const version = (value as { version?: unknown }).version;
  if (version !== undefined && version !== ENVELOPE_VERSION)
    return { status: 'blocked', reason: 'incompatible' };
  const parsed = envelopeSchema.safeParse(value);
  if (!parsed.success) return { status: 'blocked', reason: 'corrupt' };
  const envelope = parsed.data;
  // Bound to the signed-in owner, this project and this record type: anything else is not ours to
  // use, and its contents are never shown.
  if (
    envelope.ownerId !== scope.ownerId ||
    envelope.projectId !== scope.projectId ||
    envelope.kind !== scope.kind
  )
    return { status: 'blocked', reason: 'foreign' };
  const request = (envelope.kind === 'epic' ? CreateEpicSchema : CreateMilestoneSchema).safeParse(
    envelope.request,
  );
  if (!request.success) return { status: 'blocked', reason: 'corrupt' };
  if (envelope.attemptedAt < EARLIEST_ATTEMPT || envelope.attemptedAt > now + FUTURE_SKEW_MS)
    return { status: 'blocked', reason: 'clock' };
  const { targetDate, description } = request.data as {
    targetDate?: string | null;
    description?: string;
  };
  return {
    status: 'found',
    envelope: {
      version: ENVELOPE_VERSION,
      ownerId: envelope.ownerId,
      projectId: envelope.projectId,
      kind: envelope.kind,
      request: {
        title: request.data.title,
        ...(description !== undefined ? { description } : {}),
        ...(targetDate ? { targetDate } : {}),
      },
      idempotencyKey: envelope.idempotencyKey,
      attemptedAt: envelope.attemptedAt,
      ...(envelope.knownIds ? { knownIds: envelope.knownIds } : {}),
    },
  };
}

export function readPending(storage: StorageLike | null, scope: Scope, now: number): ReadResult {
  if (!storage) return { status: 'blocked', reason: 'storage-unavailable' };
  let raw: string | null;
  try {
    raw = storage.getItem(storageKey(scope));
  } catch {
    return { status: 'blocked', reason: 'storage-unavailable' };
  }
  return raw === null ? { status: 'none' } : parseEnvelope(raw, scope, now);
}

/** Writes the envelope and reads it back. False means it could not be kept, so it must not be sent. */
export function writePending(storage: StorageLike | null, envelope: PendingEnvelope): boolean {
  if (!storage) return false;
  const key = storageKey(envelope);
  try {
    const text = JSON.stringify(envelope);
    if (text.length > MAX_ENVELOPE_CHARS) return false;
    storage.setItem(key, text);
    return storage.getItem(key) === text;
  } catch {
    return false;
  }
}

/** Removes the stored request. True only when it is verifiably gone. */
export function removePending(storage: StorageLike | null, scope: Scope): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(storageKey(scope));
    return storage.getItem(storageKey(scope)) === null;
  } catch {
    return false;
  }
}

/** Whether storage can currently hold a recovery record. Checked before any create is offered. */
export function storageWritable(storage: StorageLike | null): boolean {
  if (!storage) return false;
  const probe = `${STORAGE_PREFIX}:probe`;
  try {
    storage.setItem(probe, '1');
    const ok = storage.getItem(probe) === '1';
    storage.removeItem(probe);
    return ok;
  } catch {
    return false;
  }
}

export function newEnvelope(
  scope: Scope,
  request: CreateRequest,
  knownIds: readonly string[],
  now: number,
): PendingEnvelope {
  return {
    version: ENVELOPE_VERSION,
    ...scope,
    request,
    idempotencyKey: crypto.randomUUID(),
    attemptedAt: now,
    knownIds: knownIds.filter((id) => idPattern.test(id)).slice(0, MAX_KNOWN_IDS),
  };
}

/** Whether repeating the request with its old key can still be treated as safe. */
export function replayPolicy(
  envelope: Pick<PendingEnvelope, 'attemptedAt'>,
  now: number,
): { safe: true } | { safe: false; reason: 'replay-unverified' } {
  return now - envelope.attemptedAt > REPLAY_WINDOW_MS
    ? { safe: false, reason: 'replay-unverified' }
    : { safe: true };
}

/* ------------------------------- the state machine ------------------------------- */

/**
 * Phases, with the evidence that moves a request between them:
 *
 *  - none:          nothing is pending.
 *  - preparing:     the request is being written to storage. A failed write stops here: nothing
 *                   is sent, because its recovery information could not be kept.
 *  - submitted:     written, sent, no answer yet.
 *  - confirmed:     the server returned a valid record for this request. Clears the pending request.
 *  - rejected:      the server refused the FIRST attempt with a valid error. Nothing was applied.
 *                   Clears the pending request.
 *  - unknown:       no verified answer (network loss, 5xx, an unverifiable body, a reload, a
 *                   refusal that only concerns a retry). Keeps the request.
 *  - candidate:     a list read shows one fitting record. An observation, not evidence about which
 *                   request made it. Still unresolved: keeps the request.
 *  - unsafe:        recovery is unavailable or unsafe (storage, a corrupt or foreign record, a key
 *                   too old to trust, a refused retry). Keeps the request, locks creation.
 */
export type Phase =
  | 'none'
  | 'preparing'
  | 'submitted'
  | 'confirmed'
  | 'rejected'
  | 'unknown'
  | 'candidate'
  | 'unsafe';

export type SendOutcome =
  | { kind: 'saved' }
  | { kind: 'rejected'; status: number }
  | { kind: 'unknown' }
  | { kind: 'unauthorized' };

export type Transition = {
  to: Extract<Phase, 'confirmed' | 'rejected' | 'unknown' | 'unsafe'>;
  /** Whether the stored request may be removed. */
  clear: boolean;
  /** Why the request is unsafe, when it is. */
  unsafe?: 'refused';
  /** The evidence the transition rests on. */
  basis: string;
};

/**
 * What an answer to a send means. `retry` is true when the request had been sent before (so an
 * earlier outcome is still unknown). A refusal of a retry says nothing about the original request:
 * it may have been applied before the refusal.
 */
export function transitionAfterSend(retry: boolean, outcome: SendOutcome): Transition {
  switch (outcome.kind) {
    case 'saved':
      return {
        to: 'confirmed',
        clear: true,
        basis: 'the server returned a valid record for this idempotency key',
      };
    case 'unknown':
      return { to: 'unknown', clear: false, basis: 'no verified answer was received' };
    case 'unauthorized':
      return retry
        ? {
            to: 'unknown',
            clear: false,
            basis: 'a retry was turned away; the original is unaffected',
          }
        : {
            to: 'rejected',
            clear: true,
            basis: 'the session ended before the first attempt was processed',
          };
    case 'rejected':
      if (!retry)
        return {
          to: 'rejected',
          clear: true,
          basis: 'the server refused the first attempt itself with a valid error',
        };
      if (outcome.status === 403)
        return {
          to: 'unknown',
          clear: false,
          basis: 'the retry failed the secure-session check before it was processed',
        };
      return {
        to: 'unsafe',
        clear: false,
        unsafe: 'refused',
        basis: 'a refused retry does not show the original request was not applied',
      };
  }
}

/** What a read-only look at the list means: always an observation, never a resolution. */
export type ScanView =
  | { view: 'candidate' }
  | { view: 'ambiguous'; count: number }
  | { view: 'absent' }
  | { view: 'unreadable' };

export function viewAfterScan(
  result:
    | { kind: 'found' }
    | { kind: 'ambiguous'; count: number }
    | { kind: 'absent' }
    | { kind: 'unknown' },
): ScanView {
  if (result.kind === 'found') return { view: 'candidate' };
  if (result.kind === 'ambiguous') return { view: 'ambiguous', count: result.count };
  return result.kind === 'absent' ? { view: 'absent' } : { view: 'unreadable' };
}
