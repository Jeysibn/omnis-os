import { useId } from 'react';
import type { AgentSummary } from '@omnis/contracts';
import { profileHash } from './route.js';
import { initials, LifecycleBadge, ProvenanceBadge, Text } from './shared.js';

export function AgentCard({ agent, collision }: { agent: AgentSummary; collision: boolean }) {
  const contextId = useId();
  const version = agent.currentVersion;
  const role = version
    ? [version.profession, version.seniority].filter(Boolean).join(', ')
    : 'No published version';
  return (
    <li className="agents-card">
      <span className="agents-avatar" aria-hidden="true">
        {initials(agent.name)}
      </span>
      <div className="agents-card-body">
        <h3>
          <a href={profileHash(agent.id)} aria-describedby={contextId}>
            <Text>{agent.name}</Text>
          </a>
        </h3>
        <p id={contextId} className="agents-context">
          <Text>{role}</Text>
          <span> · </span>
          <Text>{agent.department?.name ?? 'No department'}</Text>
          <span> · </span>
          <LifecycleBadge lifecycle={agent.lifecycle} />
          {agent.provenance === 'demo_seed' && (
            <>
              <span> · </span>
              <ProvenanceBadge agent={agent} />
            </>
          )}
          {collision && (
            <>
              <span> · </span>
              <span>
                Slug: <Text>{agent.slug}</Text>
              </span>
            </>
          )}
        </p>
      </div>
    </li>
  );
}
