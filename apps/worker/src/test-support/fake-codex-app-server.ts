import { z } from 'zod';
import type { RuntimeCapabilities } from '@omnis/contracts';
import type { RuntimeAdapter } from '@omnis/runtime-adapters';
import { SandboxError } from '@omnis/runtime-adapters/sandbox-error';
import {
  OfflineCodexEventProjector,
  createOfflineTextTurnRequest,
} from './codex-app-server-contract.ts';

const MAX_FRAME_BYTES = 16_384;
const MAX_OUTPUT_CHARS = 2_000;
const RequestSchema = z
  .object({
    id: z.number().int().positive().optional(),
    method: z.string().min(1).max(100),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const ResponseSchema = z
  .object({
    id: z.number().int().positive(),
    result: z.record(z.string(), z.unknown()).optional(),
    error: z
      .object({ code: z.number().int(), message: z.string().max(200) })
      .strict()
      .optional(),
  })
  .strict();
const NotificationSchema = z
  .object({
    method: z.string().min(1).max(100),
    params: z.record(z.string(), z.unknown()),
  })
  .strict();

type FakeMode =
  | 'complete'
  | 'tool-request'
  | 'pending'
  | 'pending-unconfirmed-interrupt'
  | 'pending-wrong-turn'
  | 'pending-wrong-status'
  | 'pending-malformed-ack'
  | 'pending-invalid-ack'
  | 'pending-wrong-response-id'
  | 'pending-malformed-terminal'
  | 'pending-invalid-terminal'
  | 'pending-disconnect'
  | 'pending-after-ack-disconnect'
  | 'turn-start-ack-lost'
  | 'mixed-phases'
  | 'out-of-order-item'
  | 'wrong-item-delta'
  | 'duplicate-terminal'
  | 'contradictory-terminal'
  | 'malformed-turn-frame'
  | 'failed'
  | 'crashed'
  | 'timeout';
type FakeNotification = z.infer<typeof NotificationSchema>;
/** In-process protocol fixture. It has no child-process, network, or credential interface. */
export class FakeCodexAppServerProtocol {
  readonly transport = 'in-process' as const;
  readonly usesCredentials = false as const;
  readonly launchesNativeProcess = false as const;
  readonly methods: string[] = [];
  turnSubmissionCount = 0;
  private readonly mode: FakeMode;
  private nextId = 0;
  private threadId: string | undefined;
  private turnId: string | undefined;
  private turnStartedResolve: (() => void) | undefined;
  private readonly turnStarted = new Promise<void>((resolve) => {
    this.turnStartedResolve = resolve;
  });

  constructor(mode: FakeMode = 'complete') {
    this.mode = mode;
  }

  async request(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<{
    result: Record<string, unknown>;
    notificationFrames: string[];
  }> {
    const id = ++this.nextId;
    const frame = JSON.stringify({ id, method, params });
    const frames = await this.exchange(frame);
    const response = frames.map(parseResponse).find((candidate) => candidate?.id === id);
    if (!response) throw new Error('Fake protocol response did not match request id.');
    if (response.error) throw new Error('Fake app-server rejected the protocol request.');
    if (response.result === undefined) throw new Error('Fake protocol response has no result.');
    if (method === 'turn/interrupt' && this.mode === 'pending-after-ack-disconnect') {
      await Promise.resolve();
      throw new Error('Fake disconnect after acknowledgement.');
    }
    return {
      result: response.result,
      notificationFrames: frames.filter((candidate) => parseResponse(candidate)?.id !== id),
    };
  }

  async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    const frame = JSON.stringify({ method, params });
    await this.exchange(frame);
  }

  waitUntilTurnStarted(): Promise<void> {
    return this.turnStarted;
  }

  async waitForInterruption(
    signal: AbortSignal,
    threadId: string,
    turnId: string,
    onCancellationRequested: () => void,
  ): Promise<string[]> {
    if (!signal.aborted) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }
        if (signal.reason instanceof Error) reject(signal.reason);
      });
    }
    onCancellationRequested();
    try {
      const interrupted = await this.request('turn/interrupt', { threadId, turnId });
      return interrupted.notificationFrames;
    } catch {
      // Failure to parse a response or loss of the fake exchange cannot confirm termination.
      throw new SandboxError('termination_failed');
    }
  }

  private async exchange(frame: string): Promise<string[]> {
    if (Buffer.byteLength(frame, 'utf8') > MAX_FRAME_BYTES)
      throw new Error('Fake app-server frame exceeded its input bound.');
    let decoded: unknown;
    try {
      decoded = JSON.parse(frame);
    } catch {
      throw new Error('Fake app-server received malformed JSON.');
    }
    const request = RequestSchema.safeParse(decoded);
    if (!request.success) throw new Error('Fake app-server request did not match protocol bounds.');
    this.methods.push(request.data.method);

    if (request.data.method === 'initialized') return [];
    if (request.data.id === undefined) return [];

    const id = request.data.id;
    const params = request.data.params ?? {};
    let result: Record<string, unknown>;
    let notifications: FakeNotification[] = [];

    switch (request.data.method) {
      case 'initialize':
        result = { protocolVersion: 'fake-v1', capabilities: {} };
        break;
      case 'thread/start':
        this.threadId = 'thread-synthetic-0001';
        result = { thread: { id: this.threadId } };
        break;
      case 'turn/start':
        if (params.threadId !== this.threadId || !this.threadId)
          return [responseError(id, -32602, 'Unknown synthetic thread.')];
        this.turnSubmissionCount++;
        this.turnId = 'turn-synthetic-0001';
        this.turnStartedResolve?.();
        this.turnStartedResolve = undefined;
        result = { turn: { id: this.turnId } };
        if (this.mode === 'malformed-turn-frame') return [response(id, result), '{"method":'];
        notifications = this.turnNotifications();
        if (this.mode === 'turn-start-ack-lost')
          throw new Error('Fake lost turn/start acknowledgement after synthetic submission.');
        break;
      case 'turn/interrupt':
        if (params.threadId !== this.threadId || params.turnId !== this.turnId)
          return [responseError(id, -32602, 'Unknown synthetic turn.')];
        if (this.mode === 'pending-disconnect') {
          // Model an asynchronous exchange failure, not an actual process or transport.
          await Promise.resolve();
          throw new Error('Fake disconnect before acknowledgement.');
        }
        if (this.mode === 'pending-malformed-ack')
          return [
            '{"method":',
            JSON.stringify(
              notification('turn/completed', { turn: { id: this.turnId, status: 'interrupted' } }),
            ),
          ];
        if (this.mode === 'pending-invalid-ack')
          return [
            JSON.stringify({ id }),
            JSON.stringify(
              notification('turn/completed', { turn: { id: this.turnId, status: 'interrupted' } }),
            ),
          ];
        if (this.mode === 'pending-wrong-response-id')
          return [
            response(id + 1, {}),
            JSON.stringify(
              notification('turn/completed', { turn: { id: this.turnId, status: 'interrupted' } }),
            ),
          ];
        if (this.mode === 'pending-malformed-terminal') return [response(id, {}), '{"method":'];
        if (this.mode === 'pending-invalid-terminal')
          return [response(id, {}), JSON.stringify({ method: 'turn/completed', params: null })];
        result = {};
        notifications =
          this.mode === 'pending-unconfirmed-interrupt'
            ? []
            : [
                notification('turn/completed', {
                  turn: {
                    id: this.mode === 'pending-wrong-turn' ? 'turn-other' : this.turnId,
                    status: this.mode === 'pending-wrong-status' ? 'completed' : 'interrupted',
                  },
                }),
              ];
        break;
      default:
        return [responseError(id, -32601, 'Unsupported fake protocol method.')];
    }

    return [response(id, result), ...notifications.map((event) => JSON.stringify(event))];
  }

  private turnNotifications(): FakeNotification[] {
    if (this.mode.startsWith('pending')) return [];
    if (this.mode === 'crashed') throw new Error('Fake app-server process exited unexpectedly.');
    if (this.mode === 'timeout') throw new SandboxError('timed_out');
    if (this.mode === 'failed')
      return [notification('turn/completed', { turn: { id: this.turnId, status: 'failed' } })];
    if (this.mode === 'tool-request')
      return [
        notification('item/started', {
          threadId: this.threadId,
          turnId: this.turnId,
          item: { id: 'tool-item', type: 'commandExecution' },
        }),
      ];
    const start = notification('turn/started', {
      turn: { id: this.turnId, status: 'inProgress' },
    });
    const message = (
      id: string,
      phase: 'commentary' | 'partial_answer' | 'final_answer',
      text: string,
      deltas: readonly string[] = [text],
    ) => [
      notification('item/started', {
        threadId: this.threadId,
        turnId: this.turnId,
        item: { id, type: 'agentMessage', text: '', phase },
      }),
      ...deltas.map((delta) =>
        notification('item/agentMessage/delta', {
          threadId: this.threadId,
          turnId: this.turnId,
          itemId: id,
          delta,
        }),
      ),
      notification('item/completed', {
        threadId: this.threadId,
        turnId: this.turnId,
        item: { id, type: 'agentMessage', text, phase },
      }),
    ];
    if (this.mode === 'out-of-order-item')
      return [message('message-item', 'final_answer', 'Synthetic app-server result.')[0]!, start];
    if (this.mode === 'wrong-item-delta')
      return [
        start,
        message('message-item', 'final_answer', 'Synthetic app-server result.')[0]!,
        notification('item/agentMessage/delta', {
          threadId: this.threadId,
          turnId: this.turnId,
          itemId: 'other-item',
          delta: 'bad',
        }),
      ];
    const messages =
      this.mode === 'mixed-phases'
        ? [
            ...message('commentary-item', 'commentary', 'synthetic commentary'),
            ...message('partial-item', 'partial_answer', 'synthetic partial'),
            ...message('final-item-1', 'final_answer', 'Synthetic '),
            ...message('final-item-2', 'final_answer', 'app-server result.'),
          ]
        : message('message-item', 'final_answer', 'Synthetic app-server result.', [
            'Synthetic app-server ',
            'result.',
          ]);
    const terminal = notification('turn/completed', {
      turn: {
        id: this.turnId,
        status: 'completed',
        ...(this.mode === 'contradictory-terminal' ? { error: { message: 'contradiction' } } : {}),
      },
    });
    return [
      start,
      ...messages,
      terminal,
      ...(this.mode === 'duplicate-terminal' ? [terminal] : []),
    ];
  }
}

/** Test-only adapter: always remains `mock` and maps only fake protocol text to synthetic events. */
export class FakeCodexAppServerRuntimeAdapter implements RuntimeAdapter {
  readonly kind = 'mock' as const;
  readonly protocol: FakeCodexAppServerProtocol;

  constructor(options: { mode?: FakeMode } = {}) {
    this.protocol = new FakeCodexAppServerProtocol(options.mode);
  }

  discoverCapabilities(): RuntimeCapabilities {
    return {
      runtimeKind: 'mock',
      allowedUse: 'both',
      canStreamEvents: true,
      canCancel: true,
      canReportUsage: false,
      synthetic: true,
    };
  }

  async execute({
    task,
    signal,
    emit,
  }: Parameters<RuntimeAdapter['execute']>[0]): Promise<{ output: string }> {
    void task;
    await this.protocol.request('initialize', {
      clientInfo: { name: 'omnis-test-harness', title: 'Omnis OS Test Harness', version: '0' },
    });
    await this.protocol.notify('initialized');
    const thread = await this.protocol.request('thread/start', { model: 'synthetic-model' });
    const threadId = getNestedString(thread.result, 'thread', 'id');
    if (signal.aborted) throw new SandboxError('cancelled');

    const turnRequest = createOfflineTextTurnRequest(threadId, 'Synthetic test prompt only.');
    const turn = await this.protocol.request(turnRequest.method, turnRequest.params);
    const turnId = getNestedString(turn.result, 'turn', 'id');
    const projector = new OfflineCodexEventProjector({
      runId: 'run-synthetic-0001',
      operationId: '22222222-2222-4222-8222-222222222222',
      generation: 1,
      sessionId: threadId,
      threadId,
      turnId,
      maxOutputBytes: MAX_OUTPUT_CHARS,
    });
    let deliverySequence = 0;
    const projectFrames = (frames: readonly string[]) => {
      for (const frame of frames) {
        const sequence = ++deliverySequence;
        const projected = projector.accept({
          sequence,
          eventId: `fake-delivery-${sequence}`,
          frame,
        }).event;
        if (
          projected?.type === 'text_delta' &&
          projected.phase === 'final_answer' &&
          projected.message !== undefined
        )
          emit({ type: 'run.output', message: projected.message });
      }
    };

    projectFrames(turn.notificationFrames);
    if (projector.status === 'completed') {
      return { output: z.string().min(1).max(MAX_OUTPUT_CHARS).parse(projector.output) };
    }
    if (projector.status === 'failed') throw new Error('Fake app-server turn failed.');
    if (['cancelled'].includes(projector.status)) throw new SandboxError('cancelled');
    if (projector.status === 'interrupted') throw new SandboxError('termination_failed');

    const interruptionFrames = await this.protocol.waitForInterruption(
      signal,
      threadId,
      turnId,
      () => projector.requestCancellation(),
    );
    try {
      projectFrames(interruptionFrames);
    } catch {
      // A malformed or mismatched terminal frame cannot confirm cancellation.
      throw new SandboxError('termination_failed');
    }
    if (['cancelled'].includes(projector.status)) throw new SandboxError('cancelled');
    throw new SandboxError('termination_failed');
  }
}

function getNestedString(value: Record<string, unknown>, parent: string, key: string): string {
  const result = z
    .string()
    .min(1)
    .max(128)
    .safeParse((value[parent] as Record<string, unknown> | undefined)?.[key]);
  if (!result.success) throw new Error('Fake app-server returned an invalid identity.');
  return result.data;
}

function parseResponse(frame: string): z.infer<typeof ResponseSchema> | null {
  try {
    const parsed = ResponseSchema.safeParse(JSON.parse(frame));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function response(id: number, result: Record<string, unknown>): string {
  return JSON.stringify({ id, result });
}

function responseError(id: number, code: number, message: string): string {
  return JSON.stringify({ id, error: { code, message } });
}

function notification(method: string, params: Record<string, unknown>): FakeNotification {
  return NotificationSchema.parse({ method, params });
}
