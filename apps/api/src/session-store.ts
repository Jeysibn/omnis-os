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
  private readonly maxSessions: number;
  private readonly now: () => number;
  private readonly sessions = new Map<string, LocalSession>();
  private readonly secret: string;
  private readonly secureCookies: boolean;

  constructor(
    secret: string,
    secureCookies: boolean,
    maxSessions = 1024,
    now: () => number = Date.now,
  ) {
    if (secret.length < 64) throw new Error('Session secret must be at least 64 characters.');
    if (!Number.isInteger(maxSessions) || maxSessions < 1)
      throw new Error('Session capacity must be positive.');
    this.secret = secret;
    this.secureCookies = secureCookies;
    this.maxSessions = maxSessions;
    this.now = now;
  }

  get size(): number {
    this.removeExpired(this.now());
    return this.sessions.size;
  }

  resolve(
    cookieHeader: string | undefined,
    createAnonymous = true,
  ): { session?: LocalSession; setCookie: boolean } {
    this.removeExpired(this.now());
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
    if (!createAnonymous) return { setCookie: false };
    const session = this.create(false);
    return session ? { session, setCookie: true } : { setCookie: false };
  }

  rotate(previousId: string): LocalSession | undefined {
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

  private create(owner: boolean): LocalSession | undefined {
    this.removeExpired(this.now());
    if (this.sessions.size >= this.maxSessions) {
      const oldestAnonymous = [...this.sessions].find(([, session]) => !session.owner)?.[0];
      if (oldestAnonymous) this.sessions.delete(oldestAnonymous);
      else return undefined;
    }
    const id = randomBytes(32).toString('base64url');
    const session: LocalSession = {
      id,
      owner,
      csrfToken: randomBytes(32).toString('base64url'),
      expiresAt: this.now() + maxAgeSeconds * 1000,
    };
    this.sessions.set(id, session);
    return session;
  }

  private removeExpired(now = Date.now()): void {
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
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
