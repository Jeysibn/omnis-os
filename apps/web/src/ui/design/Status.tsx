import type { ReactNode } from 'react';
import './design.css';

export type StatusTone = 'ok' | 'attention' | 'danger' | 'info' | 'neutral' | 'unknown';

/**
 * A status indicator. The text is required and the shape differs per tone, so the meaning is never
 * carried by colour alone. Use `unknown` (not `neutral`) for state that has not been verified.
 */
export function StatusBadge({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <span className="nx-status" data-tone={tone}>
      {children}
    </span>
  );
}
