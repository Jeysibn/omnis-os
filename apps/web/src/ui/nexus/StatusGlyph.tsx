import type { RunStatus } from '@omnis/contracts';

/** Status shape that matches the reactor's run markers; always paired with a text label. */
export function StatusGlyph({ status }: { status: RunStatus }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8 } as const;
  return (
    <svg
      className={`nx-glyph nx-glyph-${status}`}
      width="14"
      height="14"
      viewBox="0 0 14 14"
      aria-hidden="true"
    >
      {status === 'running' || status === 'stopping' ? (
        <>
          <circle cx="7" cy="7" r="3" fill="currentColor" />
          <circle cx="7" cy="7" r="6" {...common} opacity="0.4" />
        </>
      ) : status === 'queued' ? (
        <circle cx="7" cy="7" r="4" {...common} />
      ) : status === 'completed' ? (
        <circle cx="7" cy="7" r="3" fill="currentColor" />
      ) : status === 'failed' ? (
        <path d="M3 3l8 8M11 3l-8 8" {...common} />
      ) : status === 'interrupted' ? (
        <path d="M7 1.5L12.5 7 7 12.5 1.5 7z" {...common} />
      ) : (
        <path d="M3 7h8" {...common} />
      )}
    </svg>
  );
}
