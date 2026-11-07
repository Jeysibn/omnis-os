import { useId, useMemo, useRef, useState } from 'react';
import type { AgentDirectoryResponse, AgentSummary } from '@omnis/contracts';
import { Search } from 'lucide-react';
import { AgentCard } from './AgentCard.js';
import { directoryHash, emptyFilters, type DirectoryFilters } from './route.js';
import { Notice } from './shared.js';

const NO_DEPARTMENT = '__none__';

function collisionKey(name: string) {
  return name.trim().replace(/\s+/g, ' ').normalize('NFC').toLocaleLowerCase('en');
}

function byName(a: AgentSummary, b: AgentSummary) {
  return (
    a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id, 'en')
  );
}

function matches(agent: AgentSummary, terms: string[]) {
  const haystack = [
    agent.name,
    agent.slug,
    agent.currentVersion?.profession ?? '',
    agent.department?.name ?? '',
  ]
    .join('\n')
    .toLocaleLowerCase('en');
  return terms.every((term) => haystack.includes(term));
}

export function AgentDirectory({
  directory,
  initialFilters,
  onCreate,
}: {
  directory: AgentDirectoryResponse;
  initialFilters: DirectoryFilters;
  onCreate: () => void;
}) {
  const [filters, setFilters] = useState(initialFilters);
  const searchRef = useRef<HTMLInputElement>(null);
  const ids = { search: useId(), dept: useId(), archived: useId() };

  const update = (next: DirectoryFilters) => {
    setFilters(next);
    // Filter state lives in the URL without adding history entries or firing hashchange.
    window.history.replaceState(window.history.state, '', directoryHash(next));
  };

  const agents = directory.agents;
  const collisions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const agent of agents) {
      const key = collisionKey(agent.name);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [agents]);

  const departments = useMemo(() => {
    const seen = new Map<string, string>();
    for (const agent of agents)
      if (agent.department) seen.set(agent.department.id, agent.department.name);
    return [...seen]
      .sort((a, b) => a[1].localeCompare(b[1], 'en'))
      .map(([id, name]) => ({ id, name }));
  }, [agents]);

  const eligible = useMemo(
    () => agents.filter((agent) => filters.archived || agent.lifecycle !== 'archived'),
    [agents, filters.archived],
  );
  const visible = useMemo(() => {
    const terms = filters.q.trim().toLocaleLowerCase('en').split(/\s+/).filter(Boolean);
    return eligible
      .filter((agent) => {
        if (filters.noDept) return agent.department === null;
        if (filters.dept) return agent.department?.id === filters.dept;
        return true;
      })
      .filter((agent) => matches(agent, terms))
      .sort(byName);
  }, [eligible, filters]);

  const unknownDepartment =
    !filters.noDept &&
    filters.dept !== null &&
    !departments.some((item) => item.id === filters.dept);
  const selectValue = filters.noDept ? NO_DEPARTMENT : (filters.dept ?? '');
  const filtering = Boolean(filters.q.trim()) || filters.dept !== null || filters.noDept;

  const clear = () => {
    update({ ...emptyFilters, archived: filters.archived });
    searchRef.current?.focus();
  };

  if (agents.length === 0)
    return (
      <Notice title="No agents yet." detail="Create an agent identity, then define its profile.">
        <button type="button" className="primary-button" onClick={onCreate}>
          Create agent
        </button>
      </Notice>
    );

  const allArchived = eligible.length === 0;

  return (
    <div className="agents-directory">
      <div className="agents-directory-actions">
        <button type="button" className="primary-button" onClick={onCreate}>
          Create agent
        </button>
      </div>
      <form className="agents-toolbar" role="search" onSubmit={(event) => event.preventDefault()}>
        <div className="agents-field agents-field-grow">
          <label htmlFor={ids.search}>Search agents</label>
          <div className="agents-search">
            <Search size={16} aria-hidden="true" />
            <input
              ref={searchRef}
              id={ids.search}
              type="search"
              value={filters.q}
              autoComplete="off"
              onChange={(event) => update({ ...filters, q: event.target.value })}
            />
          </div>
        </div>
        <div className="agents-field">
          <label htmlFor={ids.dept}>Department</label>
          <select
            id={ids.dept}
            value={unknownDepartment ? '__unknown__' : selectValue}
            onChange={(event) => {
              const value = event.target.value;
              update({
                ...filters,
                dept:
                  value === '' || value === NO_DEPARTMENT || value === '__unknown__' ? null : value,
                noDept: value === NO_DEPARTMENT,
              });
            }}
          >
            <option value="">All departments</option>
            {departments.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
            <option value={NO_DEPARTMENT}>No department</option>
            {unknownDepartment && <option value="__unknown__">Unknown department</option>}
          </select>
        </div>
        <div className="agents-check">
          <input
            id={ids.archived}
            type="checkbox"
            checked={filters.archived}
            onChange={(event) => update({ ...filters, archived: event.target.checked })}
          />
          <label htmlFor={ids.archived}>Show archived</label>
        </div>
      </form>
      <p className="agents-legend">
        Profile status describes the profile record. It does not show whether an agent is running.
      </p>
      <p className="agents-count" aria-live="polite">
        Showing {visible.length} of {eligible.length} agents
      </p>
      {allArchived ? (
        <Notice title="All agents are archived." detail="Turn on Show archived to see them." />
      ) : visible.length === 0 ? (
        <div className="agents-notice">
          <strong>No agents match these filters.</strong>
          {filtering && (
            <button type="button" className="secondary-button" onClick={clear}>
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <ul className="agents-grid" aria-label="Agents">
          {visible.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              collision={(collisions.get(collisionKey(agent.name)) ?? 0) > 1}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
