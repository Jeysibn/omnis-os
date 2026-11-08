import { RunEventSchema, type RunEvent } from '@omnis/contracts';

const terminalTypes = new Set(['run.completed', 'run.cancelled', 'run.failed', 'run.interrupted']);

export interface RunEventSource {
  subscribe(runId: string, listener: () => void): () => void;
  getEvents(runId: string, afterSequence: number): Promise<RunEvent[]>;
}

/** Subscribe first, then repeatedly fill the sequence from PostgreSQL before delivery. */
export function streamPersistedRunEvents(input: {
  source: RunEventSource;
  runId: string;
  afterSequence: number;
  send: (event: RunEvent) => void;
  end: () => void;
  fail: (error: unknown) => void;
}): () => void {
  let cursor = input.afterSequence;
  let requested = false;
  let draining = false;
  let stopped = false;

  const unsubscribe = input.source.subscribe(input.runId, drain);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
  };

  function drain(): void {
    requested = true;
    if (draining || stopped) return;
    draining = true;
    void (async () => {
      try {
        while (requested && !stopped) {
          requested = false;
          const persisted = await input.source.getEvents(input.runId, cursor);
          for (const value of persisted) {
            const event = RunEventSchema.parse(value);
            if (event.runId !== input.runId) throw new Error('Persisted event run ID mismatch.');
            if (event.sequence <= cursor) continue;
            if (event.sequence !== cursor + 1) {
              throw new Error('Persisted event sequence contains a gap.');
            }
            cursor = event.sequence;
            input.send(event);
            if (terminalTypes.has(event.type)) {
              stop();
              input.end();
              break;
            }
          }
        }
      } catch (error) {
        stop();
        input.fail(error);
      } finally {
        draining = false;
        if (requested && !stopped) drain();
      }
    })();
  }

  drain();
  return stop;
}
