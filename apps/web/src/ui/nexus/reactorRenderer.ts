import type { RunStatus } from '@omnis/contracts';
import {
  ORBITS,
  buildConstellation,
  hashString,
  orbitPoint,
  type Constellation,
} from './geometry.js';
import type { ReactorVisual, Tint } from './reactorState.js';

export type BeadInput = { id: string; status: RunStatus; active: boolean };

export type ReactorOptions = {
  quality: 'full' | 'lite';
  animate: boolean;
  onSelectBead?: (id: string) => void;
};

export type ReactorController = {
  setVisual(visual: ReactorVisual): void;
  setBeads(beads: BeadInput[]): void;
  setSelected(id: string | null): void;
  setAnimate(animate: boolean): void;
  setPaused(paused: boolean): void;
  resize(): void;
  destroy(): void;
  stats(): { frames: number; avgDrawMs: number; qualityLevel: number; running: boolean };
};

type RGB = readonly [number, number, number];
const TINTS: Record<Tint, RGB> = {
  jade: [145, 242, 205],
  amber: [240, 189, 118],
  red: [255, 122, 122],
  slate: [138, 160, 156],
};
const FOCUS: RGB = [100, 141, 246];
const FROST: RGB = [234, 244, 238];
const STATIC_CLOCK = 14;
const DEPTH = 3.6;
const INTRO_MS = 1200;

const rgba = (c: RGB, a: number) =>
  `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
const smooth = (x: number) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};
const mix = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

const constellations = new Map<string, Constellation>();
function constellationFor(quality: 'full' | 'lite'): Constellation {
  let value = constellations.get(quality);
  if (!value) {
    value =
      quality === 'full'
        ? buildConstellation({ primary: 520, shell: 1100, linkDistance: 0.36 })
        : buildConstellation({ primary: 170, shell: 160, linkDistance: 0.55, linksPerPoint: 2 });
    constellations.set(quality, value);
  }
  return value;
}

type Hit = { id: string; x: number; y: number };

/**
 * Imperative Canvas 2D renderer. All animation state lives here, never in React state, so a
 * frame costs no component renders. Throws if a 2D context cannot be created; the caller
 * then shows the static illustration.
 */
export function createReactor(
  canvas: HTMLCanvasElement,
  options: ReactorOptions,
): ReactorController {
  const maybeCtx = canvas.getContext('2d');
  if (!maybeCtx) throw new Error('Canvas 2D context unavailable');
  const ctx: CanvasRenderingContext2D = maybeCtx;
  const data = constellationFor(options.quality);

  let animate = options.animate;
  let paused = false;
  let destroyed = false;
  let qualityLevel = options.quality === 'full' ? 2 : 1; // 2 full, 1 reduced, 0 minimal
  let dprCap = options.quality === 'full' ? 2 : 1.5;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let raf = 0;
  let last = 0;
  let clock = STATIC_CLOCK;
  const introStart = performance.now();
  let cueStart = -1e9;
  let dirty = true;
  let selected: string | null = null;
  let beads: BeadInput[] = [];
  let hits: Hit[] = [];
  let target: ReactorVisual = {
    energy: 0.3,
    speed: 0,
    orbit: 0,
    dim: 0.5,
    tint: 'slate',
    cue: false,
  };
  const current = { energy: 0.3, speed: 0, orbit: 0, dim: 0.5, rgb: TINTS.slate as RGB };
  let frames = 0;
  let drawEma = 0;
  let slowFrames = 0;
  const buckets: number[][] = [[], [], []];
  const px = new Float32Array(data.count);
  const py = new Float32Array(data.count);
  const pz = new Float32Array(data.count);

  function sizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    width = Math.max(1, Math.round(rect.width));
    height = Math.max(1, Math.round(rect.height));
    dpr = Math.min(window.devicePixelRatio || 1, dprCap);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    dirty = true;
  }

  function snapToTarget() {
    current.energy = target.energy;
    current.speed = target.speed;
    current.orbit = target.orbit;
    current.dim = target.dim;
    current.rgb = TINTS[target.tint];
  }

  function draw(now: number) {
    const started = performance.now();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const intro = animate ? Math.min(1, (now - introStart) / INTRO_MS) : 1;
    const nucleusA = smooth(intro / 0.25);
    const meshA = smooth((intro - 0.25) / 0.42);
    const orbitA = smooth((intro - 0.67) / 0.33);
    const fade = (1 - current.dim) * (selected ? 0.82 : 1);
    const cx = width / 2;
    const cy = height / 2;
    const R = Math.min(width, height) * 0.335;
    const e = current.energy;
    const rgb = current.rgb;
    const cue = animate ? Math.max(0, 1 - (now - cueStart) / 1600) : 0;
    const breath = 1 + 0.07 * e * Math.sin(clock * 1.1);

    const yaw = clock * 0.04;
    const pitch = 0.32 + 0.08 * Math.sin(clock * 0.11);
    const cyaw = Math.cos(yaw);
    const syaw = Math.sin(yaw);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const project = (x: number, y: number, z: number, out: [number, number, number]) => {
      const x1 = x * cyaw - z * syaw;
      const z1 = x * syaw + z * cyaw;
      const y2 = y * cp - z1 * sp;
      const z2 = y * sp + z1 * cp;
      const s = DEPTH / (DEPTH - z2);
      out[0] = cx + x1 * R * s;
      out[1] = cy + y2 * R * s;
      out[2] = z2;
    };
    const out: [number, number, number] = [0, 0, 0];

    // Environmental glow: broad and faint, the only light that reaches the edges.
    ctx.globalCompositeOperation = 'lighter';
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 2.3);
    halo.addColorStop(0, rgba(rgb, 0.17 * e * fade * nucleusA));
    halo.addColorStop(0.45, rgba(rgb, 0.05 * fade * nucleusA));
    halo.addColorStop(1, rgba(rgb, 0));
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, width, height);

    // Secondary shell particles, drifting against the main rotation for parallax.
    const shellStep = qualityLevel >= 2 ? 1 : qualityLevel === 1 ? 2 : 4;
    ctx.fillStyle = rgba(mix(rgb, FROST, 0.35), 0.5 * fade * meshA);
    const drift = clock * 0.05;
    for (let i = 0; i < data.shellCount; i += shellStep) {
      const bx = data.shell[i * 3]!;
      const by = data.shell[i * 3 + 1]! + 0.03 * Math.sin(clock * 0.3 + data.shellPhase[i]!);
      const bz = data.shell[i * 3 + 2]!;
      const c = Math.cos(-drift);
      const s = Math.sin(-drift);
      project(bx * c - bz * s, by, bx * s + bz * c, out);
      const depth = (out[2] + 2.6) / 5.2;
      ctx.globalAlpha = Math.max(0.05, Math.min(0.55, depth * 0.6));
      const size = 0.9 + depth * 1.1;
      ctx.fillRect(out[0], out[1], size, size);
    }
    ctx.globalAlpha = 1;

    // Primary mesh: deform slowly, project, then batch strands by depth bucket.
    const wobble = 0.03 * current.speed;
    for (let i = 0; i < data.count; i++) {
      const k = 1 + wobble * Math.sin(clock * 0.45 + data.phase[i]!);
      project(data.pos[i * 3]! * k, data.pos[i * 3 + 1]! * k, data.pos[i * 3 + 2]! * k, out);
      px[i] = out[0];
      py[i] = out[1];
      pz[i] = out[2];
    }
    buckets.forEach((b) => (b.length = 0));
    for (let i = 0; i < data.edges.length; i += 2) {
      const a = data.edges[i]!;
      const b = data.edges[i + 1]!;
      const z = (pz[a]! + pz[b]!) / 2;
      buckets[z < -0.25 ? 0 : z < 0.45 ? 1 : 2]!.push(a, b);
    }
    const strandAlpha = [0.1, 0.2, 0.34];
    const meshColor = mix(rgb, FROST, 0.15);
    ctx.lineWidth = 0.7;
    buckets.forEach((list, bucket) => {
      ctx.beginPath();
      for (let i = 0; i < list.length; i += 2) {
        ctx.moveTo(px[list[i]!]!, py[list[i]!]!);
        ctx.lineTo(px[list[i + 1]!]!, py[list[i + 1]!]!);
      }
      ctx.strokeStyle = rgba(meshColor, strandAlpha[bucket]! * fade * meshA);
      ctx.stroke();
    });
    for (let i = 0; i < data.count; i++) {
      const depth = (pz[i]! + 1.4) / 2.8;
      const size = 0.9 + depth * 1.7;
      ctx.fillStyle = rgba(
        mix(meshColor, FROST, depth * 0.5),
        (0.25 + depth * 0.65) * fade * meshA,
      );
      ctx.fillRect(px[i]! - size / 2, py[i]! - size / 2, size, size);
    }
    // Depth cue: the nearest nodes bloom softly, which separates the front layer from the back.
    if (qualityLevel >= 1) {
      for (let i = 0; i < data.count; i += 3) {
        const depth = (pz[i]! + 1.4) / 2.8;
        if (depth < 0.72) continue;
        const g = ctx.createRadialGradient(px[i]!, py[i]!, 0, px[i]!, py[i]!, 9);
        g.addColorStop(0, rgba(meshColor, 0.32 * fade * meshA));
        g.addColorStop(1, rgba(meshColor, 0));
        ctx.fillStyle = g;
        ctx.fillRect(px[i]! - 9, py[i]! - 9, 18, 18);
      }
    }

    // Nucleus: bright core, corona, and the engineered ring set.
    const rn = R * 0.17 * breath;
    const corona = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.75);
    corona.addColorStop(0, rgba(rgb, 0.42 * e * nucleusA * (1 - current.dim * 0.5)));
    corona.addColorStop(1, rgba(rgb, 0));
    ctx.fillStyle = corona;
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, rn * 2);
    core.addColorStop(0, rgba([240, 255, 248], 0.98 * nucleusA * (1 - current.dim * 0.4)));
    core.addColorStop(0.3, rgba(mix(rgb, FROST, 0.5), 0.75 * nucleusA));
    core.addColorStop(1, rgba(rgb, 0));
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(cx, cy, rn * 2, 0, Math.PI * 2);
    ctx.fill();
    if (cue > 0) {
      const flash = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * (0.4 + (1 - cue) * 0.5));
      flash.addColorStop(0, rgba(TINTS.red, 0.4 * cue));
      flash.addColorStop(1, rgba(TINTS.red, 0));
      ctx.fillStyle = flash;
      ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    }

    ctx.globalCompositeOperation = 'source-over';
    drawRings(cx, cy, R, rgb, fade * nucleusA * (0.55 + 0.45 * meshA));

    // Orbits and run markers.
    hits = [];
    if (orbitA > 0) drawOrbits(project, out, rgb, fade * orbitA);
    ctx.globalAlpha = 1;
    recordFrame(started);
  }

  function drawRings(cx: number, cy: number, R: number, rgb: RGB, a: number) {
    const rr = R * 0.27;
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(rgb, 0.5 * a);
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, Math.PI * 2);
    ctx.stroke();
    const spin = -clock * 0.12;
    ctx.beginPath();
    for (let i = 0; i < 72; i++) {
      const ang = spin + (i / 72) * Math.PI * 2;
      const len = i % 6 === 0 ? 7 : 3;
      ctx.moveTo(cx + Math.cos(ang) * (rr + 3), cy + Math.sin(ang) * (rr + 3));
      ctx.lineTo(cx + Math.cos(ang) * (rr + 3 + len), cy + Math.sin(ang) * (rr + 3 + len));
    }
    ctx.strokeStyle = rgba(rgb, 0.38 * a);
    ctx.stroke();
    ctx.lineWidth = 1.6;
    const inner = R * 0.215;
    for (let i = 0; i < 3; i++) {
      const start = clock * 0.18 + (i / 3) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(cx, cy, inner, start, start + Math.PI * 0.55);
      ctx.strokeStyle = rgba(mix(rgb, FROST, 0.4), 0.55 * a);
      ctx.stroke();
    }
    if (target.tint === 'amber') {
      // Approval attention: a localized amber segment with a marker, not a global tint.
      ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.arc(cx, cy, rr, -Math.PI * 0.62, -Math.PI * 0.3);
      ctx.strokeStyle = rgba(TINTS.amber, 0.95 * a);
      ctx.stroke();
      ctx.fillStyle = rgba(TINTS.amber, 0.95 * a);
      ctx.beginPath();
      ctx.moveTo(
        cx + Math.cos(-Math.PI * 0.46) * (rr + 18),
        cy + Math.sin(-Math.PI * 0.46) * (rr + 18),
      );
      ctx.lineTo(
        cx + Math.cos(-Math.PI * 0.5) * (rr + 9),
        cy + Math.sin(-Math.PI * 0.5) * (rr + 9),
      );
      ctx.lineTo(
        cx + Math.cos(-Math.PI * 0.42) * (rr + 9),
        cy + Math.sin(-Math.PI * 0.42) * (rr + 9),
      );
      ctx.fill();
    } else if (target.tint === 'red') {
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, cy, rr, -Math.PI * 0.58, -Math.PI * 0.42);
      ctx.strokeStyle = rgba(TINTS.red, 0.95 * a);
      ctx.stroke();
    }
  }

  function drawOrbits(
    project: (x: number, y: number, z: number, out: [number, number, number]) => void,
    out: [number, number, number],
    rgb: RGB,
    a: number,
  ) {
    const segments = qualityLevel >= 1 ? 120 : 72;
    ORBITS.forEach((orbit) => {
      const back = new Path2D();
      const front = new Path2D();
      let prev: [number, number, number] | null = null;
      for (let s = 0; s <= segments; s++) {
        const [x, y, z] = orbitPoint(orbit, (s / segments) * Math.PI * 2);
        project(x, y, z, out);
        const point: [number, number, number] = [out[0], out[1], out[2]];
        if (prev) {
          const path = (prev[2] + point[2]) / 2 < 0 ? back : front;
          path.moveTo(prev[0], prev[1]);
          path.lineTo(point[0], point[1]);
        }
        prev = point;
      }
      ctx.lineWidth = 0.9;
      ctx.strokeStyle = rgba(rgb, (0.1 + 0.12 * current.orbit) * a);
      ctx.stroke(back);
      ctx.strokeStyle = rgba(rgb, (0.26 + 0.2 * current.orbit) * a);
      ctx.stroke(front);
    });
    // Markers: one per real run. Only active runs move; settled runs rest on their orbit.
    beads.slice(0, 6).forEach((bead, i) => {
      const orbit = ORBITS[i % ORBITS.length]!;
      const base = (hashString(bead.id) % 6283) / 1000;
      const angle = base + (bead.active ? clock * orbit.rate * 2.2 : 0);
      const place = (ang: number) => {
        const [x, y, z] = orbitPoint(orbit, ang);
        project(x, y, z, out);
        return { x: out[0], y: out[1], z: out[2] };
      };
      if (bead.active && current.speed > 0) {
        for (let t = 1; t <= 10; t++) {
          const p = place(angle - Math.sign(orbit.rate) * t * 0.045);
          ctx.fillStyle = rgba(TINTS.jade, (1 - t / 11) * 0.5 * a);
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2.4 - t * 0.15, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      const p = place(angle);
      hits.push({ id: bead.id, x: p.x, y: p.y });
      const dimmed = selected !== null && selected !== bead.id ? 0.45 : 1;
      drawBead(p.x, p.y, bead.status, a * dimmed);
      if (selected === bead.id) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = rgba(FOCUS, 1);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 11, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.strokeStyle = rgba(FOCUS, 0.35);
        ctx.beginPath();
        ctx.moveTo(width / 2, height / 2);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }
    });
  }

  // Shapes differ by status so state never depends on colour alone.
  function drawBead(x: number, y: number, status: RunStatus, a: number) {
    ctx.lineWidth = 1.6;
    const color =
      status === 'failed'
        ? TINTS.red
        : status === 'interrupted' || status === 'stopping'
          ? TINTS.amber
          : status === 'cancelled' || status === 'unknown'
            ? TINTS.slate
            : status === 'queued'
              ? FROST
              : TINTS.jade;
    ctx.strokeStyle = rgba(color, a);
    ctx.fillStyle = rgba(color, a);
    ctx.beginPath();
    switch (status) {
      case 'running':
      case 'stopping':
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, 8, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(color, a * 0.4);
        ctx.stroke();
        break;
      case 'queued':
        ctx.arc(x, y, 4.5, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case 'completed':
        ctx.arc(x, y, 3.2, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'failed':
        ctx.moveTo(x - 4, y - 4);
        ctx.lineTo(x + 4, y + 4);
        ctx.moveTo(x + 4, y - 4);
        ctx.lineTo(x - 4, y + 4);
        ctx.stroke();
        break;
      case 'interrupted':
        ctx.moveTo(x, y - 5);
        ctx.lineTo(x + 5, y);
        ctx.lineTo(x, y + 5);
        ctx.lineTo(x - 5, y);
        ctx.closePath();
        ctx.stroke();
        break;
      default:
        ctx.moveTo(x - 4, y);
        ctx.lineTo(x + 4, y);
        ctx.stroke();
    }
  }

  function recordFrame(started: number) {
    frames += 1;
    if (!animate) return;
    const ms = performance.now() - started;
    drawEma = drawEma === 0 ? ms : drawEma * 0.95 + ms * 0.05;
    // Sustained heavy frames step quality down once per ~1.5 s; it never steps back up.
    slowFrames = drawEma > 9 ? slowFrames + 1 : 0;
    if (slowFrames > 90 && qualityLevel > 0) {
      qualityLevel -= 1;
      dprCap = qualityLevel === 0 ? 1 : Math.min(dprCap, 1.5);
      slowFrames = 0;
      drawEma = 0;
      sizeCanvas();
    }
  }

  function tick(now: number) {
    raf = 0;
    if (destroyed || paused || !animate) return;
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016);
    last = now;
    const k = 1 - Math.exp(-dt * 2.5);
    const goal = TINTS[target.tint];
    current.energy += (target.energy - current.energy) * k;
    current.speed += (target.speed - current.speed) * k;
    current.orbit += (target.orbit - current.orbit) * k;
    current.dim += (target.dim - current.dim) * k;
    current.rgb = mix(current.rgb, goal, k);
    clock += dt * current.speed; // speed 0 holds the frame still
    draw(now);
    raf = requestAnimationFrame(tick);
  }

  function schedule() {
    if (destroyed || raf) return;
    if (animate && !paused) {
      last = 0;
      raf = requestAnimationFrame(tick);
    } else if (dirty) {
      raf = requestAnimationFrame((now) => {
        raf = 0;
        if (destroyed) return;
        dirty = false;
        draw(now);
      });
    }
  }

  function redrawIfStatic() {
    dirty = true;
    if (!animate || paused) {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      schedule();
    }
  }

  function hitTest(event: PointerEvent | MouseEvent): string | null {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    let best: Hit | null = null;
    let bestDistance = 20;
    for (const hit of hits) {
      const d = Math.hypot(hit.x - x, hit.y - y);
      if (d < bestDistance) {
        best = hit;
        bestDistance = d;
      }
    }
    return best?.id ?? null;
  }
  const onClick = (event: MouseEvent) => {
    const id = hitTest(event);
    if (id) options.onSelectBead?.(id);
  };
  const onMove = (event: PointerEvent) => {
    canvas.style.cursor = hitTest(event) ? 'pointer' : 'default';
  };
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('pointermove', onMove);

  sizeCanvas();
  snapToTarget();
  schedule();

  return {
    setVisual(visual) {
      const entering = visual.cue && !target.cue;
      target = visual;
      if (entering) cueStart = performance.now();
      if (!animate) snapToTarget();
      redrawIfStatic();
      if (animate && !raf) schedule();
    },
    setBeads(next) {
      beads = next;
      redrawIfStatic();
    },
    setSelected(id) {
      selected = id;
      redrawIfStatic();
    },
    setAnimate(value) {
      animate = value;
      if (!value) snapToTarget();
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      dirty = true;
      schedule();
    },
    setPaused(value) {
      if (paused === value) return;
      paused = value;
      if (value && raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      } else {
        dirty = true;
        schedule();
      }
    },
    resize() {
      sizeCanvas();
      redrawIfStatic();
    },
    destroy() {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('pointermove', onMove);
      canvas.width = 0; // releases the backing store
      canvas.height = 0;
    },
    stats() {
      return { frames, avgDrawMs: drawEma, qualityLevel, running: raf !== 0 && animate && !paused };
    },
  };
}
