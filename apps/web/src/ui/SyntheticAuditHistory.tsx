import { useEffect, useRef, useState } from 'react';
import {
  SyntheticTaskRunEventsResponseSchema,
  type SyntheticTaskRunEvent,
} from '@omnis/contracts/synthetic-audit-history';
import { request } from './api.js';

type History = { events: SyntheticTaskRunEvent[]; nextAfter: number | null };

export function SyntheticAuditHistory({
  taskId,
  authorizationId,
}: {
  taskId: string;
  authorizationId: string;
}) {
  const [history, setHistory] = useState<History>({ events: [], nextAfter: null });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const requestGeneration = useRef(0);

  useEffect(() => {
    const generation = ++requestGeneration.current;
    let current = true;
    setHistory({ events: [], nextAfter: null });
    setLoading(true);
    setLoadingMore(false);
    setError('');
    const query = new URLSearchParams({ after: '0', limit: '50' });
    void request(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/synthetic-runs/${encodeURIComponent(authorizationId)}/events?${query}`,
      {},
      (value) => SyntheticTaskRunEventsResponseSchema.parse(value),
    )
      .then((page) => {
        if (!current) return;
        if (page.taskId !== taskId || page.authorizationId !== authorizationId)
          throw new Error('Authorization audit history did not match this Run.');
        setHistory({ events: page.events, nextAfter: page.page.nextAfter });
      })
      .catch((cause: unknown) => {
        if (current)
          setError(
            cause instanceof Error ? cause.message : 'Authorization audit history is unavailable.',
          );
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
      if (requestGeneration.current === generation) requestGeneration.current += 1;
    };
  }, [taskId, authorizationId, retry]);

  async function loadMore() {
    if (history.nextAfter === null || loadingMore) return;
    const generation = requestGeneration.current;
    setLoadingMore(true);
    setError('');
    const query = new URLSearchParams({ after: String(history.nextAfter), limit: '50' });
    try {
      const page = await request(
        `/api/v1/tasks/${encodeURIComponent(taskId)}/synthetic-runs/${encodeURIComponent(authorizationId)}/events?${query}`,
        {},
        (value) => SyntheticTaskRunEventsResponseSchema.parse(value),
      );
      if (requestGeneration.current !== generation) return;
      if (page.taskId !== taskId || page.authorizationId !== authorizationId)
        throw new Error('Authorization audit history did not match this Run.');
      setHistory((current) => ({
        events: [...current.events, ...page.events],
        nextAfter: page.page.nextAfter,
      }));
    } catch (cause) {
      if (requestGeneration.current !== generation) return;
      setError(
        cause instanceof Error ? cause.message : 'More authorization events are unavailable.',
      );
    } finally {
      if (requestGeneration.current === generation) setLoadingMore(false);
    }
  }

  return (
    <section className="audit-history" aria-labelledby="audit-history-title">
      <div className="event-heading">
        <h3 id="audit-history-title">Authorization audit</h3>
        <span>
          {history.events.length} {history.events.length === 1 ? 'event' : 'events'}
        </span>
      </div>
      <p className="audit-description">
        Persisted owner authorization and broker lifecycle records.
      </p>
      {loading ? (
        <p role="status">Loading authorization history…</p>
      ) : error && history.events.length === 0 ? (
        <div className="audit-error" role="alert">
          <p>{error}</p>
          <button className="text-button" onClick={() => setRetry((value) => value + 1)}>
            Retry authorization history
          </button>
        </div>
      ) : history.events.length ? (
        <ol className="audit-list" aria-label="Persisted authorization audit history">
          {history.events.map((event) => (
            <li key={`${event.attemptId}-${event.sequence}`}>
              <span>{event.eventType.replace('connector.', '').replaceAll('_', ' ')}</span>
              <time dateTime={event.occurredAt}>
                {new Date(event.occurredAt).toLocaleString('en-US', { timeZone: 'Asia/Manila' })}
              </time>
              <small>
                {event.outcome}; revocation generation {event.revocationGeneration}
              </small>
            </li>
          ))}
        </ol>
      ) : (
        <p className="audit-empty" role="status">
          No authorization audit events are recorded for this synthetic Run.
        </p>
      )}
      {error && history.events.length > 0 && (
        <p className="audit-error" role="alert">
          {error}
        </p>
      )}
      {history.nextAfter !== null && !loading && (
        <button className="text-button" onClick={() => void loadMore()} disabled={loadingMore}>
          {loadingMore ? 'Loading more events…' : 'Load more authorization events'}
        </button>
      )}
    </section>
  );
}
