type SessionStream = { controller: AbortController };

/** Process-local caps. The supported deployment currently runs one API service instance. */
export class MissionEventStreamRegistry {
  private readonly sessions = new Map<string, Set<SessionStream>>();
  private count = 0;
  private readonly perSession: number;
  private readonly global: number;

  constructor(perSession = 4, global = 16) {
    if (!Number.isInteger(perSession) || perSession < 1 || !Number.isInteger(global) || global < 1)
      throw new Error('Mission event stream caps must be positive integers.');
    this.perSession = perSession;
    this.global = global;
  }

  acquire(sessionId: string, controller: AbortController): (() => void) | undefined {
    const existing = this.sessions.get(sessionId);
    if (this.count >= this.global || (existing?.size ?? 0) >= this.perSession) return undefined;
    const stream = { controller };
    const sessionStreams = existing ?? new Set<SessionStream>();
    sessionStreams.add(stream);
    this.sessions.set(sessionId, sessionStreams);
    this.count += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      sessionStreams.delete(stream);
      if (sessionStreams.size === 0) this.sessions.delete(sessionId);
      this.count -= 1;
    };
  }

  revokeSession(sessionId: string): void {
    for (const stream of this.sessions.get(sessionId) ?? []) stream.controller.abort();
  }

  get activeCount(): number {
    return this.count;
  }
}
