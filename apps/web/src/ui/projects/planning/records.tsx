import { useRef } from 'react';
import type { ProjectWorkspacePage } from '@omnis/contracts';
import { NxButton, StatusBadge, type StatusTone } from '../../design/index.js';
import { Notice } from '../parts.js';
import type { PagedState } from './usePagedList.js';

type RecordStatus = 'planned' | 'in_progress' | 'completed' | 'archived';
const tone: Record<RecordStatus, StatusTone> = {
  planned: 'info',
  in_progress: 'attention',
  completed: 'ok',
  archived: 'neutral',
};
const text = (value: string) => value.replaceAll('_', ' ').replace(/^\w/, (c) => c.toUpperCase());

export const RecordStatusBadge = ({ status }: { status: RecordStatus }) => (
  <StatusBadge tone={tone[status]}>{text(status)}</StatusBadge>
);

/** "Aug 3, 2026" for a calendar date, with no time zone shift: a target date is a date, not an instant. */
export function formatTargetDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Remembers the control that opened a dialog. When the dialog closes, focus goes back to it if it
 * is still on the page, and otherwise to a stable fallback (a record can leave its list when it is
 * archived or moved), so keyboard focus is never dropped onto the document.
 */
export function useFocusReturn() {
  const opener = useRef<HTMLElement | null>(null);
  return {
    capture() {
      opener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    },
    restore(fallback: HTMLElement | null) {
      const target = () => (opener.current?.isConnected ? opener.current : fallback);
      // After React has closed the dialog, so the browser's own focus restore cannot override this.
      // The target can still be rendering (a message appearing in a hidden region), so try for a
      // few frames until focus actually lands.
      const attempt = (frames: number) => {
        const element = target();
        element?.focus();
        if (element && document.activeElement !== element && frames > 0)
          requestAnimationFrame(() => attempt(frames - 1));
        else opener.current = null;
      };
      setTimeout(() => attempt(10), 0);
    },
  };
}

/** The footer every paged list shares: honest completeness, load more, and recovery. */
export function ListFooter<T>({
  state,
  noun,
  loadMore,
  reload,
  shown,
  hideSummary = false,
}: {
  state: PagedState<T>;
  noun: string;
  loadMore: () => void;
  reload: () => void;
  /** How many of the loaded items this view shows (the archived ones may be folded away). */
  shown?: number;
  /** The caller already says how many are loaded. */
  hideSummary?: boolean;
}) {
  const page: ProjectWorkspacePage | null = state.page;
  if (!page) return null;
  const loaded = state.items.length;
  return (
    <>
      {!hideSummary && (
        <p className="nx-muted pw-summary">
          {!page.complete
            ? `${loaded} ${noun} loaded so far; ${page.observedTotal} were observed. More are available.`
            : loaded === page.observedTotal
              ? `All ${loaded} ${noun} loaded${shown !== undefined && shown !== loaded ? `; ${shown} shown` : ''}.`
              : `${loaded} ${noun} loaded; ${page.observedTotal} were observed when the last page was read, so this may be out of date.`}
        </p>
      )}
      {state.moreError?.kind === 'cursor' && (
        <Notice
          tone="warning"
          actions={<NxButton onClick={reload}>Restart from the first page</NxButton>}
        >
          The list changed while it was being read, so the next page can no longer be continued.
        </Notice>
      )}
      {state.moreError?.kind === 'failure' && (
        <Notice tone="error" actions={<NxButton onClick={loadMore}>Retry loading more</NxButton>}>
          {state.moreError.message}
        </Notice>
      )}
      {!page.complete && state.moreError === null && (
        <div className="pw-actions">
          <NxButton busy={state.loadingMore} onClick={loadMore}>
            Load more {noun}
          </NxButton>
        </div>
      )}
      {page.complete && loaded !== page.observedTotal && (
        <div className="pw-actions">
          <NxButton onClick={reload}>Reload {noun}</NxButton>
        </div>
      )}
    </>
  );
}
