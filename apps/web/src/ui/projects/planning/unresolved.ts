/**
 * Reconciling a create whose outcome is unknown.
 *
 * A create has no record id to read back, so the only evidence available is the list. The list is
 * newest first and paged, so absence from one page proves nothing: every page is read, and only a
 * complete read can say that no matching record exists. Even then it is an observation at one
 * moment, not a guarantee that a request still in flight will not land, which is why the form
 * stays locked to the original request (and its Idempotency-Key) until the request itself is
 * settled.
 */
export type PendingCreate<C> = {
  /** Exactly what was sent. Retried unchanged, with the same Idempotency-Key. */
  changes: C;
  /** Browser time of the first attempt. */
  startedAt: number;
  /** Ids of the records already known before the attempt. */
  knownIds: readonly string[];
};

export type ScanResult<T> =
  | { kind: 'found'; record: T }
  /** More than one record fits; none is picked. */
  | { kind: 'ambiguous'; count: number }
  /** Every page was read and none fits. */
  | { kind: 'absent' }
  /** A page could not be read, or there were too many pages to read: nothing can be concluded. */
  | { kind: 'unknown' };

/** A browser/server clock difference this tolerates when asking "was it created since then?". */
export const CLOCK_SKEW_MS = 10 * 60 * 1000;
export const MAX_SCAN_PAGES = 20;

type Candidate = { id: string; revision: number; status: string; createdAt: string };
type PageLike<T> = {
  items: T[];
  page: { complete: boolean; nextCursor: string | null };
};

export async function scanForCreated<T extends Candidate, C>(
  fetchPage: (cursor: string | null) => Promise<PageLike<T>>,
  pending: PendingCreate<C>,
  matches: (record: T) => boolean,
): Promise<ScanResult<T>> {
  const known = new Set(pending.knownIds);
  const found = new Map<string, T>();
  let cursor: string | null = null;
  try {
    for (let pages = 0; ; pages += 1) {
      if (pages >= MAX_SCAN_PAGES) return { kind: 'unknown' };
      const result: PageLike<T> = await fetchPage(cursor);
      for (const record of result.items)
        if (
          !known.has(record.id) &&
          record.revision === 1 &&
          record.status === 'planned' &&
          Date.parse(record.createdAt) >= pending.startedAt - CLOCK_SKEW_MS &&
          matches(record)
        )
          found.set(record.id, record);
      if (result.page.complete || result.page.nextCursor === null) break;
      cursor = result.page.nextCursor;
    }
  } catch {
    return { kind: 'unknown' };
  }
  if (found.size === 1) return { kind: 'found', record: [...found.values()][0] as T };
  return found.size > 1 ? { kind: 'ambiguous', count: found.size } : { kind: 'absent' };
}
