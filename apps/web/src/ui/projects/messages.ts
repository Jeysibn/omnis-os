/**
 * User-facing copy for the Project Workspace mutation flows. Components render entries only
 * through `<Msg>`, which exposes the key as `data-message-key`, so tests assert the key and the
 * exact text. The wording is deliberately conservative: a message claims only what the evidence
 * in hand supports (a confirmed response, a definitive rejection, or an uncertain outcome).
 */
export type MessageParams = {
  key?: string;
  name?: string;
  revision?: number;
  current?: string;
};
type Entry = (params: MessageParams) => string;
const fixed =
  (text: string): Entry =>
  () =>
    text;

const csrfText = 'Your secure session needs refreshing. The change was not applied. Try again.';
const invalidInputText =
  'The server rejected these values. Check them, and remove anything that looks like a credential or secret.';

export const catalog = {
  'inflight.create': fixed('Creating project…'),
  'inflight.edit': fixed('Saving changes…'),
  'inflight.archive': fixed('Archiving project…'),
  'inflight.check': fixed('Checking the latest project state…'),

  'confirmed.create': ({ key = '', name = '' }) =>
    `The server confirmed the project was created: ${key}, ${name}.`,
  'confirmed.edit': ({ revision = 0 }) =>
    `The server confirmed your changes. The project is now at revision ${revision}.`,
  'confirmed.archive': fixed(
    'The server confirmed this project is archived. It is now read-only, and there is no restore action.',
  ),

  'rejected.csrf': fixed(csrfText),
  'rejected.invalidInput': fixed(invalidInputText),
  'rejected.create.limit': fixed(
    "The project limit (500) has been reached. Archiving is permanent, so existing projects can't be removed in this release.",
  ),
  'rejected.notFound': fixed("The server reports that this project doesn't exist."),
  'rejected.edit.stale': fixed(
    'This project changed since you opened it, so your edits were not applied. Your unsaved edits are still in the form.',
  ),
  'rejected.archive.stale': fixed(
    'This project changed since you opened it, so it was not archived. Review the latest version, then archive again if you still want to.',
  ),

  // A 409 does not say why: duplicate key, stale revision and idempotency-key reuse share one code
  // and one message. These entries state only what a readback of the authoritative state shows.
  'conflict.create.keyInUse': ({ key = '', name = '' }) =>
    `The key ${key} is already used by a project named ${name}. The server reported a conflict, but it doesn't say which condition caused it.`,
  'conflict.create.noMatch': fixed(
    "The server reported a conflict, but the project list doesn't show this key in use, and a conflict response doesn't say why. Your values are kept. You can check again, or create again, which sends a new request.",
  ),
  'conflict.create.readbackFailed': fixed(
    "The server reported a conflict, and Omnis OS couldn't read the project list to check why. Your values are kept. Check again before trying again.",
  ),
  'conflict.edit.sameRevision': ({ revision = 0 }) =>
    `The server reported a conflict, but the project is unchanged at revision ${revision}, so Omnis OS can't tell why. Your edits are kept. You can check again, or save again, which sends a new request.`,
  'conflict.edit.readbackFailed': fixed(
    "The server reported a conflict, and Omnis OS couldn't read the project to check why. Your edits are kept. Check again before saving.",
  ),
  'conflict.archive.sameRevision': ({ revision = 0 }) =>
    `The server reported a conflict, but the project is still active at revision ${revision}, so Omnis OS can't tell why. It was not archived. You can confirm the archive again, which sends a new request.`,
  'conflict.archive.readbackFailed': fixed(
    "The server reported a conflict, and Omnis OS couldn't read the project to check why, so its current state is unconfirmed. Reload the page before trying again.",
  ),
  'conflict.observedArchived': fixed(
    "The project is currently archived, so it can't be changed. The server reported a conflict, and it can't be determined whether this request or something else archived it.",
  ),

  'unknown.create.recheckFailed': fixed(
    "The result of creating this project is unknown, and Omnis OS couldn't check the project list. Check again before trying again.",
  ),
  'unknown.create.matchingRow': ({ name = '' }) =>
    `The result was unknown. The project list shows a project with this key, the name ${name} and this priority. We couldn't confirm whether this request created it. Open it to check.`,
  'unknown.create.keyTaken': ({ name = '' }) =>
    `The result was unknown. The project list shows this key is used by a project named ${name}, which doesn't match what you entered. Choose a different key.`,
  'unknown.create.noMatch': fixed(
    "The result was unknown. The project list doesn't show this project, so it was probably not created. Trying again reuses the same request, which cannot create a duplicate.",
  ),

  'unknown.edit.recheckFailed': fixed(
    "The result of saving is unknown, and Omnis OS couldn't read the project. Check again before trying again.",
  ),
  // Matching values at the next revision are consistent with this request having saved them, but
  // another session could have made the same change, so the write is not attributed to this request.
  'unknown.edit.matching': fixed(
    "The project currently has the requested values. We couldn't confirm whether this request saved them.",
  ),
  'unknown.edit.notApplied': fixed(
    'The result was unknown. The project still shows its previous values, so your changes were probably not saved. Trying again reuses the same request, which cannot apply twice.',
  ),
  'unknown.edit.changed': fixed(
    "The result was unknown, and the project has changed since you opened it. It can't be told whether your edit was applied. Review the latest values before saving again.",
  ),
  'unknown.edit.archived': fixed(
    'The result was unknown, and the project is now archived, so it can no longer be edited.',
  ),
  'unknown.edit.absent': fixed(
    "The result was unknown, and the server reports that this project doesn't exist.",
  ),

  'unknown.archive.recheckFailed': fixed(
    "The result of archiving is unknown, and Omnis OS couldn't read the project. Check again before trying again.",
  ),
  'unknown.archive.observedArchived': fixed(
    "The result was unknown. The project is now archived, and it is read-only with no restore action. We couldn't confirm whether this request archived it.",
  ),
  'unknown.archive.notApplied': fixed(
    'The result was unknown. The project is still not archived. Trying again reuses the same request, which cannot archive twice.',
  ),
  'unknown.archive.changed': fixed(
    'The result was unknown, and the project has changed since you opened it. Review the latest version before archiving.',
  ),
  'unknown.archive.absent': fixed(
    "The result was unknown, and the server reports that this project doesn't exist.",
  ),

  'edit.noChanges': fixed('Change at least one field before saving.'),
  'edit.frozenHint': fixed(
    'The values are locked so a retry sends exactly the request that was sent. Choose Edit values to change them.',
  ),
  'edit.resumed': fixed('You can edit the values again. Saving sends a new request.'),
  'edit.valuesChanged': fixed(
    'The values changed, so the earlier request was not sent. Review them, then save again.',
  ),
  'edit.loaded': ({ revision = 0 }) => `Loaded the latest values, revision ${revision}.`,
  'edit.kept': ({ revision = 0 }) =>
    `Your edits are kept on top of the latest version, revision ${revision}. Review them, then save.`,
} satisfies Record<string, Entry>;

export type MessageKey = keyof typeof catalog;
export type Msg = { key: MessageKey; params?: MessageParams };
export const messageText = ({ key, params = {} }: Msg) => catalog[key](params);
