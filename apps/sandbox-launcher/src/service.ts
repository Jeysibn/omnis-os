import Fastify from 'fastify';
import { z } from 'zod';
import { SandboxError } from '@omnis/runtime-adapters/sandbox-error';

export interface FixedMockExecutor {
  execute(input: {
    runId: string;
    argv: readonly string[];
    stdin: string;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

const RequestSchema = z
  .object({
    runId: z.string().regex(/^run-[0-9]{4,}$/),
    workerId: z.string().uuid(),
    generation: z.number().int().positive(),
  })
  .strict();

function createMockProgram(delayMs: number): string {
  return `
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', async () => {
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof input.title !== 'string' || input.title.length > 120) process.exit(2);
    const emit = (message) => process.stdout.write(JSON.stringify({ type: 'run.output', message }) + '\\n');
    await new Promise((resolve) => setTimeout(resolve, ${delayMs}));
    emit('Mock runtime accepted the task. No provider was contacted.');
    await new Promise((resolve) => setTimeout(resolve, ${delayMs}));
    emit('Synthetic result for “' + input.title + '”: the mock lifecycle completed. This is not provider evidence.');
  } catch { process.exitCode = 2; }
});
`;
}

export function createSandboxLauncherApp(input: {
  executor: FixedMockExecutor;
  authorize: (runId: string, workerId: string, generation: number) => Promise<string | undefined>;
  checkDatabase: () => Promise<void>;
  testDelayMs?: number;
}) {
  const testDelayMs = input.testDelayMs ?? 500;
  if (!Number.isInteger(testDelayMs) || testDelayMs < 0 || testDelayMs > 5_000) {
    throw new Error('Sandbox launcher test delay must be an integer from 0 to 5000 ms.');
  }
  const mockProgram = createMockProgram(testDelayMs);
  const app = Fastify({ logger: true, bodyLimit: 4096 });
  app.get('/health', async (_request, reply) => {
    try {
      await input.checkDatabase();
      return { status: 'ok', product: 'Omnis OS', service: 'sandbox-launcher', synthetic: true };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
  app.post('/internal/v1/mock-executions', async (request, reply) => {
    const parsed = RequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'launch_failed' });
    const { runId, workerId, generation } = parsed.data;
    try {
      const title = await input.authorize(runId, workerId, generation);
      if (typeof title !== 'string')
        return reply.code(409).send({ ok: false, error: 'launch_failed' });
      const controller = new AbortController();
      request.raw.once('aborted', () => controller.abort());
      reply.raw.once('close', () => {
        if (!reply.raw.writableEnded) controller.abort();
      });
      const result = await input.executor.execute({
        runId,
        argv: ['node', '-e', mockProgram],
        stdin: JSON.stringify({ title }),
        timeoutMs: 8_000,
        signal: controller.signal,
      });
      return { ok: true, ...result };
    } catch (error) {
      const code = error instanceof SandboxError ? error.code : 'unavailable';
      return reply.code(code === 'cancelled' ? 409 : 503).send({ ok: false, error: code });
    }
  });
  return app;
}
