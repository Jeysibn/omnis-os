import type { Run } from '@omnis/contracts';
import type { SystemStateId } from '../systemState.js';

/**
 * Colours are the NEXUS palette (docs/04-design/OMNIS_NEXUS_UI_UX_SPEC_V2.md section 3) and match the
 * tokens in design/design.css. Canvas cannot read CSS variables cheaply, so they are repeated here.
 */
export type Tint = 'jade' | 'amber' | 'red' | 'slate' | 'blue';
export const PALETTE: Record<Tint, readonly [number, number, number]> = {
  jade: [145, 242, 205],
  amber: [240, 189, 118],
  red: [255, 138, 138],
  slate: [163, 184, 176],
  blue: [157, 184, 255],
};

/**
 * What the Reactor looks like for each system state. The state comes from `deriveSystemState`,
 * which uses only the loaded task and run lists, so nothing here is simulated or inferred from a
 * connection. Only states that move (`animated`) keep an animation loop running; every other
 * state is drawn once and stays still, so attention states are never decorated with fake activity.
 *
 *   energy   nucleus and mesh brightness, 0..1
 *   drift    slow rotation speed in rad/s (0 = still)
 *   orbit    speed of the markers of RUNNING runs along their orbit (0 = still)
 *   dim      overall dimming, 0..1
 *   breathe  nucleus breathing amplitude
 *   frameMs  minimum time between drawn frames: slow ambient motion needs far fewer than 60fps
 */
export type ReactorVisual = {
  energy: number;
  drift: number;
  orbit: number;
  dim: number;
  breathe: number;
  tint: Tint;
  animated: boolean;
  frameMs: number;
};

export const VISUALS: Record<SystemStateId, ReactorVisual> = {
  loading: {
    energy: 0.25,
    drift: 0,
    orbit: 0,
    dim: 0.5,
    breathe: 0,
    tint: 'slate',
    animated: false,
    frameMs: 33,
  },
  unavailable: {
    energy: 0.2,
    drift: 0,
    orbit: 0,
    dim: 0.55,
    breathe: 0,
    tint: 'slate',
    animated: false,
    frameMs: 33,
  },
  idle: {
    energy: 0.5,
    drift: 0.045,
    orbit: 0,
    dim: 0,
    breathe: 0.045,
    tint: 'jade',
    animated: true,
    frameMs: 50,
  },
  queued: {
    energy: 0.6,
    drift: 0.06,
    orbit: 0,
    dim: 0,
    breathe: 0.05,
    tint: 'blue',
    animated: true,
    frameMs: 50,
  },
  active: {
    energy: 0.92,
    drift: 0.1,
    orbit: 1,
    dim: 0,
    breathe: 0.07,
    tint: 'jade',
    animated: true,
    frameMs: 33,
  },
  unknown: {
    energy: 0.4,
    drift: 0,
    orbit: 0,
    dim: 0.25,
    breathe: 0,
    tint: 'slate',
    animated: false,
    frameMs: 33,
  },
  failed: {
    energy: 0.55,
    drift: 0,
    orbit: 0,
    dim: 0.1,
    breathe: 0,
    tint: 'red',
    animated: false,
    frameMs: 33,
  },
  interrupted: {
    energy: 0.55,
    drift: 0,
    orbit: 0,
    dim: 0.1,
    breathe: 0,
    tint: 'amber',
    animated: false,
    frameMs: 33,
  },
  cancelled: {
    energy: 0.4,
    drift: 0,
    orbit: 0,
    dim: 0.2,
    breathe: 0,
    tint: 'slate',
    animated: false,
    frameMs: 33,
  },
};

/** One marker kind per run status that is worth showing. Completed and cancelled draw nothing. */
export const MARKER_KINDS = [
  'running',
  'stopping',
  'queued',
  'failed',
  'interrupted',
  'unknown',
] as const;
export type MarkerKind = (typeof MARKER_KINDS)[number];
export type MarkerCounts = Record<MarkerKind, number>;

/** At most this many markers are drawn per kind. Exact counts are in System vitals. */
export const MARKER_CAP = 4;

export function markerCounts(runs: Run[]): MarkerCounts {
  const counts: MarkerCounts = {
    running: 0,
    stopping: 0,
    queued: 0,
    failed: 0,
    interrupted: 0,
    unknown: 0,
  };
  for (const run of runs) if (run.status in counts) counts[run.status as MarkerKind] += 1;
  return counts;
}

/** Stable text form for the wrapper's data attribute (kinds with at least one run). */
export const describeMarkers = (counts: MarkerCounts | null): string =>
  counts === null
    ? 'none'
    : MARKER_KINDS.filter((kind) => counts[kind] > 0)
        .map((kind) => `${kind}=${counts[kind]}`)
        .join(' ') || 'none';
