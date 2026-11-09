import { useEffect, useRef } from 'react';
import type { SystemStateId } from '../systemState.js';
import { createReactorRenderer, type ReactorRenderer, type UnsupportedReason } from './renderer.js';
import type { MarkerCounts } from './visual.js';

/**
 * Hosts the Canvas renderer. This module is the lazy chunk. React renders it once; animation
 * runs inside the renderer, so there are no per-frame React renders. Mounting creates exactly
 * one renderer and unmounting destroys it (loop, observers and backing store included).
 */
export default function ReactorCanvas(props: {
  state: SystemStateId;
  markers: MarkerCounts | null;
  onReady: () => void;
  onUnsupported: (reason: UnsupportedReason) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<ReactorRenderer | null>(null);
  const { onReady, onUnsupported } = props;

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const created = createReactorRenderer(element, { onReady, onUnsupported });
    renderer.current = created;
    return () => {
      created.destroy();
      renderer.current = null;
    };
  }, [onReady, onUnsupported]);

  useEffect(() => {
    renderer.current?.setScene({ state: props.state, markers: props.markers });
  }, [props.state, props.markers]);

  return (
    <canvas ref={canvas} className="ccx-reactor-canvas" aria-hidden="true" data-reactor-canvas />
  );
}
