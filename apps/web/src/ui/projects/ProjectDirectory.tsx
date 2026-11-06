import { useMemo, useState } from 'react';
import type { ProjectSummary } from '@omnis/contracts';
import {
  DataTable,
  EmptyState,
  ErrorState,
  LoadingState,
  NxButton,
  Panel,
  SearchFilter,
  type Column,
} from '../design/index.js';
import { readFailureView } from './ProjectDetail.js';
import { useProjectList } from './hooks.js';
import { formatManila, PriorityBadge, ProjectStatusBadge, useFocusOnArrival } from './parts.js';
import { newProjectHash, projectHash, projectsHash } from './route.js';

type Props = {
  showArchived: boolean;
  onUnauthorized: (cause: unknown) => void;
  arrivedByNavigation: boolean;
};

const columns: readonly Column<ProjectSummary>[] = [
  {
    key: 'key',
    header: 'Key',
    render: (project) => <span className="nx-mono">{project.key}</span>,
  },
  {
    key: 'name',
    header: 'Project',
    render: (project) => (
      <a href={projectHash(project.id)} className="pw-title">
        {project.name}
      </a>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    render: (project) => <ProjectStatusBadge status={project.status} />,
  },
  {
    key: 'priority',
    header: 'Priority',
    render: (project) => <PriorityBadge priority={project.priority} />,
  },
  { key: 'updated', header: 'Updated', render: (project) => formatManila(project.updatedAt) },
];

export function ProjectDirectory({ showArchived, onUnauthorized, arrivedByNavigation }: Props) {
  const list = useProjectList(true, onUnauthorized);
  const [query, setQuery] = useState('');
  const headingRef = useFocusOnArrival(arrivedByNavigation, 'directory');
  const ready = list.value.status === 'ready' ? list.value.data : null;

  const visible = useMemo(() => {
    if (!ready) return [];
    const needle = query.trim().toLowerCase();
    return ready.projects.filter(
      (project) =>
        (showArchived || project.status !== 'archived') &&
        (needle === '' ||
          project.name.toLowerCase().includes(needle) ||
          project.key.toLowerCase().includes(needle)),
    );
  }, [ready, query, showArchived]);

  const newButton = (
    <NxButton variant="primary" onClick={() => (window.location.hash = newProjectHash())}>
      New project
    </NxButton>
  );

  let body;
  if (list.value.status === 'loading') body = <LoadingState label="Loading projects…" />;
  else if (list.value.status === 'error') {
    const view = readFailureView(list.value.error, 'project list');
    return (
      <Panel title="Project directory" headingRef={headingRef}>
        <ErrorState
          title={view.title}
          description={view.description}
          onRetry={view.retry ? list.reload : undefined}
        />
      </Panel>
    );
  } else if (ready && ready.projects.length === 0) {
    body = (
      <EmptyState
        title="No projects yet"
        description="Create a project to give related tasks a shared goal."
        action={newButton}
      />
    );
  } else if (ready) {
    const archivedCount = ready.projects.filter((project) => project.status === 'archived').length;
    body = (
      <>
        <div className="pw-toolbar">
          <SearchFilter label="Search projects" value={query} onChange={setQuery} />
          <label className="pw-check">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(event) => {
                window.location.hash = projectsHash(event.target.checked);
              }}
            />
            Show archived projects
          </label>
        </div>
        <p className="nx-muted" data-testid="directory-summary">
          Showing {visible.length} of {ready.total} projects
          {!showArchived && archivedCount > 0
            ? `. ${archivedCount} archived ${archivedCount === 1 ? 'project is' : 'projects are'} hidden.`
            : '.'}
        </p>
        <DataTable
          caption="Projects"
          columns={columns}
          rows={visible}
          rowKey={(project) => project.id}
          empty={{
            title: 'No projects match',
            description: 'Change the search or show archived projects.',
          }}
        />
      </>
    );
  }

  return (
    <Panel
      title="Project directory"
      label="Projects"
      headingRef={headingRef}
      actions={ready && ready.projects.length > 0 ? newButton : undefined}
    >
      {body}
    </Panel>
  );
}
