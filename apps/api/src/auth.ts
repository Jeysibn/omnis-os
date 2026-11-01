import { scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from './env.ts';
import { csrfTokenMatches, isSameOrigin } from './auth-primitives.ts';
import type { LocalSession } from './session-store.ts';

const scrypt = promisify(scryptCallback);
const LoginSchema = z.object({ password: z.string().min(1).max(512) });

export function verifyOrigin(request: FastifyRequest): boolean {
  return isSameOrigin(request.headers.origin, env.allowedOrigin);
}

export function verifyCsrf(request: FastifyRequest): boolean {
  const header = request.headers['x-omnis-csrf'];
  return csrfTokenMatches(
    typeof header === 'string' ? header : undefined,
    request.omnisSession?.csrfToken,
  );
}

export async function isOwnerPasswordValid(candidate: unknown): Promise<boolean> {
  const parsed = LoginSchema.safeParse({ password: candidate });
  if (!parsed.success) return false;
  const [saltHex, expectedHex] = env.ownerPasswordHash.split(':');
  if (!saltHex || !expectedHex) return false;
  const derived = (await scrypt(parsed.data.password, Buffer.from(saltHex, 'hex'), 64)) as Buffer;
  const expected = Buffer.from(expectedHex, 'hex');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export async function requireOwner(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.omnisSession?.owner !== true) {
    await reply
      .code(401)
      .send({ error: { code: 'unauthorized', message: 'Sign in to continue.' } });
  }
}

export async function requireMutationProtection(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!verifyOrigin(request) || !verifyCsrf(request)) {
    await reply.code(403).send({
      error: { code: 'csrf_rejected', message: 'Refresh the page and retry the action.' },
    });
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    omnisSession?: LocalSession;
  }
}
