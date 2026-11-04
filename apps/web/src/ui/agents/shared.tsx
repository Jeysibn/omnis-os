import type { ReactNode } from 'react';
import type { AgentLifecycle, AgentSummary } from '@omnis/contracts';
import { Archive, CircleCheck, FilePen } from 'lucide-react';
import type { AgentsError } from './data.js';

/** Profile lifecycle labels. These describe the profile record, never runtime activity. */
export const lifecycleLabel: Record<AgentLifecycle, string> = {
  draft: 'Draft',
  available: 'Published',
  archived: 'Archived',
};

export const lifecycleHelp: Record<AgentLifecycle, string> = {
  draft: 'No published profile version yet.',
  available:
    'This profile version is published. This is not a runtime status: it does not mean the agent is running, online, or reachable.',
  archived: "Archived. History is preserved; this agent can't be assigned new work.",
};

export function formatManila(value: string) {
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

/** Untrusted profile text: rendered only as a React text node, never as HTML or markdown. */
export function Text({ children, block = false }: { children: string; block?: boolean }) {
  const Tag = block ? 'div' : 'span';
  return (
    <Tag className="agents-text" dir="auto">
      {children}
    </Tag>
  );
}

export function LifecycleBadge({ lifecycle }: { lifecycle: AgentLifecycle }) {
  const Icon = lifecycle === 'available' ? CircleCheck : lifecycle === 'draft' ? FilePen : Archive;
  return (
    <span className={`agents-badge agents-badge-${lifecycle}`}>
      <Icon size={13} aria-hidden="true" />
      {lifecycleLabel[lifecycle]}
    </span>
  );
}

export function ProvenanceBadge({ agent }: { agent: AgentSummary }) {
  return agent.provenance === 'demo_seed' ? (
    <span className="agents-badge agents-badge-demo">Demo agent (synthetic)</span>
  ) : null;
}

export function Loading({ resource }: { resource: string }) {
  return (
    <div className="resource-loading" role="status">
      Loading {resource}…
    </div>
  );
}

export function Failure({
  resource,
  message,
  onRetry,
}: {
  resource: string;
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="resource-failure" role="alert">
      <div>
        <strong>{resource} unavailable</strong>
        <p>{message}</p>
      </div>
      <button type="button" className="secondary-button" onClick={onRetry}>
        Retry {resource.toLowerCase()}
      </button>
    </div>
  );
}

export function Notice({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: string;
  children?: ReactNode;
}) {
  return (
    <div className="agents-notice" role="status">
      <strong>{title}</strong>
      {detail && <p>{detail}</p>}
      {children}
    </div>
  );
}

/** Error surface shared by every agents screen. 404 is handled by each screen. */
export function ErrorState({
  resource,
  error,
  onRetry,
}: {
  resource: string;
  error: AgentsError;
  onRetry: () => void;
}) {
  if (error.kind === 'forbidden') return <Notice title="You don't have access to agents." />;
  return <Failure resource={resource} message={error.message} onRetry={onRetry} />;
}

export function ArchivedBanner() {
  return (
    <p className="agents-banner agents-banner-archived">
      This agent is archived. History is preserved and the agent can't be assigned new work.
    </p>
  );
}

export function initials(name: string) {
  const letters = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => Array.from(part)[0] ?? '');
  return letters.join('').toLocaleUpperCase('en') || '?';
}
