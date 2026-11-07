import { useRef } from 'react';
import type { AgentProfileResponse } from '@omnis/contracts';
import { AgentArchiveAction } from './AgentArchiveAction.js';
import { useVersionHistory } from './data.js';
import { AgentProfileEditor } from './AgentProfileEditor.js';
import { PermissionsNote, Section, SnapshotSections } from './ProfileSections.js';
import { versionHash } from './route.js';
import {
  ArchivedBanner,
  formatManila,
  LifecycleBadge,
  lifecycleHelp,
  ProvenanceBadge,
  Text,
} from './shared.js';
import { VersionHistory } from './VersionHistory.js';

const sections = [
  { id: 'identity', label: 'Identity' },
  { id: 'profession', label: 'Profession' },
  { id: 'personality', label: 'Personality and behavior' },
  { id: 'instructions', label: 'Instructions' },
  { id: 'current', label: 'Current version' },
  { id: 'history', label: 'Version history' },
  { id: 'permissions', label: 'Permissions' },
];

export function AgentProfile({
  profile,
  csrfToken,
  onUnauthorized,
  onReload,
  onConflict,
  onPublished,
}: {
  profile: AgentProfileResponse;
  csrfToken: string;
  onUnauthorized: (cause: unknown) => void;
  onReload: () => void;
  onConflict: () => void;
  onPublished: () => void;
}) {
  const { agent, currentVersion } = profile;
  const history = useVersionHistory(agent.id, onUnauthorized);
  const rootRef = useRef<HTMLDivElement>(null);
  const goTo = (id: string) => {
    const heading = rootRef.current?.querySelector<HTMLElement>(`#agents-${id}-heading`);
    heading?.scrollIntoView({ block: 'start' });
    heading?.focus();
  };
  const noVersion = <p className="agents-muted">No published version yet.</p>;

  return (
    <div ref={rootRef} className="agents-profile">
      <p>
        <a className="agents-back" href="#agents">
          ← Agents
        </a>
      </p>
      <AgentArchiveAction
        profile={profile}
        csrfToken={csrfToken}
        onUnauthorized={onUnauthorized}
        onArchived={onReload}
      />
      {agent.lifecycle === 'archived' && <ArchivedBanner />}
      <div className="agents-profile-layout">
        <nav className="agents-section-nav" aria-label="Profile sections">
          <ul>
            {sections.map((item) => (
              <li key={item.id}>
                <button type="button" onClick={() => goTo(item.id)}>
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="agents-profile-content">
          <AgentProfileEditor
            profile={profile}
            csrfToken={csrfToken}
            onUnauthorized={onUnauthorized}
            onConflict={() => {
              onConflict();
              onReload();
              history.reload();
            }}
            onPublished={() => {
              onPublished();
              onReload();
              history.reload();
            }}
          />
          <Section id="identity" title="Identity">
            <dl className="agents-facts">
              <div className="agents-fact">
                <dt>Name</dt>
                <dd>
                  <Text>{agent.name}</Text>
                </dd>
              </div>
              <div className="agents-fact">
                <dt>Slug</dt>
                <dd>
                  <Text>{agent.slug}</Text>
                </dd>
              </div>
              <div className="agents-fact">
                <dt>Department</dt>
                <dd>
                  {agent.department ? (
                    <Text>{agent.department.name}</Text>
                  ) : (
                    <span className="agents-muted">No department</span>
                  )}
                </dd>
              </div>
              <div className="agents-fact">
                <dt>Profile status</dt>
                <dd>
                  <LifecycleBadge lifecycle={agent.lifecycle} /> <ProvenanceBadge agent={agent} />
                  <span className="agents-help">{lifecycleHelp[agent.lifecycle]}</span>
                </dd>
              </div>
              <div className="agents-fact">
                <dt>Created</dt>
                <dd>{formatManila(agent.createdAt)}</dd>
              </div>
              <div className="agents-fact">
                <dt>Updated</dt>
                <dd>{formatManila(agent.updatedAt)}</dd>
              </div>
            </dl>
          </Section>
          {currentVersion ? (
            <SnapshotSections version={currentVersion} />
          ) : (
            <>
              <Section id="profession" title="Profession">
                {noVersion}
              </Section>
              <Section id="personality" title="Personality and behavior">
                {noVersion}
              </Section>
              <Section id="instructions" title="Instructions">
                {noVersion}
              </Section>
            </>
          )}
          <Section id="current" title="Current version">
            {currentVersion ? (
              <p>
                <a href={versionHash(agent.id, currentVersion.versionNo)}>
                  Version {currentVersion.versionNo}
                </a>
                , published {formatManila(currentVersion.createdAt)} by{' '}
                <Text>{currentVersion.createdBy.displayName}</Text>
              </p>
            ) : (
              noVersion
            )}
          </Section>
          <Section id="history" title="Version history">
            <VersionHistory
              agentId={agent.id}
              state={history.state}
              onLoadMore={history.loadMore}
              onReload={history.reload}
            />
          </Section>
          <PermissionsNote />
        </div>
      </div>
    </div>
  );
}
