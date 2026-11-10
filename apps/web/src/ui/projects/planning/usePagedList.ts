import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectWorkspacePage } from '@omnis/contracts';
import { ApiRequestError } from '../../api.js';
import { classifyReadError, type ReadFailure } from '../data.js';

export type Page<T> = { items: T[]; page: ProjectWorkspacePage };

export type PagedState<T> = {
  /** First-page read. A failure here replaces the list. */
  first: { status: 'loading' } | { status: 'ready' } | { status: 'error'; error: ReadFailure };
  items: T[];
  /** The page object of the most recently read page. Not a total when `complete` is false. */
  page: ProjectWorkspacePage | null;
  loadingMore: boolean;
  /** A failure reading a later page keeps what is already shown. */
  moreError: { kind: 'cursor' } | { kind: 'failure'; message: string } | null;
};

const initial = <T>(): PagedState<T> => ({
  first: { status: 'loading' },
  items: [],
  page: null,
  loadingMore: false,
  moreError: null,
});

/**
 * A cursor-paged read keyed by `key`. A response for an older key or an aborted request can never
 * be shown for the current one, a later page failing keeps the pages already read, and an item
 * that moves between requests is kept once.
 */
export function usePagedList<T extends { id: string }>(
  key: string,
  enabled: boolean,
  fetchPage: (cursor: string | null, signal: AbortSignal) => Promise<Page<T>>,
  onUnauthorized: (cause: unknown) => void,
) {
  const [state, setState] = useState<{ key: string; value: PagedState<T> }>({
    key,
    value: initial<T>(),
  });
  const [attempt, setAttempt] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const loadingMore = useRef(false);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;
  const current = state.key === key ? state.value : initial<T>();
  const currentRef = useRef(current);
  currentRef.current = current;

  useEffect(() => {
    if (!enabled) return undefined;
    const abort = new AbortController();
    controller.current = abort;
    loadingMore.current = false;
    setState({ key, value: initial<T>() });
    fetchRef
      .current(null, abort.signal)
      .then((result) => {
        if (abort.signal.aborted) return;
        setState({
          key,
          value: {
            ...initial<T>(),
            first: { status: 'ready' },
            items: result.items,
            page: result.page,
          },
        });
      })
      .catch((cause: unknown) => {
        if (abort.signal.aborted) return;
        const error = classifyReadError(cause, (value) => unauthorizedRef.current(value));
        if (error) setState({ key, value: { ...initial<T>(), first: { status: 'error', error } } });
      });
    return () => abort.abort();
  }, [key, enabled, attempt]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  const loadMore = useCallback(() => {
    const cursor = currentRef.current.page?.nextCursor;
    const abort = controller.current;
    if (!cursor || loadingMore.current || !abort || abort.signal.aborted) return;
    loadingMore.current = true;
    setState((existing) => ({
      ...existing,
      value: { ...existing.value, loadingMore: true, moreError: null },
    }));
    fetchRef
      .current(cursor, abort.signal)
      .then((result) => {
        if (abort.signal.aborted) return;
        loadingMore.current = false;
        setState((existing) => {
          const seen = new Set(existing.value.items.map((item) => item.id));
          const added = result.items.filter((item) => !seen.has(item.id));
          return {
            key: existing.key,
            value: {
              ...existing.value,
              items: [...existing.value.items, ...added],
              page: result.page,
              loadingMore: false,
            },
          };
        });
      })
      .catch((cause: unknown) => {
        if (abort.signal.aborted) return;
        loadingMore.current = false;
        let moreError: PagedState<T>['moreError'] = {
          kind: 'failure',
          message: cause instanceof ApiRequestError ? cause.message : 'Loading more failed.',
        };
        if (cause instanceof ApiRequestError) {
          if (cause.status === 401) {
            unauthorizedRef.current(cause);
            return;
          }
          if (cause.code === 'invalid_cursor') moreError = { kind: 'cursor' };
        }
        setState((existing) => ({
          ...existing,
          value: { ...existing.value, loadingMore: false, moreError },
        }));
      });
  }, []);

  /** Replace one item with a newer copy from a confirmed write or a read. */
  const replaceItem = useCallback((item: T) => {
    setState((existing) => ({
      ...existing,
      value: {
        ...existing.value,
        items: existing.value.items.map((entry) => (entry.id === item.id ? item : entry)),
      },
    }));
  }, []);

  /** Add a newly created item first (the API lists newest first), without adding it twice. */
  const prependItem = useCallback((item: T) => {
    setState((existing) => {
      if (existing.value.items.some((entry) => entry.id === item.id))
        return {
          ...existing,
          value: {
            ...existing.value,
            items: existing.value.items.map((entry) => (entry.id === item.id ? item : entry)),
          },
        };
      const page = existing.value.page;
      return {
        ...existing,
        value: {
          ...existing.value,
          items: [item, ...existing.value.items],
          page: page ? { ...page, observedTotal: page.observedTotal + 1 } : page,
        },
      };
    });
  }, []);

  return { state: current, reload, loadMore, replaceItem, prependItem };
}
