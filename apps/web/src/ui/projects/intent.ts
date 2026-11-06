/**
 * One idempotency key per distinct user intent.
 *
 * A key is reused only when the identical request is deliberately sent again after an outcome
 * that could not be determined, because the server then replays the stored result instead of
 * applying the change twice. Any change to the request, or a definite outcome, ends the intent:
 * the next submit gets a new key.
 */
export class IdempotentIntent {
  private current: { signature: string; key: string; uncertain: boolean } | null = null;

  /** The key to send for this exact request. */
  keyFor(signature: string): string {
    const current = this.current;
    if (current && current.uncertain && current.signature === signature) return current.key;
    const key = crypto.randomUUID();
    this.current = { signature, key, uncertain: false };
    return key;
  }

  /** The outcome could not be determined: the same request may be retried with the same key. */
  markUncertain(): void {
    if (this.current) this.current.uncertain = true;
  }

  /** The outcome is known (confirmed or definitively rejected): never reuse this key. */
  settle(): void {
    this.current = null;
  }
}
