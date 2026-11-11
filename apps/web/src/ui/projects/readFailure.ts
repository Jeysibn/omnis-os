import type { ReadFailure } from './data.js';

/** How a failed read is described to the owner. */
export function readFailureView(error: ReadFailure, noun: string) {
  switch (error.kind) {
    case 'notFound':
      return {
        title: `This ${noun} was not found.`,
        description: 'It may have been removed, or the link is wrong.',
        retry: false,
      };
    case 'forbidden':
      return {
        title: `You don't have access to this ${noun}.`,
        description: undefined,
        retry: false,
      };
    case 'unexpected':
      return {
        title: `Omnis OS received an unexpected ${noun} response.`,
        description: 'Do not repeat any action. Reload the page.',
        retry: true,
      };
    case 'limit':
      return {
        title: `The ${noun} is too large to show reliably.`,
        description: undefined,
        retry: false,
      };
    default:
      return { title: `The ${noun} could not be loaded.`, description: error.message, retry: true };
  }
}
