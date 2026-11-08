import type { LocalSession, LocalSessionStore } from './session-store.ts';

export type StreamExpiryScheduler = (delayMs: number, expire: () => void) => () => void;

const maxActiveStreams = 128;
const maxStreamsPerSession = 8;

const scheduleExpiry: StreamExpiryScheduler = (delayMs, expire) => {
  const timer = setTimeout(expire, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
};

export class RunEventStreamRegistry {
  private readonly sessions: LocalSessionStore;
  private readonly now: () => number;
  private readonly scheduleExpiry: StreamExpiryScheduler;
  private readonly globalLimit: number;
  private readonly sessionLimit: number;
  private readonly bySession = new Map<string, Set<() => void>>();
  private active = 0;

  constructor(input: {
    sessions: LocalSessionStore;
    now?: () => number;
    scheduleExpiry?: StreamExpiryScheduler;
    globalLimit?: number;
    sessionLimit?: number;
  }) {
    this.sessions = input.sessions;
    this.now = input.now ?? Date.now;
    this.scheduleExpiry = input.scheduleExpiry ?? scheduleExpiry;
    this.globalLimit = input.globalLimit ?? maxActiveStreams;
    this.sessionLimit = input.sessionLimit ?? maxStreamsPerSession;
    if (
      !Number.isInteger(this.globalLimit) ||
      this.globalLimit < 1 ||
      !Number.isInteger(this.sessionLimit) ||
      this.sessionLimit < 1
    ) {
      throw new Error('Run event stream limits must be positive integers.');
    }
  }

  get size(): number {
    return this.active;
  }

  acquire(
    session: LocalSession,
    onInvalidated: () => void,
  ):
    | { acquired: true; release: () => void }
    | { acquired: false; reason: 'session_invalid' | 'stream_limit' } {
    if (!this.sessions.isOwnerActive(session.id))
      return { acquired: false, reason: 'session_invalid' };
    const sessionStreams = this.bySession.get(session.id);
    if (this.active >= this.globalLimit || (sessionStreams?.size ?? 0) >= this.sessionLimit) {
      return { acquired: false, reason: 'stream_limit' };
    }

    let closed = false;
    let unsubscribe = () => {};
    let cancelExpiry = () => {};
    const streams = sessionStreams ?? new Set<() => void>();
    if (!sessionStreams) this.bySession.set(session.id, streams);
    this.active++;
    const release = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      cancelExpiry();
      streams.delete(release);
      if (streams.size === 0) this.bySession.delete(session.id);
      this.active--;
    };
    const invalidate = () => {
      if (closed) return;
      release();
      onInvalidated();
    };
    streams.add(release);
    unsubscribe = this.sessions.onInvalidated(session.id, invalidate);
    if (closed) return { acquired: true, release };
    const cancel = this.scheduleExpiry(Math.max(0, session.expiresAt - this.now()), () => {
      this.sessions.isOwnerActive(session.id);
      invalidate();
    });
    cancelExpiry = cancel;
    if (closed) cancelExpiry();
    return { acquired: true, release };
  }
}
