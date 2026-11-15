import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface LocalSession {
  id: string;
  owner: boolean;
  csrfToken: string;
  expiresAt: number;
}

const cookieName = 'omnis_session';
const defaultMaxAgeSeconds = 8 * 60 * 60;

export class LocalSessionStore {
  private readonly maxSessions: number;
  private readonly now: () => number;
  private readonly sessions = new Map<string, LocalSession>();
  private readonly invalidationListeners = new Map<string, Set<() => void>>();
  private readonly secret: string;
  private readonly secureCookies: boolean;
  private readonly maxAgeSeconds: number;

  constructor(
    secret: string,
    secureCookies: boolean,
    maxSessions = 1024,
    now: () => number = Date.now,
    maxAgeSeconds = defaultMaxAgeSeconds,
  ) {
    if (secret.length < 64) throw new Error('Session secret must be at least 64 characters.');
    if (!Number.isInteger(maxSessions) || maxSessions < 1)
      throw new Error('Session capacity must be positive.');
    if (
      !Number.isInteger(maxAgeSeconds) ||
      maxAgeSeconds < 1 ||
      maxAgeSeconds > defaultMaxAgeSeconds
    ) {
      throw new Error('Session lifetime must be between one second and eight hours.');
    }
    this.secret = secret;
    this.secureCookies = secureCookies;
    this.maxSessions = maxSessions;
    this.now = now;
    this.maxAgeSeconds = maxAgeSeconds;
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
        if (existing && existing.expiresAt > this.now())
          return { session: existing, setCookie: false };
        if (existing) this.invalidate(id);
      }
    }
    if (!createAnonymous) return { setCookie: false };
    const session = this.create(false);
    return session ? { session, setCookie: true } : { setCookie: false };
  }

  rotate(previousId: string): LocalSession | undefined {
    this.invalidate(previousId);
    return this.create(true);
  }

  destroy(id: string): void {
    this.invalidate(id);
  }

  isOwnerActive(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.expiresAt <= this.now()) {
      this.invalidate(id);
      return false;
    }
    return session.owner;
  }

  onInvalidated(id: string, listener: () => void): () => void {
    if (!this.isOwnerActive(id)) {
      listener();
      return () => {};
    }
    let listeners = this.invalidationListeners.get(id);
    if (!listeners) {
      listeners = new Set();
      this.invalidationListeners.set(id, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.invalidationListeners.delete(id);
    };
  }

  cookie(session: LocalSession): string {
    const token = `${session.id}.${this.sign(session.id)}`;
    return `${cookieName}=${token}; Path=/; Max-Age=${this.maxAgeSeconds}; HttpOnly; SameSite=Strict${this.secureCookies ? '; Secure' : ''}`;
  }

  clearCookie(): string {
    return `${cookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${this.secureCookies ? '; Secure' : ''}`;
  }

  private create(owner: boolean): LocalSession | undefined {
    this.removeExpired(this.now());
    if (this.sessions.size >= this.maxSessions) {
      const oldestAnonymous = [...this.sessions].find(([, session]) => !session.owner)?.[0];
      if (oldestAnonymous) this.invalidate(oldestAnonymous);
      else return undefined;
    }
    const id = randomBytes(32).toString('base64url');
    const session: LocalSession = {
      id,
      owner,
      csrfToken: randomBytes(32).toString('base64url'),
      expiresAt: this.now() + this.maxAgeSeconds * 1000,
    };
    this.sessions.set(id, session);
    return session;
  }

  private removeExpired(now = this.now()): void {
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.invalidate(id);
    }
  }

  private invalidate(id: string): void {
    this.sessions.delete(id);
    const listeners = this.invalidationListeners.get(id);
    if (!listeners) return;
    this.invalidationListeners.delete(id);
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // One failed stream cleanup must not prevent other streams from closing.
      }
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
