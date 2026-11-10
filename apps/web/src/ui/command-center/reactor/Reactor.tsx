import { Suspense, lazy, useCallback, useState } from 'react';
import type { SystemStateId } from '../systemState.js';
import { useMediaQuery } from '../useMediaQuery.js';
import { ReactorErrorBoundary } from './ErrorBoundary.js';
import { ReactorStatic } from './ReactorStatic.js';
import { describeMarkers, type MarkerCounts } from './visual.js';
import './reactor.css';

/** Only the Canvas renderer is lazy; the static SVG and geometry ship with the Command Center. */
const ReactorCanvas = lazy(() => import('./ReactorCanvas.js'));

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
export type ReactorMode = 'loading' | 'enhanced' | 'reduced' | 'fallback';

/**
 * The cinematic centrepiece of the stage. Purely decorative (hidden from assistive technology):
 * every fact it expresses is also stated in text, in the system-state readout, the vitals and the
 * attention panel. It never mounts for reduced-motion users, and if the renderer fails to load,
 * to create a canvas context, or to keep up, the static SVG stays and the stage is never empty.
 */
export function Reactor({
  state,
  markers,
}: {
  state: SystemStateId;
  markers: MarkerCounts | null;
}) {
  const reduced = useMediaQuery(REDUCED_MOTION_QUERY);
  const [phase, setPhase] = useState<'pending' | 'enhanced' | 'fallback'>('pending');
  const onReady = useCallback(() => setPhase((p) => (p === 'fallback' ? p : 'enhanced')), []);
  const onFailed = useCallback(() => setPhase('fallback'), []);
  const mode: ReactorMode = reduced
    ? 'reduced'
    : phase === 'fallback'
      ? 'fallback'
      : phase === 'enhanced'
        ? 'enhanced'
        : 'loading';
  return (
    <div
      className="ccx-reactor"
      aria-hidden="true"
      data-reactor-mode={mode}
      data-reactor-state={state}
      data-markers={describeMarkers(markers)}
    >
      {mode !== 'enhanced' && <ReactorStatic markers={markers} />}
      {!reduced && phase !== 'fallback' && (
        <ReactorErrorBoundary onError={onFailed}>
          <Suspense fallback={null}>
            <ReactorCanvas
              state={state}
              markers={markers}
              onReady={onReady}
              onUnsupported={onFailed}
            />
          </Suspense>
        </ReactorErrorBoundary>
      )}
    </div>
  );
}
