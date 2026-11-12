import { z } from 'zod';
import { parseProtocolJson } from '@omnis/runtime-protocol';

const MAX_FRAME_BYTES = 16_384;
const MAX_DELTA_BYTES = 4_096;
const MAX_OUTPUT_BYTES = 32_000;
const GenerationSchema = z.number().int().min(1).max(2_147_483_647).safe();
const SafeIdentitySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
const OfflineTextTurnRequestSchema = z
  .object({
    method: z.literal('turn/start'),
    params: z
      .object({
        threadId: SafeIdentitySchema,
        input: z
          .array(
            z.object({ type: z.literal('text'), text: z.string().min(1).max(32_000) }).strict(),
          )
          .min(1)
          .max(1),
      })
      .strict(),
  })
  .strict();

const TurnStartedSchema = z
  .object({
    method: z.literal('turn/started'),
    params: z
      .object({
        turn: z
          .object({
            id: SafeIdentitySchema,
            status: z.literal('inProgress').optional(),
            items: z.array(z.unknown()).max(0).optional(),
            error: z.null().optional(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
const TextDeltaSchema = z
  .object({
    method: z.literal('item/agentMessage/delta'),
    params: z
      .object({
        threadId: SafeIdentitySchema,
        turnId: SafeIdentitySchema,
        itemId: SafeIdentitySchema,
        delta: z.string().min(1).max(MAX_DELTA_BYTES),
      })
      .strict(),
  })
  .strict();
const TextItemLifecycleSchema = z
  .object({
    method: z.enum(['item/started', 'item/completed']),
    params: z
      .object({
        threadId: SafeIdentitySchema,
        turnId: SafeIdentitySchema,
        item: z
          .object({
            id: SafeIdentitySchema,
            type: z.literal('agentMessage'),
            text: z.string().max(MAX_OUTPUT_BYTES),
            phase: z.enum(['commentary', 'partial_answer', 'final_answer']).optional(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
const TurnCompletedSchema = z
  .object({
    method: z.literal('turn/completed'),
    params: z
      .object({
        turn: z
          .object({
            id: SafeIdentitySchema,
            status: z.enum(['completed', 'failed', 'interrupted']),
            error: z.unknown().optional(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export type OfflineCodexLifecycleType =
  | 'requested'
  | 'authorized'
  | 'submitted'
  | 'started'
  | 'text_delta'
  | 'completed'
  | 'failed'
  | 'cancel_requested'
  | 'cancelled'
  | 'interrupted'
  | 'outcome_unknown'
  | 'usage_reported'
  | 'usage_unavailable';

export type OfflineCodexProjectedEvent = {
  type: OfflineCodexLifecycleType;
  runId: string;
  operationId: string;
  generation: number;
  sessionId: string;
  threadId: string;
  turnId: string;
  sequence: number;
  eventId?: string;
  itemId?: string;
  message?: string;
  errorClass?: AppServerFailureClass;
};

export type AppServerFailureClass =
  | 'authorization'
  | 'entitlement'
  | 'invalid_request'
  | 'execution'
  | 'upstream'
  | 'provider_failure';

export type OfflineUsage =
  | {
      kind: 'reported';
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      provenance: 'synthetic-fixture';
    }
  | { kind: 'unknown'; reason: 'not_reported' };

export type ProviderOperationStatus =
  | 'requested'
  | 'authorized'
  | 'submission_attempted'
  | 'submitted'
  | 'started'
  | 'cancellation_requested_before_submission'
  | 'cancellation_requested'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'cancellation_unknown'
  | 'unknown';

export type ProviderOperationSignal =
  | 'authorized'
  | 'submission_attempted'
  | 'submission_acknowledged'
  | 'started'
  | 'submission_ack_lost'
  | 'cancel_requested'
  | 'cancel_confirmed'
  | 'cancel_outcome_unknown'
  | 'provider_terminal_completed'
  | 'provider_terminal_failed'
  | 'provider_terminal_interrupted'
  | 'connection_lost'
  | 'reconciled_completed'
  | 'reconciled_failed'
  | 'reconciled_interrupted'
  | 'reconciled_cancelled';

type ProjectorContext = {
  runId: string;
  operationId: string;
  generation: number;
  sessionId: string;
  threadId: string;
  turnId: string;
  maxOutputBytes: number;
};

type Delivery = { sequence: number; eventId: string; frame: string };

/** Constructs only a text input fixture. This object is never sent to app-server. */
export function createOfflineTextTurnRequest(threadId: string, prompt: string) {
  return OfflineTextTurnRequestSchema.parse({
    method: 'turn/start',
    params: { threadId, input: [{ type: 'text', text: prompt }] },
  });
}

/**
 * Offline-only fixture projector. The eventId and delivery sequence are synthetic transport
 * metadata; current app-server docs do not promise stable event IDs or a replay cursor.
 */
export class OfflineCodexEventProjector {
  readonly context: ProjectorContext;
  private statusValue: ProviderOperationStatus = 'submitted';
  private eventSequence = 0;
  private deliverySequence = 0;
  private outputValue = '';
  private cancellationWasRequested = false;
  private turnHasStarted = false;
  private cancellationEvent: OfflineCodexProjectedEvent | undefined;
  private uncertainOutcomeEvent: OfflineCodexProjectedEvent | undefined;
  private readonly seenDeliveries = new Map<string, { frame: string; sequence: number }>();
  private messageItemId: string | undefined;
  private messageCompleted = false;

  constructor(context: ProjectorContext) {
    const parsed = z
      .object({
        runId: SafeIdentitySchema,
        operationId: z.string().uuid(),
        generation: GenerationSchema,
        sessionId: SafeIdentitySchema,
        threadId: SafeIdentitySchema,
        turnId: SafeIdentitySchema,
        maxOutputBytes: z.number().int().min(1).max(MAX_OUTPUT_BYTES).safe(),
      })
      .strict()
      .parse(context);
    this.context = parsed;
  }

  get output(): string {
    return this.outputValue;
  }

  get status(): ProviderOperationStatus {
    return this.statusValue;
  }

  requestCancellation(): OfflineCodexProjectedEvent {
    if (
      this.statusValue === 'completed' ||
      this.statusValue === 'failed' ||
      this.statusValue === 'cancelled' ||
      this.statusValue === 'interrupted'
    )
      throw new Error('cannot cancel a terminal provider operation');
    if (this.statusValue === 'unknown' || this.statusValue === 'cancellation_unknown')
      return this.unknownOutcomeEvent();
    if (!this.cancellationWasRequested) {
      this.cancellationWasRequested = true;
      this.statusValue = 'cancellation_requested';
      this.cancellationEvent = this.event('cancel_requested');
    }
    return this.cancellationEvent!;
  }

  disconnect(): OfflineCodexProjectedEvent {
    if (isTerminal(this.statusValue))
      throw new Error('cannot mark a terminal provider operation unknown');
    this.statusValue = this.cancellationWasRequested ? 'cancellation_unknown' : 'unknown';
    return this.unknownOutcomeEvent();
  }

  accept(delivery: Delivery): { duplicate: boolean; event?: OfflineCodexProjectedEvent } {
    try {
      return this.acceptValidated(delivery);
    } catch (error) {
      // A rejected protocol frame cannot be skipped safely: the caller must reconcile.
      if (!isTerminal(this.statusValue))
        this.statusValue = this.cancellationWasRequested ? 'cancellation_unknown' : 'unknown';
      throw error;
    }
  }

  private acceptValidated(delivery: Delivery): {
    duplicate: boolean;
    event?: OfflineCodexProjectedEvent;
  } {
    const checkedDelivery = z
      .object({
        sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).safe(),
        eventId: SafeIdentitySchema,
        frame: z.string(),
      })
      .strict()
      .parse(delivery);
    const frameBytes = Buffer.byteLength(checkedDelivery.frame, 'utf8');
    if (frameBytes < 1 || frameBytes > MAX_FRAME_BYTES)
      throw new Error('app-server frame limit exceeded');

    const previouslySeen = this.seenDeliveries.get(checkedDelivery.eventId);
    if (previouslySeen !== undefined) {
      if (
        previouslySeen.frame !== checkedDelivery.frame ||
        previouslySeen.sequence !== checkedDelivery.sequence
      )
        throw new Error('duplicate delivery identity conflict');
      return { duplicate: true };
    }
    if (this.statusValue === 'unknown' || this.statusValue === 'cancellation_unknown')
      throw new Error('unknown outcome requires authoritative reconciliation');
    if (checkedDelivery.sequence !== this.deliverySequence + 1)
      throw new Error('app-server events are out-of-order or have a gap');
    if (isTerminal(this.statusValue))
      throw new Error('app-server event arrived after terminal outcome');

    let decoded: unknown;
    try {
      decoded = parseProtocolJson(checkedDelivery.frame);
    } catch {
      throw new Error('malformed app-server JSON');
    }
    const object = z.record(z.string(), z.unknown()).safeParse(decoded);
    if (!object.success) throw new Error('malformed app-server message');
    if ('id' in object.data && 'method' in object.data)
      throw new Error('tool or server request rejected at offline parser boundary');

    const normalized = this.normalize(object.data);
    const event = normalized ? { ...normalized, eventId: checkedDelivery.eventId } : undefined;
    this.seenDeliveries.set(checkedDelivery.eventId, {
      frame: checkedDelivery.frame,
      sequence: checkedDelivery.sequence,
    });
    this.deliverySequence = checkedDelivery.sequence;
    return { duplicate: false, ...(event ? { event } : {}) };
  }

  private normalize(value: Record<string, unknown>): OfflineCodexProjectedEvent | undefined {
    const itemLifecycle = TextItemLifecycleSchema.safeParse(value);
    if (itemLifecycle.success) {
      const { method, params } = itemLifecycle.data;
      if (params.threadId !== this.context.threadId || params.turnId !== this.context.turnId)
        throw new Error('app-server session or turn identity mismatch');
      if (method === 'item/started') {
        if (
          !this.turnHasStarted ||
          (this.statusValue !== 'started' && this.statusValue !== 'cancellation_requested') ||
          this.messageItemId !== undefined ||
          this.messageCompleted ||
          params.item.text !== ''
        )
          throw new Error('unexpected app-server text item start');
        this.messageItemId = params.item.id;
        return undefined;
      }
      if (
        params.item.id !== this.messageItemId ||
        this.messageCompleted ||
        params.item.text !== this.outputValue
      )
        throw new Error('app-server text item completion mismatch');
      this.messageCompleted = true;
      return undefined;
    }

    const started = TurnStartedSchema.safeParse(value);
    if (started.success) {
      const turnId = started.data.params.turn.id;
      if (turnId !== this.context.turnId) throw new Error('app-server turn identity mismatch');
      if (
        this.turnHasStarted ||
        (this.statusValue !== 'submitted' && this.statusValue !== 'cancellation_requested')
      )
        throw new Error('unexpected app-server start event');
      this.turnHasStarted = true;
      if (!this.cancellationWasRequested) this.statusValue = 'started';
      return this.event('started');
    }

    const delta = TextDeltaSchema.safeParse(value);
    if (delta.success) {
      if (
        !this.turnHasStarted ||
        delta.data.params.threadId !== this.context.threadId ||
        delta.data.params.turnId !== this.context.turnId ||
        delta.data.params.itemId !== this.messageItemId ||
        this.messageCompleted
      )
        throw new Error('app-server session or turn identity mismatch');
      if (this.statusValue !== 'started' && this.statusValue !== 'cancellation_requested')
        throw new Error('unexpected app-server text event');
      const nextOutput = this.outputValue + delta.data.params.delta;
      if (Buffer.byteLength(nextOutput, 'utf8') > this.context.maxOutputBytes)
        throw new Error('app-server output limit exceeded');
      this.outputValue = nextOutput;
      return this.event('text_delta', {
        itemId: delta.data.params.itemId,
        message: delta.data.params.delta,
      });
    }

    const completed = TurnCompletedSchema.safeParse(value);
    if (completed.success) {
      const turn = completed.data.params.turn;
      if (turn.id !== this.context.turnId) throw new Error('app-server turn identity mismatch');
      switch (turn.status) {
        case 'completed':
          if (turn.error != null) throw new Error('contradictory app-server completion evidence');
          if (!this.messageCompleted)
            throw new Error('app-server completed before text item completion');
          this.statusValue = 'completed';
          return this.event('completed');
        case 'failed':
          this.statusValue = 'failed';
          return this.event('failed', { errorClass: classifyAppServerFailure(turn.error) });
        case 'interrupted':
          this.statusValue = this.cancellationWasRequested ? 'cancelled' : 'interrupted';
          return this.event(this.cancellationWasRequested ? 'cancelled' : 'interrupted');
      }
    }

    if (isToolOrNonTextItem(value))
      throw new Error('tool or non-text item rejected at offline parser boundary');
    throw new Error('unsupported app-server event');
  }

  private event(
    type: OfflineCodexLifecycleType,
    fields: Pick<OfflineCodexProjectedEvent, 'itemId' | 'message' | 'errorClass'> = {},
  ): OfflineCodexProjectedEvent {
    return {
      ...this.context,
      ...fields,
      type,
      sequence: ++this.eventSequence,
    };
  }

  private unknownOutcomeEvent(): OfflineCodexProjectedEvent {
    this.uncertainOutcomeEvent ??= this.event('outcome_unknown');
    return this.uncertainOutcomeEvent;
  }
}

export function classifyAppServerFailure(input: unknown): AppServerFailureClass {
  const candidate = z.record(z.string(), z.unknown()).safeParse(input);
  const codexInfo = candidate.success ? candidate.data.codexErrorInfo : undefined;
  if (codexInfo === 'unauthorized') return 'authorization';
  if (codexInfo === 'usageLimitExceeded') return 'entitlement';
  if (codexInfo === 'badRequest' || codexInfo === 'contextWindowExceeded') return 'invalid_request';
  if (codexInfo === 'sandboxError') return 'execution';
  if (codexInfo !== null && typeof codexInfo === 'object' && 'httpConnectionFailed' in codexInfo)
    return 'upstream';
  return 'provider_failure';
}

/** Normalized fixture shape only; current app-server docs do not define the usage notification payload. */
export function normalizeOfflineUsage(input: unknown): OfflineUsage {
  if (input === undefined || input === null) return { kind: 'unknown', reason: 'not_reported' };
  const parsed = z
    .object({
      inputTokens: z.number().int().nonnegative().max(1_000_000_000).safe(),
      outputTokens: z.number().int().nonnegative().max(1_000_000_000).safe(),
      totalTokens: z.number().int().nonnegative().max(1_000_000_000).safe(),
    })
    .strict()
    .parse(input);
  if (parsed.inputTokens + parsed.outputTokens !== parsed.totalTokens)
    throw new Error('usage totals are inconsistent');
  return { kind: 'reported', ...parsed, provenance: 'synthetic-fixture' };
}

export function transitionProviderOperation(
  current: ProviderOperationStatus,
  signal: ProviderOperationSignal,
): ProviderOperationStatus {
  const transitions: Record<
    ProviderOperationStatus,
    Partial<Record<ProviderOperationSignal, ProviderOperationStatus>>
  > = {
    requested: {
      authorized: 'authorized',
      cancel_requested: 'cancellation_requested_before_submission',
    },
    authorized: {
      submission_attempted: 'submission_attempted',
      cancel_requested: 'cancellation_requested_before_submission',
    },
    submission_attempted: {
      submission_acknowledged: 'submitted',
      submission_ack_lost: 'unknown',
      cancel_requested: 'cancellation_requested',
      connection_lost: 'unknown',
    },
    submitted: {
      started: 'started',
      cancel_requested: 'cancellation_requested',
      provider_terminal_completed: 'completed',
      provider_terminal_failed: 'failed',
      provider_terminal_interrupted: 'interrupted',
      connection_lost: 'unknown',
    },
    started: {
      cancel_requested: 'cancellation_requested',
      provider_terminal_completed: 'completed',
      provider_terminal_failed: 'failed',
      provider_terminal_interrupted: 'interrupted',
      connection_lost: 'unknown',
    },
    cancellation_requested: {
      submission_acknowledged: 'cancellation_requested',
      submission_ack_lost: 'cancellation_unknown',
      started: 'cancellation_requested',
      cancel_outcome_unknown: 'cancellation_unknown',
      provider_terminal_completed: 'completed',
      provider_terminal_failed: 'failed',
      provider_terminal_interrupted: 'cancelled',
      connection_lost: 'cancellation_unknown',
    },
    cancellation_requested_before_submission: { cancel_confirmed: 'cancelled' },
    unknown: {
      reconciled_completed: 'completed',
      reconciled_failed: 'failed',
      reconciled_interrupted: 'interrupted',
    },
    cancellation_unknown: {
      reconciled_completed: 'completed',
      reconciled_failed: 'failed',
      reconciled_interrupted: 'interrupted',
      reconciled_cancelled: 'cancelled',
    },
    cancelled: {},
    completed: {},
    failed: {},
    interrupted: {},
  };
  const next = transitions[current]?.[signal];
  if (!next) throw new Error(`invalid provider operation transition: ${current} -> ${signal}`);
  return next;
}

function isTerminal(status: ProviderOperationStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'interrupted'
  );
}

function isToolOrNonTextItem(value: Record<string, unknown>): boolean {
  if (value.method === 'item/started' || value.method === 'item/completed') {
    const parsed = TextItemLifecycleSchema.safeParse(value);
    return !parsed.success;
  }
  if (typeof value.method === 'string' && value.method.startsWith('item/')) return true;
  return false;
}
