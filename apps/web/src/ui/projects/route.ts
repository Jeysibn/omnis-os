import { ProjectIdSchema } from '@omnis/contracts';

/** Pure parsing and building of Project Workspace hash routes (no router library). */
export type ProjectsRoute =
  | { kind: 'list'; archived: boolean; trailingSlash: boolean }
  | { kind: 'new' }
  | { kind: 'detail'; projectId: string }
  | { kind: 'edit'; projectId: string }
  | { kind: 'malformed' };

/** Returns null when the hash is outside the projects feature. */
export function parseProjectsHash(hash: string): ProjectsRoute | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const queryStart = raw.indexOf('?');
  const path = queryStart === -1 ? raw : raw.slice(0, queryStart);
  const query = queryStart === -1 ? '' : raw.slice(queryStart + 1);
  const segments = path.split('/');
  if (segments[0] !== 'projects') return null;
  if (segments.length === 1 || (segments.length === 2 && segments[1] === '')) {
    return {
      kind: 'list',
      archived: new URLSearchParams(query).get('archived') === '1',
      trailingSlash: segments.length === 2,
    };
  }
  const second = segments[1] ?? '';
  if (segments.length === 2 && second === 'new') return { kind: 'new' };
  let id: string;
  try {
    id = decodeURIComponent(second);
  } catch {
    return { kind: 'malformed' };
  }
  // Only a well-formed project id reaches the API; anything else makes no request.
  if (!ProjectIdSchema.safeParse(id).success) return { kind: 'malformed' };
  if (segments.length === 2) return { kind: 'detail', projectId: id };
  if (segments.length === 3 && segments[2] === 'edit') return { kind: 'edit', projectId: id };
  return { kind: 'malformed' };
}

export const projectsHash = (archived = false) => (archived ? '#projects?archived=1' : '#projects');
export const newProjectHash = () => '#projects/new';
export const projectHash = (projectId: string) => `#projects/${encodeURIComponent(projectId)}`;
export const editProjectHash = (projectId: string) => `${projectHash(projectId)}/edit`;
