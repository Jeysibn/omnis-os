/**
 * Typed message catalog for the Department Management mutation flows (spec section 7.8).
 *
 * Every entry declares the evidence level it belongs to, the claim types it makes and its exact
 * text. Components render entries only through `Message`, which exposes the key as
 * `data-message-key`, so tests assert the key, the exact text and the declared claim types
 * instead of searching for words.
 */

export type Evidence = 'inflight' | 'confirmed' | 'rejected' | 'unknown';
export type ClaimType =
  'success' | 'failure' | 'cause' | 'observation' | 'uncertainty' | 'progress';

/**
 * Claims each evidence level permits. `inflight` covers progress text before any evidence exists.
 * `rejected` also permits `uncertainty`, because spec 7.5 requires hedged rejection messages
 * ("the slug may already be in use, or the department may be archived").
 */
export const permittedClaims: Record<Evidence, readonly ClaimType[]> = {
  inflight: ['progress'],
  confirmed: ['success', 'progress', 'uncertainty'],
  rejected: ['failure', 'observation', 'uncertainty'],
  unknown: ['uncertainty', 'observation', 'progress'],
};

export type MessageParams = { name?: string; slug?: string; archived?: boolean };
type Entry = {
  evidence: Evidence;
  claims: readonly ClaimType[];
  text: (params: MessageParams) => string;
};

const fixed = (evidence: Evidence, claims: readonly ClaimType[], text: string): Entry => ({
  evidence,
  claims,
  text: () => text,
});

const csrfText = 'Your secure session needs refreshing. The change was not applied. Try again.';
const invalidInputText =
  'The server rejected these values. Check the name and slug, and remove anything that looks like a credential or secret.';

export const catalog = {
  'inflight.create': fixed('inflight', ['progress'], 'Creating department…'),
  'inflight.rename': fixed('inflight', ['progress'], 'Saving department…'),
  'inflight.check': fixed('inflight', ['progress'], 'Checking departments…'),

  'confirmed.create': {
    evidence: 'confirmed',
    claims: ['success'],
    text: ({ name = '', slug = '' }) =>
      `The server confirmed the department was created: name ${name}, slug ${slug}.`,
  },
  'confirmed.rename': {
    evidence: 'confirmed',
    claims: ['success'],
    text: ({ name = '', slug = '' }) =>
      `The server confirmed the update: name ${name}, slug ${slug}.`,
  },
  'confirmed.listStale': fixed(
    'confirmed',
    ['uncertainty'],
    "The department list couldn't be refreshed, so what is shown may be out of date.",
  ),

  'rejected.create.csrf': fixed('rejected', ['failure'], csrfText),
  'rejected.create.slugTaken': fixed(
    'rejected',
    ['failure'],
    'This slug is already used by another department (including an archived one). Choose a different slug.',
  ),
  'rejected.create.invalidInput': fixed('rejected', ['failure'], invalidInputText),
  'rejected.create.limit': fixed(
    'rejected',
    ['failure'],
    "The department limit (500) has been reached. Archive is permanent, so existing departments can't be removed in this release.",
  ),
  'rejected.rename.csrf': fixed('rejected', ['failure'], csrfText),
  'rejected.rename.invalidInput': fixed('rejected', ['failure'], invalidInputText),
  'rejected.rename.notFound': fixed(
    'rejected',
    ['failure'],
    "The server reports that this department doesn't exist.",
  ),
  'rejected.rename.readbackFailed': fixed(
    'rejected',
    ['failure', 'uncertainty'],
    "The server rejected the rename. Omnis OS couldn't check why. The slug may already be in use, or the department may be archived.",
  ),
  'rejected.rename.absent': fixed(
    'rejected',
    ['failure', 'observation'],
    "The server rejected the rename, and this department doesn't appear in the latest list.",
  ),
  'rejected.rename.archived': fixed(
    'rejected',
    ['failure', 'observation'],
    "The server rejected the rename. The department currently appears as archived, so it can't be changed.",
  ),
  'rejected.rename.conflictOtherSlug': fixed(
    'rejected',
    ['failure', 'observation'],
    'Another department currently uses this slug (an archived department keeps its slug). Choose a different slug.',
  ),
  'rejected.rename.inconclusive': fixed(
    'rejected',
    ['failure', 'uncertainty'],
    "The server rejected the rename, but the latest list doesn't show why. Something may have changed in between. Reload and try again.",
  ),

  'unknown.create.outcome': fixed(
    'unknown',
    ['uncertainty'],
    'The outcome of creating this department is unknown.',
  ),
  'unknown.create.recheckFailed': fixed(
    'unknown',
    ['uncertainty'],
    "Omnis OS couldn't check either, so the outcome is still unknown.",
  ),
  'unknown.create.matchingRow': fixed(
    'unknown',
    ['observation', 'uncertainty'],
    "The latest list includes a department with this slug and name. It may be the one you submitted or one created elsewhere; Omnis OS can't tell.",
  ),
  'unknown.create.slugTaken': {
    evidence: 'unknown',
    claims: ['observation'],
    text: ({ name = '', archived = false }) =>
      `The latest list has a department with this slug, named “${name}”${archived ? ', archived' : ''}. Choose a different slug.`,
  },
  'unknown.create.noMatch': fixed(
    'unknown',
    ['uncertainty'],
    "No department with this slug appears in the latest list. This doesn't prove the create failed: a late commit can't be ruled out. If it does commit later, trying again would report the slug as taken.",
  ),

  'unknown.rename.outcome': fixed(
    'unknown',
    ['uncertainty'],
    'The outcome of this rename is unknown.',
  ),
  'unknown.rename.recheckFailed': fixed(
    'unknown',
    ['uncertainty'],
    "Omnis OS couldn't check either, so the outcome is still unknown.",
  ),
  'unknown.rename.absent': fixed(
    'unknown',
    ['observation', 'uncertainty'],
    "This department doesn't appear in the latest list, so the outcome of the rename can't be determined.",
  ),
  'unknown.rename.requestedValues': {
    evidence: 'unknown',
    claims: ['observation', 'uncertainty'],
    text: ({ name = '', slug = '' }) =>
      `The department currently has the name ${name} and the slug ${slug}. This may be the result of your request or of another change; Omnis OS can't tell.`,
  },
  'unknown.rename.previousValues': fixed(
    'unknown',
    ['observation', 'uncertainty'],
    "The department currently still has its previous name and slug. This doesn't prove the request never reached the server.",
  ),
  'unknown.rename.otherValues': {
    evidence: 'unknown',
    claims: ['observation', 'uncertainty'],
    text: ({ name = '', slug = '' }) =>
      `The department currently has the name ${name} and the slug ${slug}, which differs from your change and from its earlier values. It may have been changed elsewhere.`,
  },
  'unknown.rename.archived': fixed(
    'unknown',
    ['observation', 'uncertainty'],
    "The department currently appears as archived, so it can't be renamed. Omnis OS can't tell whether that happened before or after your request.",
  ),
} as const satisfies Record<string, Entry>;

export type MessageKey = keyof typeof catalog;
export type Msg = { key: MessageKey; params?: MessageParams };

export const messageText = ({ key, params = {} }: Msg): string =>
  (catalog[key] as Entry).text(params);
