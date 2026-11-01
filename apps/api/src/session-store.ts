import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface LocalSession {
  id: string;
  owner: boolean;
  csrfToken: string;
  expiresAt: number;
}

const cookieName = 'omnis_session';
const maxAgeSeconds = 8 * 60 * 60;

export class LocalSessionStore {
  private readonly sessions = new Map<string, LocalSession>();
  private readonly secret: string;
  private readonly secureCookies: boolean;

  constructor(secret: string, secureCookies: boolean) {
    if (secret.length < 64) throw new Error('Session secret must be at least 64 characters.');
    this.secret = secret;
    this.secureCookies = secureCookies;
  }

  resolve(cookieHeader: string | undefined): { session: LocalSession; setCookie: boolean } {
    const token = this.readCookie(cookieHeader);
    if (token) {
      const [id, signature] = token.split('.');
      const expected = id ? this.sign(id) : '';
      const suppliedBuffer = Buffer.from(signature ?? '');
      const expectedBuffer = Buffer.from(expected);
      if (
        id &&
        suppliedBuffer.length === expectedBuffer.length &&
        timingSafeEqual(suppliedBuffer, expectedBuffer)
      ) {
        const existing = this.sessions.get(id);
        if (existing && existing.expiresAt > Date.now())
          return { session: existing, setCookie: false };
        if (existing) this.sessions.delete(id);
      }
    }
    return { session: this.create(false), setCookie: true };
  }

  rotate(previousId: string): LocalSession {
    this.sessions.delete(previousId);
    return this.create(true);
  }

  destroy(id: string): void {
    this.sessions.delete(id);
  }

  cookie(session: LocalSession): string {
    const token = `${session.id}.${this.sign(session.id)}`;
    return `${cookieName}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Strict${this.secureCookies ? '; Secure' : ''}`;
  }

  clearCookie(): string {
    return `${cookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${this.secureCookies ? '; Secure' : ''}`;
  }

  private create(owner: boolean): LocalSession {
    const id = randomBytes(32).toString('base64url');
    const session: LocalSession = {
      id,
      owner,
      csrfToken: randomBytes(32).toString('base64url'),
      expiresAt: Date.now() + maxAgeSeconds * 1000,
    };
    this.sessions.set(id, session);
    return session;
  }

  private readCookie(header: string | undefined): string | undefined {
    if (!header) return undefined;
    for (const part of header.split(';')) {
      const [name, ...value] = part.trim().split('=');
      if (name === cookieName) return value.join('=');
    }
    return undefined;
  }

  private sign(id: string): string {
    return createHmac('sha256', this.secret).update(id).digest('base64url');
  }
}
