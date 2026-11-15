import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  OfflineCodexEventProjector,
  classifyAppServerFailure,
  createOfflineTextTurnRequest,
  normalizeOfflineUsage,
  transitionProviderOperation,
  type ProviderOperationStatus,
} from './codex-app-server-contract.ts';

const context = {
  runId: 'run-0001',
  operationId: '11111111-1111-4111-8111-111111111111',
  generation: 1,
  sessionId: 'session-synthetic-1',
  threadId: 'thread-synthetic-1',
  turnId: 'turn-synthetic-1',
  maxOutputBytes: 16,
};

const frame = (method: string, params: unknown): string => JSON.stringify({ method, params });
const delivery = (sequence: number, eventId: string, raw: string) => ({
  sequence,
  eventId,
  frame: raw,
});

describe('offline Codex app-server contract fixtures', () => {
  it('constructs a bounded text-only request fixture without tool configuration', () => {
    assert.deepEqual(createOfflineTextTurnRequest(context.threadId, 'synthetic prompt'), {
      method: 'turn/start',
      params: { threadId: context.threadId, input: [{ type: 'text', text: 'synthetic prompt' }] },
    });
    assert.throws(() => createOfflineTextTurnRequest(context.threadId, ''));
    assert.throws(() => createOfflineTextTurnRequest(context.threadId, 'x'.repeat(32_001)));
  });

  it('accepts a text delta stream and projects deterministic run-correlated events', () => {
    const projector = new OfflineCodexEventProjector(context);
    const started = projector.accept(
      delivery(1, 'delivery-1', frame('turn/started', { turn: { id: context.turnId } })),
    );
    const itemStarted = projector.accept(
      delivery(
        2,
        'item-started-1',
        frame('item/started', {
          threadId: context.threadId,
          turnId: context.turnId,
          item: { id: 'item-1', type: 'agentMessage', text: '', phase: 'final_answer' },
        }),
      ),
    );
    const delta = projector.accept(
      delivery(
        3,
        'delivery-2',
        frame('item/agentMessage/delta', {
          threadId: context.threadId,
          turnId: context.turnId,
          itemId: 'item-1',
          delta: 'hello',
        }),
      ),
    );
    const itemCompleted = projector.accept(
      delivery(
        4,
        'item-completed-1',
        frame('item/completed', {
          threadId: context.threadId,
          turnId: context.turnId,
          item: { id: 'item-1', type: 'agentMessage', text: 'hello', phase: 'final_answer' },
        }),
      ),
    );
    const completed = projector.accept(
      delivery(
        5,
        'delivery-3',
        frame('turn/completed', { turn: { id: context.turnId, status: 'completed' } }),
      ),
    );

    assert.deepEqual(
      [
        started.event?.type,
        itemStarted.event,
        delta.event?.type,
        itemCompleted.event,
        completed.event?.type,
      ],
      ['started', undefined, 'text_delta', undefined, 'completed'],
    );
    assert.equal(delta.event?.runId, context.runId);
    assert.equal(delta.event?.operationId, context.operationId);
    assert.equal(delta.event?.sessionId, context.sessionId);
    assert.equal(delta.event?.itemId, 'item-1');
    assert.equal(delta.event?.eventId, 'delivery-2');
    assert.deepEqual(
      [started.event?.sequence, delta.event?.sequence, completed.event?.sequence],
      [1, 2, 3],
    );
    assert.equal(projector.output, 'hello');
  });

  it('keeps assistant message phases separate and deterministically selects final-answer items', () => {
    const projector = new OfflineCodexEventProjector({ ...context, maxOutputBytes: 64 });
    let sequence = 0;
    const accept = (method: string, params: unknown) =>
      projector.accept(delivery(++sequence, `phase-${sequence}`, frame(method, params))).event;
    const item = (id: string, phase: 'commentary' | 'partial_answer' | 'final_answer') => ({
      threadId: context.threadId,
      turnId: context.turnId,
      item: { id, type: 'agentMessage', text: '', phase },
    });
    const delta = (itemId: string, text: string) => ({
      threadId: context.threadId,
      turnId: context.turnId,
      itemId,
      delta: text,
    });
    const complete = (
      id: string,
      phase: 'commentary' | 'partial_answer' | 'final_answer',
      text: string,
    ) => ({
      threadId: context.threadId,
      turnId: context.turnId,
      item: { id, type: 'agentMessage', text, phase },
    });

    accept('turn/started', { turn: { id: context.turnId } });
    accept('item/started', item('commentary-1', 'commentary'));
    const commentaryDelta = accept('item/agentMessage/delta', delta('commentary-1', 'thinking'));
    accept('item/completed', complete('commentary-1', 'commentary', 'thinking'));
    accept('item/started', item('partial-1', 'partial_answer'));
    const partialDelta = accept('item/agentMessage/delta', delta('partial-1', 'draft'));
    accept('item/completed', complete('partial-1', 'partial_answer', 'draft'));
    accept('item/started', item('final-1', 'final_answer'));
    const firstFinalDelta = accept('item/agentMessage/delta', delta('final-1', 'first '));
    accept('item/completed', complete('final-1', 'final_answer', 'first '));
    accept('item/started', item('final-2', 'final_answer'));
    const secondFinalDelta = accept('item/agentMessage/delta', delta('final-2', 'answer'));
    accept('item/completed', complete('final-2', 'final_answer', 'answer'));
    const terminal = accept('turn/completed', {
      turn: { id: context.turnId, status: 'completed' },
    });

    assert.deepEqual(
      [
        commentaryDelta?.phase,
        partialDelta?.phase,
        firstFinalDelta?.phase,
        secondFinalDelta?.phase,
      ],
      ['commentary', 'partial_answer', 'final_answer', 'final_answer'],
    );
    assert.equal(terminal?.type, 'completed');
    assert.equal(projector.output, 'first answer');
  });

  it('does not promote commentary or partial-answer items to a completed result', () => {
    for (const phase of ['commentary', 'partial_answer'] as const) {
      const projector = new OfflineCodexEventProjector(context);
      projector.accept(
        delivery(1, 'turn-start', frame('turn/started', { turn: { id: context.turnId } })),
      );
      projector.accept(
        delivery(
          2,
          'item-start',
          frame('item/started', {
            threadId: context.threadId,
            turnId: context.turnId,
            item: { id: `item-${phase}`, type: 'agentMessage', text: '', phase },
          }),
        ),
      );
      projector.accept(
        delivery(
          3,
          'delta',
          frame('item/agentMessage/delta', {
            threadId: context.threadId,
            turnId: context.turnId,
            itemId: `item-${phase}`,
            delta: 'not final',
          }),
        ),
      );
      projector.accept(
        delivery(
          4,
          'item-completed',
          frame('item/completed', {
            threadId: context.threadId,
            turnId: context.turnId,
            item: { id: `item-${phase}`, type: 'agentMessage', text: 'not final', phase },
          }),
        ),
      );
      assert.throws(
        () =>
          projector.accept(
            delivery(
              5,
              'terminal',
              frame('turn/completed', { turn: { id: context.turnId, status: 'completed' } }),
            ),
          ),
        /final answer item/,
      );
      assert.equal(projector.status, 'unknown');
    }
  });

  it('rejects reused assistant item IDs and phase changes within one item lifecycle', () => {
    const reused = new OfflineCodexEventProjector(context);
    reused.accept(delivery(1, 'turn', frame('turn/started', { turn: { id: context.turnId } })));
    const start = (sequence: number, phase: 'commentary' | 'final_answer') =>
      reused.accept(
        delivery(
          sequence,
          `start-${sequence}`,
          frame('item/started', {
            threadId: context.threadId,
            turnId: context.turnId,
            item: { id: 'same-item', type: 'agentMessage', text: '', phase },
          }),
        ),
      );
    start(2, 'commentary');
    reused.accept(
      delivery(
        3,
        'delta',
        frame('item/agentMessage/delta', {
          threadId: context.threadId,
          turnId: context.turnId,
          itemId: 'same-item',
          delta: 'x',
        }),
      ),
    );
    reused.accept(
      delivery(
        4,
        'complete',
        frame('item/completed', {
          threadId: context.threadId,
          turnId: context.turnId,
          item: { id: 'same-item', type: 'agentMessage', text: 'x', phase: 'commentary' },
        }),
      ),
    );
    assert.throws(() => start(5, 'final_answer'), /unexpected app-server text item start/);

    const phaseChange = new OfflineCodexEventProjector(context);
    phaseChange.accept(
      delivery(1, 'turn', frame('turn/started', { turn: { id: context.turnId } })),
    );
    phaseChange.accept(
      delivery(
        2,
        'start',
        frame('item/started', {
          threadId: context.threadId,
          turnId: context.turnId,
          item: { id: 'phase-item', type: 'agentMessage', text: '', phase: 'partial_answer' },
        }),
      ),
    );
    assert.throws(
      () =>
        phaseChange.accept(
          delivery(
            3,
            'complete',
            frame('item/completed', {
              threadId: context.threadId,
              turnId: context.turnId,
              item: { id: 'phase-item', type: 'agentMessage', text: '', phase: 'final_answer' },
            }),
          ),
        ),
      /completion mismatch/,
    );
  });

  it('rejects a tool attempt at the offline parser boundary', () => {
    const projector = new OfflineCodexEventProjector(context);
    assert.throws(
      () =>
        projector.accept(
          delivery(
            1,
            'tool-1',
            frame('item/started', {
              threadId: context.threadId,
              turnId: context.turnId,
              item: { id: 'item-tool', type: 'commandExecution' },
            }),
          ),
        ),
      /tool or non-text item rejected/,
    );
  });

  it('requires a matching text item lifecycle and final accumulated text', () => {
    const noStart = new OfflineCodexEventProjector(context);
    noStart.accept(
      delivery(1, 'turn-start', frame('turn/started', { turn: { id: context.turnId } })),
    );
    assert.throws(() =>
      noStart.accept(
        delivery(
          2,
          'delta',
          frame('item/agentMessage/delta', {
            threadId: context.threadId,
            turnId: context.turnId,
            itemId: 'item-1',
            delta: 'x',
          }),
        ),
      ),
    );

    const mismatch = new OfflineCodexEventProjector(context);
    mismatch.accept(
      delivery(1, 'turn-start', frame('turn/started', { turn: { id: context.turnId } })),
    );
    mismatch.accept(
      delivery(
        2,
        'item-start',
        frame('item/started', {
          threadId: context.threadId,
          turnId: context.turnId,
          item: { id: 'item-1', type: 'agentMessage', text: '' },
        }),
      ),
    );
    mismatch.accept(
      delivery(
        3,
        'delta',
        frame('item/agentMessage/delta', {
          threadId: context.threadId,
          turnId: context.turnId,
          itemId: 'item-1',
          delta: 'x',
        }),
      ),
    );
    assert.throws(() =>
      mismatch.accept(
        delivery(
          4,
          'item-end',
          frame('item/completed', {
            threadId: context.threadId,
            turnId: context.turnId,
            item: { id: 'item-other', type: 'agentMessage', text: 'x' },
          }),
        ),
      ),
    );

    const finalTextMismatch = new OfflineCodexEventProjector(context);
    finalTextMismatch.accept(
      delivery(1, 'turn-start', frame('turn/started', { turn: { id: context.turnId } })),
    );
    finalTextMismatch.accept(
      delivery(
        2,
        'item-start',
        frame('item/started', {
          threadId: context.threadId,
          turnId: context.turnId,
          item: { id: 'item-1', type: 'agentMessage', text: '' },
        }),
      ),
    );
    finalTextMismatch.accept(
      delivery(
        3,
        'delta',
        frame('item/agentMessage/delta', {
          threadId: context.threadId,
          turnId: context.turnId,
          itemId: 'item-1',
          delta: 'x',
        }),
      ),
    );
    assert.throws(
      () =>
        finalTextMismatch.accept(
          delivery(
            4,
            'item-end',
            frame('item/completed', {
              threadId: context.threadId,
              turnId: context.turnId,
              item: { id: 'item-1', type: 'agentMessage', text: 'other' },
            }),
          ),
        ),
      /completion mismatch/,
    );
  });

  it('rejects server-initiated tool requests, unsupported methods, malformed JSON, and unknown notifications', () => {
    const projector = new OfflineCodexEventProjector(context);
    for (const raw of [
      JSON.stringify({ id: 8, method: 'item/commandExecution/requestApproval', params: {} }),
      frame('item/tool/call', {}),
      '{"method":',
      frame('item/unknown/newEvent', {}),
      frame('item/agentMessage/delta', {
        threadId: context.threadId,
        turnId: context.turnId,
        itemId: 'item-1',
        delta: 'text',
        token: 'unrecognized field',
      }),
    ]) {
      assert.throws(() => projector.accept(delivery(1, `bad-${raw.length}`, raw)));
    }
  });

  it('rejects duplicate object keys before protocol schema validation', () => {
    for (const raw of [
      '{"method":"turn/completed","method":"item/commandExecution/requestApproval","params":{"turn":{"id":"turn-synthetic-1","status":"completed"}}}',
      '{"method":"turn/completed","params":{"turn":{"id":"turn-synthetic-1","id":"turn-other","status":"completed"}}}',
      '{"method":"turn/completed","params":{"turn":{"id":"turn-synthetic-1","status":"failed","status":"completed"}}}',
    ]) {
      assert.throws(
        () => new OfflineCodexEventProjector(context).accept(delivery(1, 'duplicate-key', raw)),
        /malformed app-server JSON/,
      );
    }
  });

  it('rejects duplicate deliveries with conflicting bytes and out-of-order delivery sequences', () => {
    const projector = new OfflineCodexEventProjector(context);
    const first = delivery(
      1,
      'delivery-1',
      frame('turn/started', { turn: { id: context.turnId } }),
    );
    projector.accept(first);
    assert.equal(projector.accept(first).duplicate, true);
    assert.throws(
      () =>
        projector.accept(
          delivery(1, 'delivery-1', frame('turn/started', { turn: { id: 'turn-other' } })),
        ),
      /duplicate delivery identity conflict/,
    );
    assert.throws(
      () => projector.accept(delivery(99, 'delivery-1', first.frame)),
      /duplicate delivery identity conflict/,
    );
    const outOfOrder = new OfflineCodexEventProjector(context);
    outOfOrder.accept(first);
    assert.throws(
      () =>
        outOfOrder.accept(
          delivery(
            3,
            'delivery-3',
            frame('turn/completed', { turn: { id: context.turnId, status: 'completed' } }),
          ),
        ),
      /out-of-order/,
    );
  });

  it('rejects session, thread, turn, and operation binding substitutions', () => {
    for (const params of [
      { turn: { id: 'turn-other' } },
      { threadId: 'thread-other', turnId: context.turnId, itemId: 'item-1', delta: 'a' },
      { threadId: context.threadId, turnId: 'turn-other', itemId: 'item-1', delta: 'a' },
    ]) {
      const projector = new OfflineCodexEventProjector(context);
      const method =
        'turn' in (params as Record<string, unknown>) ? 'turn/started' : 'item/agentMessage/delta';
      assert.throws(() => projector.accept(delivery(1, 'identity-1', frame(method, params))));
    }
    assert.throws(() => new OfflineCodexEventProjector({ ...context, operationId: 'bad' }));
  });

  it('bounds each frame and aggregate UTF-8 output bytes', () => {
    const tooLarge = new OfflineCodexEventProjector({ ...context, maxOutputBytes: 4 });
    tooLarge.accept(delivery(1, 's', frame('turn/started', { turn: { id: context.turnId } })));
    tooLarge.accept(
      delivery(
        2,
        'i',
        frame('item/started', {
          threadId: context.threadId,
          turnId: context.turnId,
          item: { id: 'item-1', type: 'agentMessage', text: '' },
        }),
      ),
    );
    assert.throws(
      () =>
        tooLarge.accept(
          delivery(
            3,
            'd',
            frame('item/agentMessage/delta', {
              threadId: context.threadId,
              turnId: context.turnId,
              itemId: 'item-1',
              delta: 'hello',
            }),
          ),
        ),
      /output limit/,
    );
    assert.throws(
      () =>
        new OfflineCodexEventProjector(context).accept(
          delivery(1, 'large-frame', ' '.repeat(20_000)),
        ),
      /frame limit/,
    );
  });

  it('maps failure/interruption distinctly and classifies errors without retaining provider text', () => {
    assert.equal(classifyAppServerFailure({ codexErrorInfo: 'unauthorized' }), 'authorization');
    assert.equal(classifyAppServerFailure({ codexErrorInfo: 'usageLimitExceeded' }), 'entitlement');
    assert.equal(classifyAppServerFailure({ codexErrorInfo: 'sandboxError' }), 'execution');
    assert.equal(
      classifyAppServerFailure({ message: 'sensitive provider details' }),
      'provider_failure',
    );
    assert.equal(classifyAppServerFailure({ codexErrorInfo: 'unknown' }), 'provider_failure');

    const failed = new OfflineCodexEventProjector(context);
    assert.equal(
      failed.accept(
        delivery(
          1,
          'failed',
          frame('turn/completed', { turn: { id: context.turnId, status: 'failed' } }),
        ),
      ).event?.type,
      'failed',
    );
    const interrupted = new OfflineCodexEventProjector(context);
    interrupted.accept(
      delivery(1, 'turn-start', frame('turn/started', { turn: { id: context.turnId } })),
    );
    interrupted.requestCancellation();
    assert.equal(
      interrupted.accept(
        delivery(
          2,
          'interrupted',
          frame('turn/completed', { turn: { id: context.turnId, status: 'interrupted' } }),
        ),
      ).event?.type,
      'cancelled',
    );
  });

  it('treats disconnect before terminal completion as unknown', () => {
    const projector = new OfflineCodexEventProjector(context);
    projector.accept(
      delivery(1, 'started', frame('turn/started', { turn: { id: context.turnId } })),
    );
    assert.equal(projector.disconnect().type, 'outcome_unknown');
    assert.equal(projector.status, 'unknown');
    assert.throws(
      () =>
        projector.accept(
          delivery(
            2,
            'late-terminal',
            frame('turn/completed', {
              turn: { id: context.turnId, status: 'completed' },
            }),
          ),
        ),
      /requires authoritative reconciliation/,
    );
  });

  it('records completion that races with cancellation as completion', () => {
    const projector = new OfflineCodexEventProjector(context);
    projector.requestCancellation();
    projector.accept(
      delivery(1, 'started', frame('turn/started', { turn: { id: context.turnId } })),
    );
    projector.accept(
      delivery(
        2,
        'item-started',
        frame('item/started', {
          threadId: context.threadId,
          turnId: context.turnId,
          item: { id: 'item-1', type: 'agentMessage', text: '' },
        }),
      ),
    );
    projector.accept(
      delivery(
        3,
        'item-completed',
        frame('item/completed', {
          threadId: context.threadId,
          turnId: context.turnId,
          item: { id: 'item-1', type: 'agentMessage', text: '' },
        }),
      ),
    );
    const event = projector.accept(
      delivery(
        4,
        'late-completion',
        frame('turn/completed', { turn: { id: context.turnId, status: 'completed' } }),
      ),
    ).event;
    assert.equal(event?.type, 'completed');
    assert.equal(projector.status, 'completed');
  });

  it('keeps streamed deltas correlated while cancellation is pending', () => {
    const projector = new OfflineCodexEventProjector(context);
    projector.accept(
      delivery(1, 'started', frame('turn/started', { turn: { id: context.turnId } })),
    );
    assert.equal(projector.requestCancellation().type, 'cancel_requested');
    projector.accept(
      delivery(
        2,
        'item-started',
        frame('item/started', {
          threadId: context.threadId,
          turnId: context.turnId,
          item: { id: 'item-1', type: 'agentMessage', text: '' },
        }),
      ),
    );
    const delta = projector.accept(
      delivery(
        3,
        'delta-during-cancel',
        frame('item/agentMessage/delta', {
          threadId: context.threadId,
          turnId: context.turnId,
          itemId: 'item-1',
          delta: 'part',
        }),
      ),
    );
    assert.equal(delta.event?.type, 'text_delta');
    assert.equal(projector.status, 'cancellation_requested');
  });

  it('enforces turn lifecycle ordering while cancellation is pending', () => {
    const makeProjector = () => new OfflineCodexEventProjector(context);
    const turnStarted = (sequence: number, id = 'turn-start') =>
      delivery(sequence, id, frame('turn/started', { turn: { id: context.turnId } }));
    const itemStarted = (sequence: number) =>
      delivery(
        sequence,
        `item-started-${sequence}`,
        frame('item/started', {
          threadId: context.threadId,
          turnId: context.turnId,
          item: { id: 'item-1', type: 'agentMessage', text: '' },
        }),
      );
    const delta = (sequence: number) =>
      delivery(
        sequence,
        `delta-${sequence}`,
        frame('item/agentMessage/delta', {
          threadId: context.threadId,
          turnId: context.turnId,
          itemId: 'item-1',
          delta: 'x',
        }),
      );

    const cancelBeforeStart = makeProjector();
    assert.equal(cancelBeforeStart.requestCancellation().type, 'cancel_requested');
    assert.equal(cancelBeforeStart.accept(turnStarted(1)).event?.type, 'started');
    assert.equal(cancelBeforeStart.status, 'cancellation_requested');
    assert.throws(() => cancelBeforeStart.accept(turnStarted(2, 'duplicate-start')));

    const textBeforeStart = makeProjector();
    textBeforeStart.requestCancellation();
    assert.throws(
      () => textBeforeStart.accept(itemStarted(1)),
      /unexpected app-server text item start/,
    );
    const deltaBeforeStart = makeProjector();
    deltaBeforeStart.requestCancellation();
    assert.throws(() => deltaBeforeStart.accept(delta(1)));

    const startAfterText = makeProjector();
    startAfterText.accept(turnStarted(1));
    startAfterText.accept(itemStarted(2));
    startAfterText.accept(delta(3));
    assert.throws(() => startAfterText.accept(turnStarted(4, 'late-start')));

    const cancelAfterStart = makeProjector();
    cancelAfterStart.accept(turnStarted(1));
    assert.equal(cancelAfterStart.requestCancellation().type, 'cancel_requested');
    cancelAfterStart.accept(itemStarted(2));
    assert.equal(cancelAfterStart.accept(delta(3)).event?.type, 'text_delta');
  });

  it('rejects completed terminal evidence with a non-null error', () => {
    const projector = new OfflineCodexEventProjector(context);
    projector.accept(
      delivery(1, 'started', frame('turn/started', { turn: { id: context.turnId } })),
    );
    projector.accept(
      delivery(
        2,
        'item-started',
        frame('item/started', {
          threadId: context.threadId,
          turnId: context.turnId,
          item: { id: 'item-1', type: 'agentMessage', text: '' },
        }),
      ),
    );
    projector.accept(
      delivery(
        3,
        'item-completed',
        frame('item/completed', {
          threadId: context.threadId,
          turnId: context.turnId,
          item: { id: 'item-1', type: 'agentMessage', text: '' },
        }),
      ),
    );
    assert.throws(
      () =>
        projector.accept(
          delivery(
            4,
            'contradictory-completion',
            frame('turn/completed', {
              turn: {
                id: context.turnId,
                status: 'completed',
                error: { codexErrorInfo: 'unauthorized' },
              },
            }),
          ),
        ),
      /contradictory app-server completion evidence/,
    );
    assert.equal(projector.status, 'unknown');
  });

  it('requires text item start to have an empty initial text value', () => {
    const projector = new OfflineCodexEventProjector(context);
    projector.accept(
      delivery(1, 'started', frame('turn/started', { turn: { id: context.turnId } })),
    );
    assert.throws(
      () =>
        projector.accept(
          delivery(
            2,
            'prepopulated-item',
            frame('item/started', {
              threadId: context.threadId,
              turnId: context.turnId,
              item: { id: 'item-1', type: 'agentMessage', text: 'unprojected prefix' },
            }),
          ),
        ),
      /unexpected app-server text item start/,
    );
    assert.equal(projector.status, 'unknown');
  });

  it('deduplicates a repeated terminal delivery without emitting a second terminal event', () => {
    const projector = new OfflineCodexEventProjector(context);
    projector.accept(
      delivery(1, 'started', frame('turn/started', { turn: { id: context.turnId } })),
    );
    projector.accept(
      delivery(
        2,
        'item-started',
        frame('item/started', {
          threadId: context.threadId,
          turnId: context.turnId,
          item: { id: 'item-1', type: 'agentMessage', text: '' },
        }),
      ),
    );
    projector.accept(
      delivery(
        3,
        'item-completed',
        frame('item/completed', {
          threadId: context.threadId,
          turnId: context.turnId,
          item: { id: 'item-1', type: 'agentMessage', text: '' },
        }),
      ),
    );
    const terminal = delivery(
      4,
      'terminal-1',
      frame('turn/completed', { turn: { id: context.turnId, status: 'completed' } }),
    );
    assert.equal(projector.accept(terminal).event?.type, 'completed');
    assert.equal(projector.accept(terminal).duplicate, true);
    assert.equal(projector.status, 'completed');
  });

  it('latches protocol violations as unknown and rejects later frames pending reconciliation', () => {
    const projector = new OfflineCodexEventProjector(context);
    assert.throws(
      () =>
        projector.accept(
          delivery(1, 'wrong-turn', frame('turn/started', { turn: { id: 'turn-other' } })),
        ),
      /turn identity mismatch/,
    );
    assert.equal(projector.status, 'unknown');
    assert.throws(
      () =>
        projector.accept(
          delivery(1, 'correct-turn', frame('turn/started', { turn: { id: context.turnId } })),
        ),
      /requires authoritative reconciliation/,
    );
  });

  it('emits cancellation intent only once when cancellation is repeated', () => {
    const projector = new OfflineCodexEventProjector(context);
    const first = projector.requestCancellation();
    const repeated = projector.requestCancellation();
    assert.deepEqual(repeated, first);
    assert.equal(repeated.type, 'cancel_requested');

    const uncertain = new OfflineCodexEventProjector(context);
    const disconnected = uncertain.disconnect();
    assert.equal(disconnected.type, 'outcome_unknown');
    assert.deepEqual(uncertain.requestCancellation(), disconnected);
    assert.deepEqual(uncertain.disconnect(), disconnected);

    const cancellationUnknown = new OfflineCodexEventProjector(context);
    cancellationUnknown.requestCancellation();
    const cancelledWhileDisconnected = cancellationUnknown.disconnect();
    assert.equal(cancellationUnknown.status, 'cancellation_unknown');
    assert.deepEqual(cancellationUnknown.requestCancellation(), cancelledWhileDisconnected);
  });

  it('normalizes missing usage as unknown and rejects malformed or inconsistent synthetic usage', () => {
    assert.deepEqual(normalizeOfflineUsage(undefined), { kind: 'unknown', reason: 'not_reported' });
    assert.deepEqual(normalizeOfflineUsage({ inputTokens: 8, outputTokens: 5, totalTokens: 13 }), {
      kind: 'reported',
      inputTokens: 8,
      outputTokens: 5,
      totalTokens: 13,
      provenance: 'synthetic-fixture',
    });
    for (const usage of [
      { inputTokens: -1, outputTokens: 1, totalTokens: 0 },
      { inputTokens: 1.5, outputTokens: 1, totalTokens: 2 },
      { inputTokens: 1, outputTokens: 1, totalTokens: 3 },
      { inputTokens: 1, outputTokens: 1, totalTokens: 2, cost: 0.01 },
    ]) {
      assert.throws(() => normalizeOfflineUsage(usage));
    }
  });

  it('allows each offline operation to submit at most once and never resubmits unknown work during recovery', () => {
    let status: ProviderOperationStatus = 'authorized';
    let submissionCount = 0;
    const submit = () => {
      status = transitionProviderOperation(status, 'submission_attempted');
      submissionCount++;
    };
    submit();
    status = transitionProviderOperation(status, 'submission_ack_lost');
    assert.equal(status, 'unknown');
    assert.throws(
      () => transitionProviderOperation(status, 'submission_attempted'),
      /invalid provider operation transition/,
    );
    assert.equal(submissionCount, 1);
    assert.equal(status, 'unknown');
  });

  it('models cancellation before submission without invoking a provider operation', () => {
    let status: ProviderOperationStatus = 'authorized';
    let submissionCount = 0;
    status = transitionProviderOperation(status, 'cancel_requested');
    status = transitionProviderOperation(status, 'cancel_confirmed');
    if (status === 'authorized') submissionCount++;
    assert.equal(status, 'cancelled');
    assert.equal(submissionCount, 0);
  });

  it('does not call cancellation confirmed when its acknowledgement is lost', () => {
    let status: ProviderOperationStatus = 'started';
    status = transitionProviderOperation(status, 'cancel_requested');
    status = transitionProviderOperation(status, 'cancel_outcome_unknown');
    assert.equal(status, 'cancellation_unknown');
    assert.throws(
      () => transitionProviderOperation(status, 'cancel_confirmed'),
      /invalid provider operation transition/,
    );
  });

  it('requires terminal interruption evidence to cancel work that may have been submitted', () => {
    const inFlight = transitionProviderOperation('submission_attempted', 'cancel_requested');
    assert.equal(inFlight, 'cancellation_requested');
    assert.throws(
      () => transitionProviderOperation(inFlight, 'cancel_confirmed'),
      /invalid provider operation transition/,
    );
    assert.equal(
      transitionProviderOperation(inFlight, 'provider_terminal_interrupted'),
      'cancelled',
    );
  });

  it('preserves cancellation intent while submission acknowledgement is pending', () => {
    let status: ProviderOperationStatus = 'authorized';
    status = transitionProviderOperation(status, 'submission_attempted');
    status = transitionProviderOperation(status, 'cancel_requested');
    assert.equal(status, 'cancellation_requested');
    assert.equal(
      transitionProviderOperation(status, 'submission_acknowledged'),
      'cancellation_requested',
    );
    assert.equal(
      transitionProviderOperation(status, 'submission_ack_lost'),
      'cancellation_unknown',
    );
  });

  it('requires authoritative terminal evidence for definitive provider failure', () => {
    assert.throws(
      () => transitionProviderOperation('submission_attempted', 'provider_terminal_failed'),
      /invalid provider operation transition/,
    );
    assert.throws(
      () => transitionProviderOperation('started', 'failed' as never),
      /invalid provider operation transition/,
    );
    assert.equal(transitionProviderOperation('started', 'provider_terminal_failed'), 'failed');
    assert.equal(transitionProviderOperation('submitted', 'provider_terminal_failed'), 'failed');
  });

  it('allows terminal reconciliation from unknown without permitting another submission', () => {
    let status: ProviderOperationStatus = 'submission_attempted';
    status = transitionProviderOperation(status, 'submission_ack_lost');
    status = transitionProviderOperation(status, 'reconciled_completed');
    assert.equal(status, 'completed');
    assert.throws(
      () => transitionProviderOperation(status, 'submission_attempted'),
      /invalid provider operation transition/,
    );
    assert.throws(
      () => transitionProviderOperation('unknown', 'reconciled_cancelled'),
      /invalid provider operation transition/,
    );
    assert.equal(
      transitionProviderOperation('cancellation_unknown', 'reconciled_cancelled'),
      'cancelled',
    );
  });
});
