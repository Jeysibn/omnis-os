import type { HistoryState } from './data.js';
import { versionHash } from './route.js';
import { ErrorState, formatManila, Loading, Text } from './shared.js';

export function VersionHistory({
  agentId,
  state,
  onLoadMore,
  onReload,
}: {
  agentId: string;
  state: HistoryState;
  onLoadMore: () => void;
  onReload: () => void;
}) {
  if (state.status === 'loading') return <Loading resource="version history" />;
  if (state.status === 'error')
    return <ErrorState resource="Version history" error={state.error} onRetry={onReload} />;
  const done = state.complete && state.versions.length === state.total;
  if (state.complete && state.total === 0 && state.versions.length === 0)
    return <p className="agents-muted">No versions published yet.</p>;
  return (
    <div>
      <p className="agents-count" aria-live="polite">
        {done
          ? `${state.total} ${state.total === 1 ? 'version' : 'versions'}`
          : `Showing ${state.versions.length} of ${state.total} versions`}
      </p>
      <ol className="agents-versions" aria-label="Profile versions, newest first">
        {state.versions.map((version) => (
          <li key={version.versionId}>
            <a href={versionHash(agentId, version.versionNo)}>Version {version.versionNo}</a>
            {version.isCurrent && (
              <span className="agents-badge agents-badge-current">Current</span>
            )}
            <span className="agents-version-meta">
              <Text>{[version.profession, version.seniority].filter(Boolean).join(', ')}</Text>
              {' · '}
              {formatManila(version.createdAt)}
              {' · '}
              <Text>{version.createdBy.displayName}</Text>
            </span>
          </li>
        ))}
      </ol>
      {state.problem && (
        <div className="resource-failure" role="alert">
          <div>
            <strong>
              {state.problem.kind === 'changed'
                ? 'History changed while loading'
                : 'Version history could not be completed'}
            </strong>
            <p>
              {state.problem.kind === 'changed'
                ? 'Reload to start again from the first page.'
                : state.problem.message}
            </p>
          </div>
          <button type="button" className="secondary-button" onClick={onReload}>
            Reload history
          </button>
        </div>
      )}
      {!state.complete && !state.problem && (
        <button
          type="button"
          className="secondary-button"
          disabled={state.loadingMore}
          onClick={onLoadMore}
        >
          {state.loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}
