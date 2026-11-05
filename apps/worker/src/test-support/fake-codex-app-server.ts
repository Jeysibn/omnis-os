import { z } from 'zod';
import type { RuntimeCapabilities } from '@omnis/contracts';
import type { RuntimeAdapter } from '@omnis/runtime-adapters';
import { SandboxError } from '@omnis/runtime-adapters/sandbox-error';

const MAX_FRAME_BYTES = 16_384;
const MAX_OUTPUT_CHARS = 2_000;
const RequestSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.number().int().positive().optional(),
    method: z.string().min(1).max(100),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const ResponseSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
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
    jsonrpc: z.literal('2.0'),
    method: z.string().min(1).max(100),
    params: z.record(z.string(), z.unknown()),
  })
  .strict();

type FakeMode = 'complete' | 'tool-request' | 'pending' | 'failed' | 'crashed' | 'timeout';
type Notification = z.infer<typeof NotificationSchema>;

/** In-process protocol fixture. It has no child-process, network, or credential interface. */
export class FakeCodexAppServerProtocol {
  readonly transport = 'in-process' as const;
  readonly usesCredentials = false as const;
  readonly launchesNativeProcess = false as const;
  readonly methods: string[] = [];
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
    notifications: Notification[];
  }> {
    const id = ++this.nextId;
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const frames = await this.exchange(frame);
    const response = frames.map(parseResponse).find((candidate) => candidate?.id === id);
    if (!response) throw new Error('Fake protocol response did not match request id.');
    if (response.error) throw new Error('Fake app-server rejected the protocol request.');
    return {
      result: response.result ?? {},
      notifications: frames
        .map(parseNotification)
        .filter((value): value is Notification => value !== null),
    };
  }

  async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    const frame = JSON.stringify({ jsonrpc: '2.0', method, params });
    await this.exchange(frame);
  }

  waitUntilTurnStarted(): Promise<void> {
    return this.turnStarted;
  }

  async waitForInterruption(signal: AbortSignal, threadId: string, turnId: string): Promise<never> {
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
    const interrupted = await this.request('turn/interrupt', { threadId, turnId });
    if (interrupted.result.interrupted !== true) throw new SandboxError('termination_failed');
    throw new SandboxError('cancelled');
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
    let notifications: Notification[] = [];

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
        this.turnId = 'turn-synthetic-0001';
        this.turnStartedResolve?.();
        this.turnStartedResolve = undefined;
        result = { turn: { id: this.turnId } };
        notifications = this.turnNotifications();
        break;
      case 'turn/interrupt':
        if (params.threadId !== this.threadId || params.turnId !== this.turnId)
          return [responseError(id, -32602, 'Unknown synthetic turn.')];
        result = { interrupted: true };
        notifications = [
          notification('turn/completed', { turnId: this.turnId, status: 'interrupted' }),
        ];
        break;
      default:
        return [responseError(id, -32601, 'Unsupported fake protocol method.')];
    }

    return [response(id, result), ...notifications.map((event) => JSON.stringify(event))];
  }

  private turnNotifications(): Notification[] {
    if (this.mode === 'pending') return [];
    if (this.mode === 'crashed') throw new Error('Fake app-server process exited unexpectedly.');
    if (this.mode === 'timeout') throw new SandboxError('timed_out');
    if (this.mode === 'failed')
      return [notification('turn/completed', { turnId: this.turnId, status: 'failed' })];
    if (this.mode === 'tool-request')
      return [notification('item/commandExecution/requestApproval', { turnId: this.turnId })];
    return [
      notification('item/agentMessage/delta', {
        turnId: this.turnId,
        delta: 'Synthetic app-server delta 1.',
      }),
      notification('item/agentMessage/delta', {
        turnId: this.turnId,
        delta: 'Synthetic app-server delta 2.',
      }),
      notification('turn/completed', {
        turnId: this.turnId,
        status: 'completed',
        output: 'Synthetic app-server result.',
      }),
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

    const turn = await this.protocol.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'Synthetic test prompt only.' }],
    });
    const turnId = getNestedString(turn.result, 'turn', 'id');
    let output: string | undefined;
    for (const event of turn.notifications) {
      const params = event.params;
      if (params.turnId !== turnId) throw new Error('Fake event turn identity did not match.');
      if (event.method === 'item/agentMessage/delta') {
        const delta = z.string().min(1).max(MAX_OUTPUT_CHARS).parse(params.delta);
        emit({ type: 'run.output', message: delta });
        continue;
      }
      if (event.method === 'turn/completed') {
        if (params.status !== 'completed')
          throw new Error('Fake app-server turn did not complete.');
        output = z.string().min(1).max(MAX_OUTPUT_CHARS).parse(params.output);
        continue;
      }
      // Tool requests, unknown capabilities, and unsolicited control events are never trusted.
      throw new Error('Fake app-server emitted a disallowed event.');
    }
    if (output) return { output };
    return this.protocol.waitForInterruption(signal, threadId, turnId);
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

function parseNotification(frame: string): Notification | null {
  try {
    const parsed = NotificationSchema.safeParse(JSON.parse(frame));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function response(id: number, result: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function responseError(id: number, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

function notification(method: string, params: Record<string, unknown>): Notification {
  return NotificationSchema.parse({ jsonrpc: '2.0', method, params });
}
