/** Pure parsing and building of Agents & Profiles hash routes (no router library). */

export type DirectoryFilters = {
  q: string;
  dept: string | null;
  noDept: boolean;
  archived: boolean;
};

export type AgentsRoute =
  | { kind: 'directory'; filters: DirectoryFilters; trailingSlash: boolean }
  | { kind: 'profile'; agentId: string }
  | { kind: 'version'; agentId: string; version: number }
  | { kind: 'malformed' };

export const emptyFilters: DirectoryFilters = { q: '', dept: null, noDept: false, archived: false };

const versionPattern = /^[1-9][0-9]*$/;

function decodeSegment(segment: string): string | null {
  try {
    const value = decodeURIComponent(segment);
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Returns null when the hash is outside the agents feature. */
export function parseAgentsHash(hash: string): AgentsRoute | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const queryStart = raw.indexOf('?');
  const path = queryStart === -1 ? raw : raw.slice(0, queryStart);
  const query = queryStart === -1 ? '' : raw.slice(queryStart + 1);
  const segments = path.split('/');
  if (segments[0] !== 'agents') return null;

  if (segments.length === 1 || (segments.length === 2 && segments[1] === '')) {
    return {
      kind: 'directory',
      filters: parseFilters(query),
      trailingSlash: segments.length === 2,
    };
  }
  if (segments.length === 2) {
    const agentId = decodeSegment(segments[1] ?? '');
    return agentId ? { kind: 'profile', agentId } : { kind: 'malformed' };
  }
  if (segments.length === 4 && segments[2] === 'v') {
    const agentId = decodeSegment(segments[1] ?? '');
    const version = segments[3] ?? '';
    if (!agentId || !versionPattern.test(version) || !Number.isSafeInteger(Number(version)))
      return { kind: 'malformed' };
    return { kind: 'version', agentId, version: Number(version) };
  }
  return { kind: 'malformed' };
}

function parseFilters(query: string): DirectoryFilters {
  const params = new URLSearchParams(query);
  const q = (params.get('q') ?? '').trim();
  const dept = params.get('dept');
  return {
    q,
    dept: dept && dept.length > 0 ? dept : null,
    noDept: params.get('nodept') === '1',
    archived: params.get('archived') === '1',
  };
}

export function directoryHash(filters: DirectoryFilters): string {
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set('q', filters.q.trim());
  if (filters.noDept) params.set('nodept', '1');
  else if (filters.dept) params.set('dept', filters.dept);
  if (filters.archived) params.set('archived', '1');
  const query = params.toString();
  return query ? `#agents?${query}` : '#agents';
}

export const profileHash = (agentId: string) => `#agents/${encodeURIComponent(agentId)}`;
export const versionHash = (agentId: string, version: number) =>
  `#agents/${encodeURIComponent(agentId)}/v/${version}`;
