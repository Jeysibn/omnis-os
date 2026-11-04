import { useEffect, useMemo, useRef, useState } from 'react';
import type { Run } from '@omnis/contracts';
import { ReactorFallback } from './ReactorFallback.js';
import { createReactor, type BeadInput, type ReactorController } from './reactorRenderer.js';
import type { ReactorState } from './reactorState.js';
import { isActiveStatus } from './vitals.js';
import { useMediaQuery } from './useMediaQuery.js';

type Props = {
  state: ReactorState;
  runs: Run[];
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
};

/**
 * Isolated visualization. It receives a derived state and a list of real runs; it holds no
 * authority over task or run state, and everything it shows is also available as text.
 */
export function Reactor({ state, runs, selectedRunId, onSelectRun }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const onSelectRef = useRef(onSelectRun);
  const [controller, setController] = useState<ReactorController | null>(null);
  const [failed, setFailed] = useState(false);
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const compact = useMediaQuery('(max-width: 767px)');
  const animated = !reduced && !compact;

  useEffect(() => {
    onSelectRef.current = onSelectRun;
  }, [onSelectRun]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (failed || !canvas) return;
    let instance: ReactorController;
    try {
      instance = createReactor(canvas, {
        quality: compact ? 'lite' : 'full',
        animate: animated,
        onSelectBead: (id) => onSelectRef.current(id),
      });
    } catch {
      setFailed(true);
      return;
    }
    let onScreen = true;
    const sync = () => instance.setPaused(!onScreen || document.hidden);
    const resize = new ResizeObserver(() => instance.resize());
    resize.observe(canvas);
    const visibility = new IntersectionObserver((entries) => {
      onScreen = entries.some((entry) => entry.isIntersecting);
      sync();
    });
    visibility.observe(canvas);
    document.addEventListener('visibilitychange', sync);
    setController(instance);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      visibility.disconnect();
      resize.disconnect();
      instance.destroy();
      setController(null);
    };
  }, [failed, compact, animated]);

  const beads = useMemo<BeadInput[]>(
    () =>
      [...runs]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 6)
        .map((run) => ({ id: run.id, status: run.status, active: isActiveStatus(run.status) })),
    [runs],
  );

  useEffect(() => controller?.setVisual(state.visual), [controller, state.visual]);
  useEffect(() => controller?.setBeads(beads), [controller, beads]);
  useEffect(() => controller?.setSelected(selectedRunId), [controller, selectedRunId]);

  return (
    <div
      className="reactor"
      data-reactor-state={state.id}
      data-reactor-mode={failed ? 'unavailable' : animated ? 'animated' : 'static'}
    >
      <div className="reactor-grid" aria-hidden="true" />
      {failed ? (
        <ReactorFallback dim={state.visual.dim > 0.3} />
      ) : (
        <canvas ref={canvasRef} className="reactor-canvas" aria-hidden="true" />
      )}
      {failed && (
        <p className="reactor-note" role="status">
          Visualization unavailable. All controls and operational data remain available.
        </p>
      )}
    </div>
  );
}
