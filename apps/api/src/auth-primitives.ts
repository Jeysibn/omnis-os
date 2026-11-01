import { randomBytes, timingSafeEqual } from 'node:crypto';

export function createCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

export function isSameOrigin(origin: string | undefined, allowedOrigin: string): boolean {
  return origin === allowedOrigin;
}

export function csrfTokenMatches(
  supplied: string | undefined,
  expected: string | undefined,
): boolean {
  if (!supplied || !expected) return false;
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return (
    suppliedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(suppliedBuffer, expectedBuffer)
  );
}
