import type { SystemStateId } from '../systemState.js';
import { ORBITS, buildMesh, orbitPoint, project, type Mesh, type Projected } from './geometry.js';
import {
  MARKER_CAP,
  MARKER_KINDS,
  PALETTE,
  VISUALS,
  type MarkerCounts,
  type MarkerKind,
  type ReactorVisual,
} from './visual.js';

export type ReactorScene = { state: SystemStateId; markers: MarkerCounts | null };
export type UnsupportedReason = 'context' | 'slow' | 'error';
export type RendererCallbacks = {
  /** Called once, after the first frame has been drawn. */
  onReady: () => void;
  /** The renderer cannot (or should no longer) draw; the caller shows the static fallback. */
  onUnsupported: (reason: UnsupportedReason) => void;
};
export type ReactorRenderer = { setScene: (scene: ReactorScene) => void; destroy: () => void };

type Quality = 'full' | 'lite';
const QUALITY = {
  full: { nodes: 300, shell: 480 },
  lite: { nodes: 140, shell: 150 },
} as const;

/** Frames per second are capped per state (VISUALS[state].frameMs); this is the cap while easing between states. */
const TRANSITION_FRAME_MS = 33;
/** Measured draw time (ms, rolling average) above which quality drops, then the Reactor gives up. */
const LITE_AT_MS = 10;
const GIVE_UP_AT_MS = 22;
const SAMPLE_WINDOW = 45;
const INTRO_SECONDS = 1.2;
const MAX_BACKING_PIXELS = 1_600_000;

const meshes: Partial<Record<Quality, Mesh>> = {};
const meshFor = (quality: Quality): Mesh =>
  (meshes[quality] ??= buildMesh({
    ...QUALITY[quality],
    links: 3,
    distance: quality === 'full' ? 0.4 : 0.62,
  }));

type Numbers = { energy: number; drift: number; orbit: number; dim: number; breathe: number };
const numbersOf = (v: ReactorVisual): Numbers => ({
  energy: v.energy,
  drift: v.drift,
  orbit: v.orbit,
  dim: v.dim,
  breathe: v.breathe,
});

const rgba = (c: readonly number[], a: number) =>
  `rgba(${Math.round(c[0]!)},${Math.round(c[1]!)},${Math.round(c[2]!)},${Math.min(Math.max(a, 0), 1).toFixed(3)})`;

export function createReactorRenderer(
  canvas: HTMLCanvasElement,
  callbacks: RendererCallbacks,
): ReactorRenderer {
  const context = canvas.getContext('2d');
  if (!context) {
    callbacks.onUnsupported('context');
    return { setScene: () => undefined, destroy: () => undefined };
  }
  const ctx: CanvasRenderingContext2D = context;
  const parent = canvas.parentElement;

  let destroyed = false;
  let raf = 0;
  let lastTick = 0;
  let clock = 0; // animation seconds; advances only while frames are drawn
  let yaw = 0.6;
  let intro = 0;
  let ready = false;
  let quality: Quality = 'full';
  let mesh = meshFor(quality);
  let px = new Float32Array(mesh.count * 2);
  let pz = new Float32Array(mesh.count);
  let size = { w: 0, h: 0, dpr: 1 };
  let documentVisible = document.visibilityState === 'visible';
  let onScreen = true;
  let scene: ReactorScene = { state: 'loading', markers: null };
  let target = numbersOf(VISUALS.loading);
  const current = { ...target };
  let tint: readonly number[] = PALETTE[VISUALS.loading.tint];
  let tintNow: number[] = [...tint];
  const samples: number[] = [];
  const scratch: Projected = { x: 0, y: 0, z: 0, scale: 1 };

  const wantsFrames = () => !destroyed && documentVisible && onScreen && size.w > 0;
  const transitioning = () =>
    (Object.keys(target) as Array<keyof Numbers>).some(
      (k) => Math.abs(current[k] - target[k]) > 0.004,
    ) || tintNow.some((v, i) => Math.abs(v - tint[i]!) > 0.6);
  const needsMotion = () => intro < 1 || transitioning() || VISUALS[scene.state].animated;

  function setLoopState(running: boolean) {
    canvas.dataset.reactorLoop = running ? 'running' : 'idle';
  }

  /** The only place a frame is scheduled; the handle guard makes a second loop impossible. */
  function request() {
    if (raf !== 0 || !wantsFrames()) return;
    raf = requestAnimationFrame(tick);
    setLoopState(true);
  }
  function cancel() {
    if (raf !== 0) cancelAnimationFrame(raf);
    raf = 0;
    lastTick = 0;
    setLoopState(false);
  }

  function resize() {
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const w = Math.max(0, Math.floor(rect.width));
    const h = Math.max(0, Math.floor(rect.height));
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    while (w * h * dpr * dpr > MAX_BACKING_PIXELS && dpr > 1) dpr -= 0.25;
    if (w === size.w && h === size.h && dpr === size.dpr) return;
    size = { w, h, dpr };
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    request();
  }

  function setQuality(next: Quality) {
    quality = next;
    mesh = meshFor(next);
    px = new Float32Array(mesh.count * 2);
    pz = new Float32Array(mesh.count);
    canvas.dataset.reactorQuality = next;
  }

  function drawMarker(kind: MarkerKind, index: number, time: number) {
    const orbitIndex =
      kind === 'running' || kind === 'stopping'
        ? 0
        : kind === 'queued' || kind === 'unknown'
          ? 1
          : 2;
    const orbit = ORBITS[orbitIndex]!;
    const base = MARKER_KINDS.indexOf(kind) * 1.37 + index * 0.95;
    const angle =
      kind === 'running' ? base + time * orbit.rate * 2.4 * Math.max(current.orbit, 0.0001) : base;
    const [x, y, z] = orbitPoint(orbit, angle);
    project(x, y, z, yaw, scratch);
    const s = Math.min(size.w, size.h) * 0.3;
    const cx = size.w / 2 + scratch.x * s;
    const cy = size.h / 2 + scratch.y * s;
    const r = 3.2 * scratch.scale;
    const fade = Math.min(Math.max(0.55 + scratch.z * 0.18, 0.35), 1);
    ctx.lineWidth = 1.6;
    ctx.setLineDash([]);
    switch (kind) {
      case 'running':
        ctx.fillStyle = rgba(PALETTE.jade, fade);
        ctx.beginPath();
        ctx.arc(cx, cy, r + 0.8, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'stopping':
        ctx.fillStyle = rgba(PALETTE.amber, fade);
        ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
        break;
      case 'queued':
        ctx.strokeStyle = rgba(PALETTE.blue, fade);
        ctx.beginPath();
        ctx.arc(cx, cy, r + 0.6, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case 'unknown':
        ctx.strokeStyle = rgba([234, 244, 238], fade);
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.arc(cx, cy, r + 1, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        break;
      case 'failed':
        ctx.fillStyle = rgba(PALETTE.red, fade);
        ctx.beginPath();
        ctx.moveTo(cx, cy - r - 1);
        ctx.lineTo(cx + r + 1, cy + r);
        ctx.lineTo(cx - r - 1, cy + r);
        ctx.closePath();
        ctx.fill();
        break;
      case 'interrupted':
        ctx.fillStyle = rgba(PALETTE.amber, fade);
        ctx.beginPath();
        ctx.moveTo(cx, cy - r - 1);
        ctx.lineTo(cx + r + 1, cy);
        ctx.lineTo(cx, cy + r + 1);
        ctx.lineTo(cx - r - 1, cy);
        ctx.closePath();
        ctx.fill();
        break;
    }
  }

  function draw() {
    const { w, h, dpr } = size;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    const unit = Math.min(w, h) * 0.3;
    const cx = w / 2;
    const cy = h / 2;
    const level = (1 - current.dim) * Math.min(intro, 1);
    const grow = 0.88 + 0.12 * Math.min(intro, 1);
    const breath = 1 + current.breathe * Math.sin((clock * Math.PI * 2) / 6);

    // Atmosphere: a soft tinted glow behind everything.
    // Radius reaches the canvas edge (half its size) so the glow fades to zero before it is clipped.
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(w, h) / 2);
    glow.addColorStop(0, rgba(tintNow, 0.2 * current.energy * level));
    glow.addColorStop(1, rgba(tintNow, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    // Secondary shell: dim, wide particles for depth.
    for (let i = 0; i < mesh.shellCount; i++) {
      project(
        mesh.shell[i * 3]! * grow,
        mesh.shell[i * 3 + 1]! * grow,
        mesh.shell[i * 3 + 2]! * grow,
        yaw * 0.6,
        scratch,
      );
      const twinkle = 0.65 + 0.35 * Math.sin(clock * 0.8 + mesh.shellPhase[i]!);
      const depth = Math.min(Math.max(0.5 + scratch.z * 0.16, 0.15), 1);
      ctx.fillStyle = rgba(tintNow, 0.32 * depth * twinkle * level);
      const s = 1.1 * scratch.scale;
      ctx.fillRect(cx + scratch.x * unit - s / 2, cy + scratch.y * unit - s / 2, s, s);
    }

    // Primary mesh nodes and strands.
    for (let i = 0; i < mesh.count; i++) {
      project(
        mesh.pos[i * 3]! * grow,
        mesh.pos[i * 3 + 1]! * grow,
        mesh.pos[i * 3 + 2]! * grow,
        yaw,
        scratch,
      );
      px[i * 2] = cx + scratch.x * unit;
      px[i * 2 + 1] = cy + scratch.y * unit;
      pz[i] = scratch.z;
    }
    ctx.lineWidth = 0.8;
    for (let bin = 0; bin < 3; bin++) {
      ctx.strokeStyle = rgba(tintNow, (0.09 + bin * 0.1) * current.energy * level);
      ctx.beginPath();
      for (let e = 0; e < mesh.edges.length; e += 2) {
        const a = mesh.edges[e]!;
        const b = mesh.edges[e + 1]!;
        const depth = Math.min(Math.max(((pz[a]! + pz[b]!) / 2 + 1.4) / 2.8, 0), 0.999);
        if (Math.floor(depth * 3) !== bin) continue;
        ctx.moveTo(px[a * 2]!, px[a * 2 + 1]!);
        ctx.lineTo(px[b * 2]!, px[b * 2 + 1]!);
      }
      ctx.stroke();
    }
    for (let bin = 0; bin < 3; bin++) {
      ctx.fillStyle = rgba(tintNow, (0.35 + bin * 0.28) * current.energy * level);
      ctx.beginPath();
      const r = 1 + bin * 0.55;
      for (let i = 0; i < mesh.count; i++) {
        const depth = Math.min(Math.max((pz[i]! + 1.4) / 2.8, 0), 0.999);
        if (Math.floor(depth * 3) !== bin) continue;
        const twinkle = 0.85 + 0.15 * Math.sin(clock * 1.1 + mesh.phase[i]!);
        ctx.moveTo(px[i * 2]! + r * twinkle, px[i * 2 + 1]!);
        ctx.arc(px[i * 2]!, px[i * 2 + 1]!, r * twinkle, 0, Math.PI * 2);
      }
      ctx.fill();
    }

    // Orbital paths: sparse, thin, differently angled.
    ctx.lineWidth = 0.9;
    ORBITS.forEach((orbit, index) => {
      ctx.strokeStyle = rgba(tintNow, (0.1 + 0.05 * index) * (0.5 + 0.5 * current.energy) * level);
      ctx.beginPath();
      for (let s = 0; s <= 72; s++) {
        const [x, y, z] = orbitPoint(orbit, (s / 72) * Math.PI * 2);
        project(x, y, z, yaw, scratch);
        const sx = cx + scratch.x * unit;
        const sy = cy + scratch.y * unit;
        if (s === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      }
      ctx.stroke();
    });

    // Nucleus: white-jade core into the tint, breathing at low amplitude.
    const core = unit * 0.34 * breath * grow;
    const nucleus = ctx.createRadialGradient(cx, cy, 0, cx, cy, core * 2.6);
    nucleus.addColorStop(0, rgba([240, 255, 249], 0.95 * level));
    nucleus.addColorStop(0.25, rgba(tintNow, 0.7 * current.energy * level));
    nucleus.addColorStop(1, rgba(tintNow, 0));
    ctx.fillStyle = nucleus;
    ctx.beginPath();
    ctx.arc(cx, cy, core * 2.6, 0, Math.PI * 2);
    ctx.fill();

    // Markers: present only for runs that exist in the loaded list; capped per kind.
    ctx.globalCompositeOperation = 'source-over';
    if (scene.markers && current.dim < 0.5) {
      for (const kind of MARKER_KINDS) {
        const count = Math.min(scene.markers[kind], MARKER_CAP);
        for (let i = 0; i < count; i++) drawMarker(kind, i, clock);
      }
    }
  }

  function tick(now: number) {
    raf = 0;
    if (!wantsFrames()) {
      setLoopState(false);
      return;
    }
    const interval =
      intro < 1 || transitioning() ? TRANSITION_FRAME_MS : VISUALS[scene.state].frameMs;
    if (lastTick !== 0 && now - lastTick < interval - 2) {
      request();
      return;
    }
    const dt = lastTick === 0 ? 0 : Math.min((now - lastTick) / 1000, 0.1);
    lastTick = now;
    clock += dt;
    intro = Math.min(intro + dt / INTRO_SECONDS, 1);
    yaw += dt * current.drift;
    const k = 1 - Math.exp(-dt / 0.35);
    for (const key of Object.keys(target) as Array<keyof Numbers>)
      current[key] += (target[key] - current[key]) * k;
    tintNow = tintNow.map((v, i) => v + (tint[i]! - v) * k);

    const started = performance.now();
    try {
      draw();
    } catch {
      cancel();
      callbacks.onUnsupported('error');
      return;
    }
    const spent = performance.now() - started;
    if (!ready) {
      ready = true;
      callbacks.onReady();
    }
    samples.push(spent);
    if (samples.length >= SAMPLE_WINDOW) {
      const average = samples.reduce((a, b) => a + b, 0) / samples.length;
      samples.length = 0;
      canvas.dataset.reactorDrawMs = average.toFixed(2);
      if (average > GIVE_UP_AT_MS && quality === 'lite') {
        cancel();
        callbacks.onUnsupported('slow');
        return;
      }
      if (average > LITE_AT_MS && quality === 'full') setQuality('lite');
    }
    if (needsMotion()) request();
    else {
      lastTick = 0;
      setLoopState(false);
    }
  }

  const onVisibility = () => {
    documentVisible = document.visibilityState === 'visible';
    if (documentVisible) request();
    else cancel();
  };
  document.addEventListener('visibilitychange', onVisibility);
  const observer =
    typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver((entries) => {
          const entry = entries[entries.length - 1];
          if (!entry) return;
          onScreen = entry.isIntersecting;
          if (onScreen) request();
          else cancel();
        });
  observer?.observe(canvas);
  const resizer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
  if (parent) resizer?.observe(parent);

  setQuality('full');
  resize();
  setLoopState(false);

  return {
    setScene(next) {
      if (destroyed) return;
      scene = next;
      const visual = VISUALS[next.state];
      target = numbersOf(visual);
      tint = PALETTE[visual.tint];
      canvas.dataset.reactorState = next.state;
      request();
    },
    destroy() {
      destroyed = true;
      cancel();
      document.removeEventListener('visibilitychange', onVisibility);
      observer?.disconnect();
      resizer?.disconnect();
      canvas.width = 0; // releases the backing store
      canvas.height = 0;
      delete canvas.dataset.reactorLoop;
    },
  };
}
