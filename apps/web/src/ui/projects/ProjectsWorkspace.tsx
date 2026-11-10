import { useEffect, useState } from 'react';
import { ErrorState, LoadingState, NxTheme } from '../design/index.js';
import './projects.css';
import { ProjectDetail, readFailureView } from './ProjectDetail.js';
import { ProjectDirectory } from './ProjectDirectory.js';
import { ProjectForm } from './ProjectForm.js';
import { useProject } from './hooks.js';
import type { Msg } from './messages.js';
import { projectHash, parseProjectsHash, projectsHash, type ProjectsRoute } from './route.js';

type Props = {
  /** The signed-in owner's id, from the authenticated session. */
  ownerId: string;
  onUnauthorized: (cause: unknown) => void;
  csrfToken: string;
  refreshCsrf: () => Promise<string>;
  /** True when the user got here by in-app navigation; a direct load never moves focus. */
  arrivedByNavigation: boolean;
};

const malformed: ProjectsRoute = { kind: 'malformed' };
const currentRoute = () => parseProjectsHash(window.location.hash) ?? malformed;

export function ProjectsWorkspace({
  ownerId,
  onUnauthorized,
  csrfToken,
  refreshCsrf,
  arrivedByNavigation,
}: Props) {
  const [route, setRoute] = useState<ProjectsRoute>(currentRoute);
  const [navigations, setNavigations] = useState(0);
  // One confirmation, carried to the next screen and shown there once.
  const [flash, setFlash] = useState<Msg | null>(null);

  useEffect(() => {
    const onHashChange = () => {
      setRoute(currentRoute());
      setNavigations((count) => count + 1);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Only focus after an in-app navigation, never on a direct load.
  const moveFocus = arrivedByNavigation || navigations > 0;

  let content;
  if (route.kind === 'list')
    content = (
      <ProjectDirectory
        showArchived={route.archived}
        onUnauthorized={onUnauthorized}
        arrivedByNavigation={moveFocus}
      />
    );
  else if (route.kind === 'new')
    content = (
      <ProjectForm
        key="new"
        project={null}
        csrfToken={csrfToken}
        refreshCsrf={refreshCsrf}
        onUnauthorized={onUnauthorized}
        autoFocus={moveFocus}
        onCancel={() => (window.location.hash = projectsHash())}
        onSaved={(project, message) => {
          setFlash(message);
          window.location.hash = projectHash(project.id);
        }}
      />
    );
  else if (route.kind === 'detail')
    content = (
      <ProjectDetail
        key={`${ownerId}:${route.projectId}`}
        projectId={route.projectId}
        ownerId={ownerId}
        csrfToken={csrfToken}
        refreshCsrf={refreshCsrf}
        onUnauthorized={onUnauthorized}
        flash={flash}
        arrivedByNavigation={moveFocus}
      />
    );
  else if (route.kind === 'edit')
    content = (
      <EditProject
        key={route.projectId}
        projectId={route.projectId}
        csrfToken={csrfToken}
        refreshCsrf={refreshCsrf}
        onUnauthorized={onUnauthorized}
        autoFocus={moveFocus}
        onSaved={(message) => setFlash(message)}
      />
    );
  else
    content = (
      <ErrorState
        title="This project link is not valid."
        description="Open the project directory and choose a project."
      />
    );

  // A flash belongs to the screen it was raised for; it is cleared once that screen is left.
  useEffect(() => {
    if (!flash || route.kind !== 'detail') return undefined;
    const timer = window.setTimeout(() => setFlash(null), 0);
    return () => window.clearTimeout(timer);
  }, [flash, route]);

  return (
    <NxTheme>
      <div className="pw-surface">{content}</div>
    </NxTheme>
  );
}

function EditProject({
  projectId,
  csrfToken,
  refreshCsrf,
  onUnauthorized,
  autoFocus,
  onSaved,
}: {
  projectId: string;
  csrfToken: string;
  refreshCsrf: () => Promise<string>;
  onUnauthorized: (cause: unknown) => void;
  autoFocus: boolean;
  onSaved: (message: Msg) => void;
}) {
  const project = useProject(projectId, true, onUnauthorized);
  if (project.value.status === 'loading') return <LoadingState label="Loading project…" />;
  if (project.value.status === 'error') {
    const view = readFailureView(project.value.error, 'project');
    return (
      <ErrorState
        title={view.title}
        description={view.description}
        onRetry={view.retry ? project.reload : undefined}
      />
    );
  }
  const loaded = project.value.data;
  if (loaded.status === 'archived')
    return (
      <ErrorState
        title="This project is archived."
        description="Archived projects are read-only, and there is no restore action."
      />
    );
  return (
    <ProjectForm
      project={loaded}
      csrfToken={csrfToken}
      refreshCsrf={refreshCsrf}
      onUnauthorized={onUnauthorized}
      autoFocus={autoFocus}
      onCancel={() => (window.location.hash = projectHash(projectId))}
      onSaved={(saved, message) => {
        onSaved(message);
        window.location.hash = projectHash(saved.id);
      }}
    />
  );
}
