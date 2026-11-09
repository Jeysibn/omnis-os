/**
 * Deterministic geometry for the Reactor. Pure: no DOM, no randomness at call time, so the Canvas
 * renderer and the static SVG draw the same constellation and tests are reproducible.
 *
 * The mesh is deliberately lopsided (a low-frequency radius field plus a density field that leaves
 * visible voids) so it reads as an organic neural structure rather than a rotating globe.
 */

export type Mesh = {
  count: number;
  /** xyz triples, roughly unit-sphere space (the surface bulges to about 1.4). */
  pos: Float32Array;
  phase: Float32Array;
  /** Index pairs (a, b) joining nearby points. */
  edges: Uint16Array;
  shellCount: number;
  shell: Float32Array;
  shellPhase: Float32Array;
};

export type Orbit = { rx: number; ry: number; tiltX: number; tiltZ: number; rate: number };

/** Three sparse, differently angled paths; deliberately not concentric. */
export const ORBITS: readonly Orbit[] = [
  { rx: 1.5, ry: 1.1, tiltX: 1.15, tiltZ: 0.35, rate: 0.16 },
  { rx: 1.68, ry: 1.25, tiltX: 0.55, tiltZ: -0.8, rate: -0.11 },
  { rx: 1.4, ry: 1.2, tiltX: 1.45, tiltZ: 1.25, rate: 0.2 },
];

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function direction(rand: () => number): [number, number, number] {
  const u = rand() * 2 - 1;
  const a = rand() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  return [s * Math.cos(a), u, s * Math.sin(a)];
}

const surface = (x: number, y: number, z: number) =>
  1 +
  0.16 * Math.sin(2.3 * x + 1.1) +
  0.13 * Math.cos(3.1 * y - 0.4) +
  0.11 * Math.sin(2.7 * z + 2.0) +
  0.07 * Math.sin(5.2 * x * y + 0.6);

const density = (x: number, y: number, z: number) =>
  0.35 + 0.65 * (0.5 + 0.5 * Math.sin(1.7 * x - 1.3 * y + 2.1 * z + 0.9));

export function buildMesh(options: {
  nodes: number;
  shell: number;
  seed?: number;
  links?: number;
  distance?: number;
}): Mesh {
  const rand = mulberry32(options.seed ?? 0x5eed);
  const count = options.nodes;
  const pos = new Float32Array(count * 3);
  const phase = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let [x, y, z] = direction(rand);
    while (rand() > density(x, y, z)) [x, y, z] = direction(rand);
    // Most points sit near the surface; some sit deeper in the volume for parallax depth.
    const layer = rand() < 0.28 ? 0.45 + rand() * 0.3 : 0.8 + rand() * 0.2;
    const radius = surface(x, y, z) * layer;
    pos[i * 3] = x * radius;
    pos[i * 3 + 1] = y * radius;
    pos[i * 3 + 2] = z * radius;
    phase[i] = rand() * Math.PI * 2;
  }

  const links = options.links ?? 3;
  const maxDistance = options.distance ?? 0.4;
  const seen = new Set<number>();
  const pairs: number[] = [];
  for (let i = 0; i < count; i++) {
    const near: Array<[number, number]> = [];
    for (let j = 0; j < count; j++) {
      if (i === j) continue;
      const d = Math.hypot(
        pos[i * 3]! - pos[j * 3]!,
        pos[i * 3 + 1]! - pos[j * 3 + 1]!,
        pos[i * 3 + 2]! - pos[j * 3 + 2]!,
      );
      if (d < maxDistance) near.push([d, j]);
    }
    near.sort((a, b) => a[0] - b[0]);
    for (const [, j] of near.slice(0, links)) {
      const key = Math.min(i, j) * count + Math.max(i, j);
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push(i, j);
    }
  }

  const shellCount = options.shell;
  const shell = new Float32Array(shellCount * 3);
  const shellPhase = new Float32Array(shellCount);
  for (let i = 0; i < shellCount; i++) {
    const [x, y, z] = direction(rand);
    const radius = 1.45 + rand() * 1.1;
    shell[i * 3] = x * radius * 1.15;
    shell[i * 3 + 1] = y * radius * 0.85;
    shell[i * 3 + 2] = z * radius;
    shellPhase[i] = rand() * Math.PI * 2;
  }
  return { count, pos, phase, edges: Uint16Array.from(pairs), shellCount, shell, shellPhase };
}

/** A point on an orbit at `angle`, in the same space as the mesh. */
export function orbitPoint(orbit: Orbit, angle: number): [number, number, number] {
  const x0 = orbit.rx * Math.cos(angle);
  const y0 = orbit.ry * Math.sin(angle);
  const y1 = y0 * Math.cos(orbit.tiltX);
  const z1 = y0 * Math.sin(orbit.tiltX);
  return [
    x0 * Math.cos(orbit.tiltZ) - y1 * Math.sin(orbit.tiltZ),
    x0 * Math.sin(orbit.tiltZ) + y1 * Math.cos(orbit.tiltZ),
    z1,
  ];
}

export type Projected = { x: number; y: number; z: number; scale: number };

/** Yaw by `yaw`, a fixed pitch, then a simple perspective divide. Writes into `out`. */
export function project(
  x: number,
  y: number,
  z: number,
  yaw: number,
  out: Projected,
  pitch = 0.38,
  camera = 3.4,
): Projected {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const x1 = x * cy + z * sy;
  const z1 = -x * sy + z * cy;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const y2 = y * cp - z1 * sp;
  const z2 = y * sp + z1 * cp;
  const scale = camera / (camera - z2);
  out.x = x1 * scale;
  out.y = y2 * scale;
  out.z = z2;
  out.scale = scale;
  return out;
}
