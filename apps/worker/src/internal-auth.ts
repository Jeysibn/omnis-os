import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

export function registerWorkerInternalAuthentication(
  app: FastifyInstance,
  internalToken: string,
): void {
  app.addHook('preHandler', async (request, reply) => {
    const supplied = request.headers['x-omnis-internal-token'];
    const candidate = typeof supplied === 'string' ? Buffer.from(supplied) : Buffer.alloc(0);
    const expected = Buffer.from(internalToken);
    const matches = candidate.length === expected.length && timingSafeEqual(candidate, expected);
    if (!matches) {
      return reply.code(401).send({
        error: { code: 'unauthorized', message: 'Internal worker authentication failed.' },
      });
    }
  });
}
