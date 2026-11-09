import { useSyncExternalStore } from 'react';

/**
 * Subscribes to a CSS media query. `useSyncExternalStore` reads the real value on the first
 * client render, so there is no flash of the wrong layout, and removes its listener on unmount.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', notify);
      return () => list.removeEventListener('change', notify);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
