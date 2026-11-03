import { request } from 'node:http';
import { z } from 'zod';
import { SandboxError } from '@omnis/runtime-adapters/sandbox-error';

const ResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), stdout: z.string(), stderr: z.string(), exitCode: z.number() }),
  z.object({
    ok: z.literal(false),
    error: z.enum([
      'timed_out',
      'cancelled',
      'unavailable',
      'crashed',
      'output_limit',
      'launch_failed',
      'termination_failed',
    ]),
  }),
]);

export interface MockSandboxLauncherClient {
  execute(input: {
    runId: string;
    workerId: string;
    generation: number;
    signal: AbortSignal;
  }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export class UnixMockSandboxLauncherClient implements MockSandboxLauncherClient {
  private readonly socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
    if (!socketPath.startsWith('/'))
      throw new Error('Sandbox launcher socket path must be absolute.');
  }

  execute(input: {
    runId: string;
    workerId: string;
    generation: number;
    signal: AbortSignal;
  }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        runId: input.runId,
        workerId: input.workerId,
        generation: input.generation,
      });
      const req = request(
        {
          socketPath: this.socketPath,
          path: '/internal/v1/mock-executions',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
        },
        (response) => {
          let data = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            data += chunk;
            if (data.length > 72 * 1024) req.destroy(new Error('launcher_response_too_large'));
          });
          response.once('end', () => {
            let payload: unknown;
            try {
              payload = JSON.parse(data);
            } catch {
              return reject(new SandboxError('unavailable'));
            }
            const parsed = ResponseSchema.safeParse(payload);
            if (!parsed.success) return reject(new SandboxError('unavailable'));
            if (!parsed.data.ok) return reject(new SandboxError(parsed.data.error));
            if ((response.statusCode ?? 500) >= 400) return reject(new SandboxError('unavailable'));
            resolve({
              stdout: parsed.data.stdout,
              stderr: parsed.data.stderr,
              exitCode: parsed.data.exitCode,
            });
          });
        },
      );
      const abort = () => req.destroy(new SandboxError('cancelled'));
      input.signal.addEventListener('abort', abort, { once: true });
      req.once('close', () => input.signal.removeEventListener('abort', abort));
      req.once('error', (error) =>
        reject(error instanceof SandboxError ? error : new SandboxError('unavailable')),
      );
      req.setTimeout(35_000, () => req.destroy(new SandboxError('unavailable')));
      if (input.signal.aborted) abort();
      req.end(body);
    });
  }
}
