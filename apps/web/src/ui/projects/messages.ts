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
  'rejected.create.keyTaken': fixed(
    'This project key is already used by another project, including an archived one. Choose a different key.',
  ),
  'rejected.create.limit': fixed(
    "The project limit (500) has been reached. Archiving is permanent, so existing projects can't be removed in this release.",
  ),
  'rejected.notFound': fixed("The server reports that this project doesn't exist."),
  'rejected.edit.stale': fixed(
    'This project changed since you opened it, so your edits were not applied. Your unsaved edits are still in the form.',
  ),
  'rejected.archived': fixed(
    "The server rejected the change: this project is archived, so it can't be changed.",
  ),
  'rejected.archive.stale': fixed(
    'This project changed since you opened it, so it was not archived. Review the latest version, then archive again if you still want to.',
  ),
  'rejected.readbackFailed': fixed(
    "The server rejected the change. Omnis OS couldn't read the latest project state to explain why.",
  ),

  'unknown.create.recheckFailed': fixed(
    "The result of creating this project is unknown, and Omnis OS couldn't check the project list. Check again before trying again.",
  ),
  'unknown.create.matchingRow': ({ name = '' }) =>
    `The result was unknown, but the project list now shows a project with this key and the name ${name}. It was probably created. Open it to confirm the objective.`,
  'unknown.create.keyTaken': ({ name = '' }) =>
    `The result was unknown. The project list shows this key is used by a project named ${name}, which doesn't match what you entered. Choose a different key.`,
  'unknown.create.noMatch': fixed(
    "The result was unknown. The project list doesn't show this project, so it was probably not created. Trying again reuses the same request, which cannot create a duplicate.",
  ),

  'unknown.edit.recheckFailed': fixed(
    "The result of saving is unknown, and Omnis OS couldn't read the project. Check again before trying again.",
  ),
  'unknown.edit.applied': ({ revision = 0 }) =>
    `The result was unknown, but the project now shows your changes at revision ${revision}. They were saved.`,
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
  'unknown.archive.applied': fixed(
    'The result was unknown, but the project is now archived. It is read-only, and there is no restore action.',
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
  'edit.loaded': ({ revision = 0 }) => `Loaded the latest values, revision ${revision}.`,
  'edit.kept': ({ revision = 0 }) =>
    `Your edits are kept on top of the latest version, revision ${revision}. Review them, then save.`,
} satisfies Record<string, Entry>;

export type MessageKey = keyof typeof catalog;
export type Msg = { key: MessageKey; params?: MessageParams };
export const messageText = ({ key, params = {} }: Msg) => catalog[key](params);
