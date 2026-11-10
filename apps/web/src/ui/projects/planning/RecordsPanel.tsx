import { useId, useState, type ReactNode } from 'react';
import type { Epic, Milestone } from '@omnis/contracts';
import { EmptyState, ErrorState, LoadingState, NxButton, Panel } from '../../design/index.js';
import { formatManila } from '../parts.js';
import { readFailureView } from '../readFailure.js';
import { ArchiveDialog } from './ArchiveDialog.js';
import { RecordEditor } from './RecordEditor.js';
import { formatTargetDate, ListFooter, RecordStatusBadge, useFocusReturn } from './records.js';
import { usePagedList, type Page } from './usePagedList.js';

type Rec = Epic | Milestone;
type Changes = {
  title?: string;
  description?: string | null;
  status?: 'planned' | 'in_progress' | 'completed';
  targetDate?: string | null;
};

export type RecordsPanelProps<T extends Rec> = {
  kind: 'epic' | 'milestone';
  title: string;
  projectId: string;
  /** The project is archived: everything is read-only. */
  readOnly: boolean;
  csrfToken: string;
  refreshCsrf: () => Promise<string>;
  onUnauthorized: (cause: unknown) => void;
  announce: (text: string) => void;
  /** A stable element to focus when the control that opened a dialog left the page. */
  fallbackFocus: () => HTMLElement | null;
  fetchPage: (cursor: string | null, signal: AbortSignal) => Promise<Page<T>>;
  create: (input: Changes, key: string, csrfToken: string) => Promise<T>;
  update: (record: T, changes: Changes, key: string, csrfToken: string) => Promise<T>;
  archive: (record: T, key: string, csrfToken: string) => Promise<T>;
  read: (id: string) => Promise<T>;
  /** Extra content under a record when its disclosure is open (an epic's tasks). */
  details?: (record: T) => ReactNode;
  /** The label for the disclosure, when the record has `details`. */
  detailsLabel?: string;
};

/**
 * One planning list (epics or milestones): create, edit, archive, paged reading, and a folded
 * group for archived records, which stay readable and are never editable.
 */
export function RecordsPanel<T extends Rec>(props: RecordsPanelProps<T>) {
  const {
    kind,
    title,
    projectId,
    readOnly,
    csrfToken,
    refreshCsrf,
    onUnauthorized,
    announce,
    fallbackFocus,
  } = props;
  const list = usePagedList<T>(`${kind}:${projectId}`, true, props.fetchPage, onUnauthorized);
  const [editor, setEditor] = useState<{ open: boolean; record: T | null }>({
    open: false,
    record: null,
  });
  const [archiving, setArchiving] = useState<T | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [showArchived, setShowArchived] = useState(false);
  const focus = useFocusReturn();
  const regionId = useId();
  const { state } = list;

  const active = state.items.filter((item) => item.status !== 'archived');
  const archived = state.items.filter((item) => item.status === 'archived');
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const openEditor = (record: T | null) => {
    focus.capture();
    setEditor({ open: true, record });
  };
  const closeEditor = (reload: boolean) => {
    setEditor((current) => ({ ...current, open: false }));
    focus.restore(fallbackFocus());
    if (reload) list.reload();
  };

  function row(record: T) {
    const isArchived = record.status === 'archived';
    const open = expanded.has(record.id);
    const detailsId = `${regionId}-${record.id}`;
    return (
      <li key={record.id} className="pw-record" data-status={record.status}>
        <div className="pw-record-head">
          <h4 className="pw-record-title">{record.title}</h4>
          <RecordStatusBadge status={record.status} />
        </div>
        {record.description && <p className="pw-record-text">{record.description}</p>}
        <p className="nx-muted pw-record-meta">
          {'targetDate' in record &&
            (record.targetDate
              ? `Target ${formatTargetDate(record.targetDate)} · `
              : 'No target date · ')}
          Updated {formatManila(record.updatedAt)} · Revision {record.revision}
        </p>
        <div className="pw-actions">
          {props.details && (
            <NxButton
              aria-expanded={open}
              aria-controls={detailsId}
              aria-label={`${open ? 'Hide' : 'Show'} ${props.detailsLabel ?? 'details'} for ${record.title}`}
              onClick={() => toggle(record.id)}
            >
              {open ? 'Hide' : 'Show'} {props.detailsLabel}
            </NxButton>
          )}
          {!readOnly && !isArchived && (
            <>
              <NxButton
                aria-label={`Edit ${kind} ${record.title}`}
                onClick={() => openEditor(record)}
              >
                Edit
              </NxButton>
              <NxButton
                variant="danger"
                aria-label={`Archive ${kind} ${record.title}`}
                onClick={() => {
                  focus.capture();
                  setArchiving(record);
                }}
              >
                Archive
              </NxButton>
            </>
          )}
        </div>
        {props.details && open && (
          <div id={detailsId} className="pw-record-details">
            {props.details(record)}
          </div>
        )}
      </li>
    );
  }

  let body: ReactNode;
  if (state.first.status === 'loading') body = <LoadingState label={`Loading ${kind}s…`} />;
  else if (state.first.status === 'error') {
    const view = readFailureView(state.first.error, `${kind} list`);
    body = (
      <ErrorState
        title={view.title}
        description={view.description}
        onRetry={view.retry ? list.reload : undefined}
      />
    );
  } else {
    body = (
      <>
        {state.items.length === 0 ? (
          <EmptyState
            title={`No ${kind}s yet`}
            description={
              readOnly
                ? 'This project is archived, so none can be added.'
                : `Create the first ${kind} to start planning this project.`
            }
          />
        ) : (
          <>
            {active.length > 0 ? (
              <ul className="pw-records" aria-label={`${title} (active)`}>
                {active.map(row)}
              </ul>
            ) : (
              <p className="nx-muted">No active {kind}s.</p>
            )}
            {archived.length > 0 && (
              <div className="pw-archived">
                <NxButton
                  aria-expanded={showArchived}
                  aria-controls={`${regionId}-archived`}
                  onClick={() => setShowArchived((value) => !value)}
                >
                  {showArchived ? 'Hide' : 'Show'} archived ({archived.length})
                </NxButton>
                {showArchived && (
                  <ul
                    id={`${regionId}-archived`}
                    className="pw-records"
                    aria-label={`${title} (archived)`}
                  >
                    {archived.map(row)}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
        <ListFooter
          state={state}
          noun={`${kind}s`}
          loadMore={list.loadMore}
          reload={list.reload}
          shown={active.length + (showArchived ? archived.length : 0)}
        />
      </>
    );
  }

  return (
    <Panel
      title={title}
      level={3}
      actions={
        readOnly ? undefined : (
          <NxButton variant="primary" onClick={() => openEditor(null)}>
            New {kind}
          </NxButton>
        )
      }
    >
      {body}
      <RecordEditor<T>
        kind={kind}
        open={editor.open}
        record={editor.record}
        csrfToken={csrfToken}
        refreshCsrf={refreshCsrf}
        onUnauthorized={onUnauthorized}
        create={props.create}
        update={props.update}
        read={props.read}
        onSaved={(record, mode) => {
          if (mode === 'created') list.prependItem(record);
          else list.replaceItem(record);
          announce(
            `${kind === 'epic' ? 'Epic' : 'Milestone'} “${record.title}” ${mode === 'created' ? 'created' : 'saved'} at revision ${record.revision}.`,
          );
          closeEditor(false);
        }}
        onClose={closeEditor}
      />
      <ArchiveDialog<T>
        noun={kind}
        record={archiving}
        csrfToken={csrfToken}
        refreshCsrf={refreshCsrf}
        onUnauthorized={onUnauthorized}
        archive={props.archive}
        read={props.read}
        onArchived={(record) => {
          list.replaceItem(record);
          announce(`${kind === 'epic' ? 'Epic' : 'Milestone'} “${record.title}” is archived.`);
          setArchiving(null);
          focus.restore(fallbackFocus());
        }}
        onLatest={(record) => {
          list.replaceItem(record);
          announce(
            `Showing the latest version of “${record.title}” (revision ${record.revision}).`,
          );
          setArchiving(null);
          focus.restore(fallbackFocus());
        }}
        onClose={(reload) => {
          setArchiving(null);
          focus.restore(fallbackFocus());
          if (reload) list.reload();
        }}
      />
    </Panel>
  );
}
