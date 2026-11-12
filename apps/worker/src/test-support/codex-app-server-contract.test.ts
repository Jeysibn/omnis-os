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
          item: { id: 'item-1', type: 'agentMessage', text: '', phase: 'commentary' },
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
    assert.throws(
      () =>
        projector.accept(
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
    interrupted.requestCancellation();
    assert.equal(
      interrupted.accept(
        delivery(
          1,
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
    assert.equal(status, 'unknown');
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
    assert.equal(transitionProviderOperation(status, 'submission_ack_lost'), 'unknown');
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
  });
});
