import { REPLAY_WINDOW_MS, type UnsafeReason } from './pendingCreate.js';

/**
 * What the owner is told about an unresolved create. Every view says the same four things:
 * what happened, what is known, what is NOT verified, and why creating another is unavailable,
 * and offers only actions that are safe in that state.
 */
export type RecoveryView =
  | { view: 'unknown' }
  | { view: 'candidate'; title: string; revision: number }
  | { view: 'ambiguous'; count: number }
  | { view: 'absent' }
  | { view: 'unreadable' }
  | { view: 'refused'; status: number }
  | { view: 'replay-unverified' }
  | { view: 'blocked'; reason: Exclude<UnsafeReason, 'storage-unavailable'> }
  | { view: 'storage-unavailable' }
  | { view: 'discard-confirm' };

export type RecoveryAction =
  | 'retry'
  | 'checkCreate'
  | 'discard'
  | 'discardConfirm'
  | 'discardCancel'
  | 'recheckStorage'
  | 'close';

export type RecoveryCopy = {
  tone: 'warning' | 'error';
  headline: string;
  what: string;
  known: string[];
  unverified: string[];
  why: string;
  actions: RecoveryAction[];
};

const minutes = Math.round(REPLAY_WINDOW_MS / 60_000);

export function describeRecovery(
  view: RecoveryView,
  noun: 'epic' | 'milestone',
  /** Repeating the saved request is allowed: it is recent enough to trust its idempotency key. */
  replaySafe: boolean,
): RecoveryCopy {
  const locked = `Creating another ${noun} now could produce a duplicate, so this form is locked to this exact request until it is settled.`;
  const sent: string[] = [
    'The request is saved in this browser tab with its original values and its own idempotency key.',
    `Nothing is shown as created.`,
  ];
  const safeActions = (...actions: RecoveryAction[]): RecoveryAction[] => [
    ...(replaySafe ? (['retry'] as const) : []),
    ...actions,
  ];
  switch (view.view) {
    case 'unknown':
      return {
        tone: 'warning',
        headline: 'The result of your create request is unknown.',
        what: `Omnis OS did not get a confirmed result for this create request: the connection ended, or this page was reloaded, before an answer arrived.`,
        known: sent,
        unverified: [`Whether the ${noun} was created.`],
        why: locked,
        actions: safeActions('checkCreate', 'close'),
      };
    case 'candidate':
      return {
        tone: 'warning',
        headline: 'A matching record was found, but it is not confirmed.',
        what: 'One matching record was found, but we cannot confirm whether it was created by your original request.',
        known: [
          `The list shows one new ${noun} with these values: “${view.title}” (revision ${view.revision}).`,
          ...sent,
        ],
        unverified: [
          'Whether it came from your original request or from another action.',
          'Whether your request is still being processed.',
        ],
        why: `${locked} A matching record is only an observation, so it does not settle the request.`,
        actions: safeActions('checkCreate', 'close'),
      };
    case 'ambiguous':
      return {
        tone: 'warning',
        headline: 'Several records could match.',
        what: `${view.count} records in the list fit this request, so Omnis OS cannot tell which one, if any, it created. Nothing was assumed.`,
        known: sent,
        unverified: ['Which record, if any, came from your request.'],
        why: locked,
        actions: safeActions('checkCreate', 'close'),
      };
    case 'absent':
      return {
        tone: 'warning',
        headline: 'No matching record was found.',
        what: `The complete list was read and no new ${noun} with these values was found.`,
        known: ['Every page of the list was read.', ...sent],
        unverified: [
          'Whether the request is still being processed.',
          'Whether the request was applied and is not yet visible.',
        ],
        why: `That is an observation, not proof. ${locked}`,
        actions: safeActions('checkCreate', 'close'),
      };
    case 'unreadable':
      return {
        tone: 'warning',
        headline: 'The list could not be checked.',
        what: `The list could not be read completely, so nothing can be concluded about whether the ${noun} exists.`,
        known: sent,
        unverified: [`Whether the ${noun} exists.`],
        why: locked,
        actions: safeActions('checkCreate', 'close'),
      };
    case 'refused':
      return {
        tone: 'error',
        headline: 'The server refused to repeat this request.',
        what: `The server answered the repeated request with a refusal (${view.status}). A refusal of a repeat does not show that the original request was not applied.`,
        known: sent,
        unverified: [`Whether the original request created the ${noun}.`],
        why: locked,
        actions: ['checkCreate', 'discard', 'close'],
      };
    case 'replay-unverified':
      return {
        tone: 'error',
        headline: 'This request is too old to repeat safely.',
        what: `This request was first sent more than ${minutes} minutes ago. Omnis OS cannot verify that the server still remembers its idempotency key, so sending it again could create a duplicate. It is not being sent, and it has not been discarded.`,
        known: sent,
        unverified: [
          'Whether the server still recognises the key.',
          `Whether the ${noun} was created.`,
        ],
        why: locked,
        actions: ['checkCreate', 'discard', 'close'],
      };
    case 'blocked': {
      const why: Record<typeof view.reason, string> = {
        corrupt: 'It is damaged or incomplete.',
        incompatible: 'It was saved by a version of Omnis OS this one cannot read.',
        foreign: 'It does not belong to the signed-in owner, this project and this record type.',
        clock: 'Its timestamp is not possible.',
      };
      return {
        tone: 'error',
        headline: 'A saved create request cannot be used safely.',
        what: `A saved create request for this ${noun} was found in this browser tab, but it cannot be used. ${why[view.reason]} Its contents are not shown.`,
        known: ['Something was saved for this project and record type.'],
        unverified: [`Whether a ${noun} was created by that request.`],
        why: locked,
        actions: ['discard', 'close'],
      };
    }
    case 'storage-unavailable':
      return {
        tone: 'error',
        headline: 'This tab cannot save recovery information.',
        what: `Session storage is unavailable or not writable in this tab, so a create request could not be kept for recovery.`,
        known: ['No create request was sent from here.'],
        unverified: [],
        why: `Creating a ${noun} is turned off here so that a lost response cannot lead to a duplicate. Allow site storage for this tab, then check again.`,
        actions: ['recheckStorage', 'close'],
      };
    case 'discard-confirm':
      return {
        tone: 'error',
        headline: 'Discard this unresolved request?',
        what: `Discarding removes the saved request and its idempotency key from this tab. It cannot be repeated afterwards.`,
        known: [],
        unverified: [`Whether the ${noun} was already created.`],
        why: `If the server did create it, creating it again will make a duplicate. Check the list first.`,
        actions: ['discardConfirm', 'discardCancel'],
      };
  }
}

export const recoveryActionLabel = (action: RecoveryAction, locked: boolean): string =>
  ({
    retry: 'Send the same request again',
    checkCreate: 'Check the current list',
    discard: 'Discard this unresolved request…',
    discardConfirm: 'Discard the request',
    discardCancel: 'Keep the request',
    recheckStorage: 'Check storage again',
    close: locked ? 'Close (the request stays unresolved)' : 'Close',
  })[action];
