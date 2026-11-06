import { useEffect, useRef, useState } from 'react';
import { AgentDirectory } from './AgentDirectory.js';
import { AgentProfile } from './AgentProfile.js';
import { fetchDirectory, fetchProfile, fetchVersion, useAgentResource } from './data.js';
import { directoryHash, parseAgentsHash, profileHash, type AgentsRoute } from './route.js';
import { ErrorState, Loading, Notice, Text } from './shared.js';
import { VersionSnapshot } from './VersionSnapshot.js';

const malformed: AgentsRoute = { kind: 'malformed' };

function currentRoute(): AgentsRoute {
  return parseAgentsHash(window.location.hash) ?? malformed;
}

function routeKey(route: AgentsRoute) {
  switch (route.kind) {
    case 'directory':
      return 'directory';
    case 'profile':
      return `profile:${route.agentId}`;
    case 'version':
      return `version:${route.agentId}:${route.version}`;
    default:
      return 'malformed';
  }
}

function notFoundBack() {
  return (
    <p>
      <a href="#agents">Back to the directory</a>
    </p>
  );
}

export function AgentsWorkspace({ onUnauthorized }: { onUnauthorized: (cause: unknown) => void }) {
  const [route, setRoute] = useState<AgentsRoute>(currentRoute);
  // Bumped on every hashchange so the directory re-reads filters from the URL.
  const [navigation, setNavigation] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  const moveFocus = useRef(false);

  useEffect(() => {
    const onHashChange = () => {
      const next = currentRoute();
      moveFocus.current = true;
      setRoute(next);
      setNavigation((value) => value + 1);
      setAnnouncement(
        next.kind === 'directory'
          ? 'Agent directory'
          : next.kind === 'profile'
            ? 'Agent profile'
            : next.kind === 'version'
              ? 'Agent profile version'
              : "This link isn't valid",
      );
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // `#agents/` is normalized to `#agents` without a history entry.
  useEffect(() => {
    if (route.kind === 'directory' && route.trailingSlash)
      window.history.replaceState(window.history.state, '', directoryHash(route.filters));
  }, [route]);

  const key = routeKey(route);
  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    window.requestAnimationFrame(() => headingRef.current?.focus());
  }, [key]);

  return (
    <div className="agents-workspace">
      <div className="sr-only" role="status">
        {announcement}
      </div>
      {route.kind === 'directory' && (
        <DirectoryScreen
          key={navigation}
          route={route}
          headingRef={headingRef}
          onUnauthorized={onUnauthorized}
        />
      )}
      {route.kind === 'profile' && (
        <ProfileScreen route={route} headingRef={headingRef} onUnauthorized={onUnauthorized} />
      )}
      {route.kind === 'version' && (
        <VersionScreen route={route} headingRef={headingRef} onUnauthorized={onUnauthorized} />
      )}
      {route.kind === 'malformed' && (
        <>
          <h2 ref={headingRef} tabIndex={-1}>
            This link isn't valid
          </h2>
          <Notice title="This link isn't valid">{notFoundBack()}</Notice>
        </>
      )}
    </div>
  );
}

type ScreenProps<R extends AgentsRoute> = {
  route: R;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  onUnauthorized: (cause: unknown) => void;
};

function DirectoryScreen({
  route,
  headingRef,
  onUnauthorized,
}: ScreenProps<Extract<AgentsRoute, { kind: 'directory' }>>) {
  const [state, retry] = useAgentResource('directory', fetchDirectory, onUnauthorized);
  return (
    <>
      <div className="agents-head-row">
        <h2 ref={headingRef} tabIndex={-1}>
          Agent directory
        </h2>
        <a className="secondary-button agents-manage" href="#departments">
          Manage departments
        </a>
      </div>
      {state.status === 'loading' && <Loading resource="agents" />}
      {state.status === 'error' && (
        <ErrorState resource="Agents" error={state.error} onRetry={retry} />
      )}
      {state.status === 'ready' && (
        <AgentDirectory directory={state.data} initialFilters={route.filters} />
      )}
    </>
  );
}

function ProfileScreen({
  route,
  headingRef,
  onUnauthorized,
}: ScreenProps<Extract<AgentsRoute, { kind: 'profile' }>>) {
  const [state, retry] = useAgentResource(
    `profile:${route.agentId}`,
    (signal) => fetchProfile(route.agentId, signal),
    onUnauthorized,
  );
  return (
    <>
      <h2 ref={headingRef} tabIndex={-1}>
        {state.status === 'ready' ? <Text>{state.data.agent.name}</Text> : 'Agent profile'}
      </h2>
      {state.status === 'loading' && <Loading resource="agent profile" />}
      {state.status === 'error' &&
        (state.error.kind === 'not-found' ? (
          <Notice title="Agent not found">{notFoundBack()}</Notice>
        ) : (
          <ErrorState resource="Agent profile" error={state.error} onRetry={retry} />
        ))}
      {state.status === 'ready' && (
        <AgentProfile
          key={state.data.agent.id}
          profile={state.data}
          onUnauthorized={onUnauthorized}
        />
      )}
    </>
  );
}

function VersionScreen({
  route,
  headingRef,
  onUnauthorized,
}: ScreenProps<Extract<AgentsRoute, { kind: 'version' }>>) {
  const [state, retry] = useAgentResource(
    `version:${route.agentId}:${route.version}`,
    (signal) => fetchVersion(route.agentId, route.version, signal),
    onUnauthorized,
  );
  return (
    <>
      <h2 ref={headingRef} tabIndex={-1}>
        {state.status === 'ready' ? (
          <>
            <Text>{state.data.agent.name}</Text> - Version {state.data.version.versionNo}
          </>
        ) : (
          `Agent profile version ${route.version}`
        )}
      </h2>
      {state.status === 'loading' && <Loading resource="profile version" />}
      {state.status === 'error' &&
        (state.error.kind === 'not-found' ? (
          <Notice
            title="We couldn't find this agent version."
            detail="The agent or this version may not exist."
          >
            <p>
              <a href={profileHash(route.agentId)}>Open this agent's profile</a>
              {' · '}
              <a href="#agents">Back to the directory</a>
            </p>
          </Notice>
        ) : (
          <ErrorState resource="Profile version" error={state.error} onRetry={retry} />
        ))}
      {state.status === 'ready' && <VersionSnapshot result={state.data} />}
    </>
  );
}
