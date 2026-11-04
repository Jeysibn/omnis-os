import type { AgentProfileVersionResponse } from '@omnis/contracts';
import { SnapshotSections, Section } from './ProfileSections.js';
import { profileHash, versionHash } from './route.js';
import { ArchivedBanner, formatManila, LifecycleBadge, ProvenanceBadge, Text } from './shared.js';

export function VersionSnapshot({ result }: { result: AgentProfileVersionResponse }) {
  const { agent, version, isCurrent } = result;
  const current = agent.currentVersion;
  return (
    <div className="agents-profile">
      <p>
        <a className="agents-back" href={profileHash(agent.id)}>
          ← Back to <Text>{agent.name}</Text>
        </a>
      </p>
      {agent.lifecycle === 'archived' && <ArchivedBanner />}
      <p
        className={`agents-banner ${isCurrent ? 'agents-banner-current' : 'agents-banner-history'}`}
      >
        {isCurrent ? (
          `This is the current version (${version.versionNo}).`
        ) : (
          <>
            You are viewing version {version.versionNo}, an immutable snapshot published{' '}
            {formatManila(version.createdAt)} by <Text>{version.createdBy.displayName}</Text>. It
            may differ from the current profile.
            {current && (
              <>
                {' '}
                <a href={versionHash(agent.id, current.versionNo)}>View current version</a>
              </>
            )}
          </>
        )}
      </p>
      <div className="agents-profile-content">
        <Section id="version" title="Version">
          <dl className="agents-facts">
            <div className="agents-fact">
              <dt>Version</dt>
              <dd>{version.versionNo}</dd>
            </div>
            <div className="agents-fact">
              <dt>Version ID</dt>
              <dd className="agents-mono">
                <Text>{version.versionId}</Text>
              </dd>
            </div>
            <div className="agents-fact">
              <dt>Published</dt>
              <dd>{formatManila(version.createdAt)}</dd>
            </div>
            <div className="agents-fact">
              <dt>Published by</dt>
              <dd>
                <Text>{version.createdBy.displayName}</Text>
              </dd>
            </div>
          </dl>
        </Section>
        <Section id="as-of-now" title="Agent as of now">
          <p className="agents-help">
            These facts are not part of the version snapshot; they show the agent today.
          </p>
          <dl className="agents-facts">
            <div className="agents-fact">
              <dt>Name</dt>
              <dd>
                <Text>{agent.name}</Text>
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
              </dd>
            </div>
          </dl>
        </Section>
        <SnapshotSections version={version} />
      </div>
    </div>
  );
}
