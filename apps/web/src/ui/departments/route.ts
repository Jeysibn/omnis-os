/** Pure parsing of the Department Management hash route. Create and rename are in-page, so they have no routes. */

export type DepartmentsRoute =
  { kind: 'list'; archived: boolean; trailingSlash: boolean } | { kind: 'malformed' };

/** Returns null when the hash is outside the departments feature. */
export function parseDepartmentsHash(hash: string): DepartmentsRoute | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const queryStart = raw.indexOf('?');
  const path = queryStart === -1 ? raw : raw.slice(0, queryStart);
  const query = queryStart === -1 ? '' : raw.slice(queryStart + 1);
  const segments = path.split('/');
  if (segments[0] !== 'departments') return null;
  if (segments.length === 1 || (segments.length === 2 && segments[1] === '')) {
    return {
      kind: 'list',
      archived: new URLSearchParams(query).get('archived') === '1',
      trailingSlash: segments.length === 2,
    };
  }
  return { kind: 'malformed' };
}

export const departmentsHash = (archived: boolean) =>
  archived ? '#departments?archived=1' : '#departments';
