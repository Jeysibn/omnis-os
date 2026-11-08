import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it } from 'node:test';
import type { RunEvent } from '@omnis/contracts';
import { streamPersistedRunEvents, type RunEventSource } from './reliable-event-stream.ts';

const event = (sequence: number, type: RunEvent['type'] = 'run.output'): RunEvent => ({
  id: `evt-run-0001-${String(sequence).padStart(4, '0')}`,
  runId: 'run-0001',
  sequence,
  at: '2026-11-02T00:00:00.000Z',
  type,
  source: 'mock',
  synthetic: true,
  message: `event ${sequence}`,
});

class MemoryEventSource implements RunEventSource {
  readonly events: RunEvent[] = [];
  readonly listeners = new Set<() => void>();
  replayStarted: (() => void) | undefined;
  replayGate: Promise<void> | undefined;

  subscribe(_runId: string, listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async getEvents(_runId: string, after: number): Promise<RunEvent[]> {
    this.replayStarted?.();
    if (this.replayGate) await this.replayGate;
    return this.events
      .filter((item) => item.sequence > after)
      .sort((a, b) => a.sequence - b.sequence);
  }

  publish(item: RunEvent): void {
    this.events.push(item);
    for (const listener of this.listeners) listener();
  }
}

async function settle(): Promise<void> {
  await delay(0);
}

describe('persisted SSE replay and live delivery', () => {
  it('fills replay before delivering a live event published during replay', async () => {
    const source = new MemoryEventSource();
    source.events.push(event(1), event(2));
    let release!: () => void;
    source.replayGate = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const replayStarted = new Promise<void>((resolve) => (started = resolve));
    source.replayStarted = started;
    const delivered: number[] = [];
    const stop = streamPersistedRunEvents({
      source,
      runId: 'run-0001',
      afterSequence: 0,
      send: (item) => delivered.push(item.sequence),
      end: () => {},
      fail: (error) => assert.fail(String(error)),
    });
    await replayStarted;
    source.replayGate = undefined;
    source.publish(event(3));
    release();
    await settle();
    assert.deepEqual(delivered, [1, 2, 3]);
    stop();
  });

  it('recovers out-of-order publication from the database sequence and emits terminal last', async () => {
    const source = new MemoryEventSource();
    const delivered: number[] = [];
    let ended = 0;
    const stop = streamPersistedRunEvents({
      source,
      runId: 'run-0001',
      afterSequence: 0,
      send: (item) => delivered.push(item.sequence),
      end: () => ended++,
      fail: (error) => assert.fail(String(error)),
    });
    source.events.push(event(1), event(2), event(3, 'run.completed'));
    source.publish(event(3, 'run.completed'));
    source.publish(event(1));
    source.publish(event(2));
    await settle();
    assert.deepEqual(delivered, [1, 2, 3]);
    assert.equal(ended, 1);
    stop();
  });

  it('reconstructs full persisted history on reconnect from Last-Event-ID', async () => {
    const source = new MemoryEventSource();
    source.events.push(event(1), event(2), event(3, 'run.completed'));
    const delivered: number[] = [];
    streamPersistedRunEvents({
      source,
      runId: 'run-0001',
      afterSequence: 0,
      send: (item) => delivered.push(item.sequence),
      end: () => {},
      fail: (error) => assert.fail(String(error)),
    });
    await settle();
    assert.deepEqual(delivered, [1, 2, 3]);
  });

  it('keeps unknown observable until authoritative reconciliation arrives', async () => {
    const source = new MemoryEventSource();
    const unknown = event(1, 'run.outcome_unknown');
    source.events.push(unknown);
    const delivered: RunEvent[] = [];
    let ended = 0;
    streamPersistedRunEvents({
      source,
      runId: 'run-0001',
      afterSequence: 0,
      send: (item) => delivered.push(item),
      end: () => ended++,
      fail: (error) => assert.fail(String(error)),
    });
    await settle();
    assert.deepEqual(
      delivered.map((item) => item.type),
      ['run.outcome_unknown'],
    );
    assert.equal(ended, 0);
    source.publish(event(2, 'run.completed'));
    await settle();
    assert.deepEqual(
      delivered.map((item) => item.type),
      ['run.outcome_unknown', 'run.completed'],
    );
    assert.equal(ended, 1);
  });
});
