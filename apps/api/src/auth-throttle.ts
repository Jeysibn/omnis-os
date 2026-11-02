interface AttemptState {
  failures: number;
  blockedUntil: number;
  updatedAt: number;
}

export class AuthThrottle {
  private readonly clients = new Map<string, AttemptState>();
  private inFlight = 0;
  private readonly maxConcurrent: number;
  private readonly maxClients: number;
  private readonly failureThreshold: number;

  constructor(maxConcurrent = 4, maxClients = 2048, failureThreshold = 5) {
    if (
      ![maxConcurrent, maxClients, failureThreshold].every(
        (value) => Number.isInteger(value) && value > 0,
      )
    ) {
      throw new Error('Authentication throttle limits must be positive integers.');
    }
    this.maxConcurrent = maxConcurrent;
    this.maxClients = maxClients;
    this.failureThreshold = failureThreshold;
  }

  begin(
    clientKey: string,
    now = Date.now(),
  ): { release: () => void } | { retryAfterSeconds: number } {
    this.prune(now);
    const existing = this.clients.get(clientKey);
    if (existing && existing.blockedUntil > now) {
      return { retryAfterSeconds: Math.max(1, Math.ceil((existing.blockedUntil - now) / 1000)) };
    }
    if (this.inFlight >= this.maxConcurrent) return { retryAfterSeconds: 1 };
    if (!existing && this.clients.size >= this.maxClients) return { retryAfterSeconds: 1 };
    this.inFlight += 1;
    this.clients.set(clientKey, existing ?? { failures: 0, blockedUntil: 0, updatedAt: now });
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.inFlight -= 1;
      },
    };
  }

  failed(clientKey: string, now = Date.now()): void {
    this.prune(now);
    const state = this.clients.get(clientKey) ?? { failures: 0, blockedUntil: 0, updatedAt: now };
    state.failures += 1;
    state.updatedAt = now;
    if (state.failures >= this.failureThreshold) {
      const exponent = Math.min(state.failures - this.failureThreshold, 8);
      state.blockedUntil = now + Math.min(5 * 60_000, 1_000 * 2 ** exponent);
    }
    if (this.clients.size < this.maxClients || this.clients.has(clientKey))
      this.clients.set(clientKey, state);
  }

  succeeded(clientKey: string): void {
    this.clients.delete(clientKey);
  }

  private prune(now: number): void {
    for (const [key, state] of this.clients) {
      if (state.blockedUntil <= now && now - state.updatedAt > 10 * 60_000)
        this.clients.delete(key);
    }
  }
}
