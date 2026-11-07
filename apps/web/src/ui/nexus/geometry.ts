/** Deterministic, asymmetric neural constellation. Pure; no DOM, no randomness at call time. */

export type Constellation = {
  count: number;
  /** xyz triples in roughly unit-sphere space (the surface bulges to about 1.4). */
  pos: Float32Array;
  phase: Float32Array;
  /** Index pairs (a, b) joining nearby points. */
  edges: Uint16Array;
  shellCount: number;
  shell: Float32Array;
  shellPhase: Float32Array;
};

export type Orbit = { rx: number; ry: number; tiltX: number; tiltZ: number; rate: number };

/** Two sparse planes plus one inclined path; deliberately not concentric. */
export const ORBITS: readonly Orbit[] = [
  { rx: 1.5, ry: 1.1, tiltX: 1.15, tiltZ: 0.35, rate: 0.16 },
  { rx: 1.65, ry: 1.25, tiltX: 0.55, tiltZ: -0.8, rate: -0.11 },
  { rx: 1.38, ry: 1.2, tiltX: 1.45, tiltZ: 1.25, rate: 0.2 },
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

/** Stable 32-bit hash used to place a run's marker without storing state. */
export function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return h >>> 0;
}

function randomDirection(rand: () => number): [number, number, number] {
  const u = rand() * 2 - 1;
  const a = rand() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  return [s * Math.cos(a), u, s * Math.sin(a)];
}

/** Low-frequency radius field that makes the mesh lopsided and organic rather than a globe. */
function surface(x: number, y: number, z: number): number {
  return (
    1 +
    0.16 * Math.sin(2.3 * x + 1.1) +
    0.13 * Math.cos(3.1 * y - 0.4) +
    0.11 * Math.sin(2.7 * z + 2.0) +
    0.07 * Math.sin(5.2 * x * y + 0.6)
  );
}

/** Where the mesh clusters; thins out the opposite side to create visible voids. */
function density(x: number, y: number, z: number): number {
  return 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(1.7 * x - 1.3 * y + 2.1 * z + 0.9));
}

export function buildConstellation(options: {
  primary: number;
  shell: number;
  seed?: number;
  linksPerPoint?: number;
  linkDistance?: number;
}): Constellation {
  const rand = mulberry32(options.seed ?? 0x0a15);
  const count = options.primary;
  const pos = new Float32Array(count * 3);
  const phase = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let [x, y, z] = randomDirection(rand);
    while (rand() > density(x, y, z)) [x, y, z] = randomDirection(rand);
    // Several depth layers: most points sit near the surface, some deeper inside the volume.
    const layer = rand() < 0.28 ? 0.45 + rand() * 0.3 : 0.8 + rand() * 0.2;
    const radius = surface(x, y, z) * layer;
    pos[i * 3] = x * radius;
    pos[i * 3 + 1] = y * radius;
    pos[i * 3 + 2] = z * radius;
    phase[i] = rand() * Math.PI * 2;
  }

  const links = options.linksPerPoint ?? 3;
  const maxDistance = options.linkDistance ?? 0.4;
  const seen = new Set<number>();
  const pairs: number[] = [];
  for (let i = 0; i < count; i++) {
    const near: Array<[number, number]> = [];
    for (let j = 0; j < count; j++) {
      if (i === j) continue;
      const dx = pos[i * 3]! - pos[j * 3]!;
      const dy = pos[i * 3 + 1]! - pos[j * 3 + 1]!;
      const dz = pos[i * 3 + 2]! - pos[j * 3 + 2]!;
      const d = Math.hypot(dx, dy, dz);
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
    const u = rand() * 2 - 1;
    const a = rand() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const radius = 1.45 + rand() * 1.1;
    shell[i * 3] = s * Math.cos(a) * radius * 1.15;
    shell[i * 3 + 1] = u * radius * 0.85;
    shell[i * 3 + 2] = s * Math.sin(a) * radius;
    shellPhase[i] = rand() * Math.PI * 2;
  }
  return { count, pos, phase, edges: Uint16Array.from(pairs), shellCount, shell, shellPhase };
}

/** Point on an orbit at `angle`, in the same space as the constellation. */
export function orbitPoint(orbit: Orbit, angle: number): [number, number, number] {
  const x0 = orbit.rx * Math.cos(angle);
  const y0 = orbit.ry * Math.sin(angle);
  const cx = Math.cos(orbit.tiltX);
  const sx = Math.sin(orbit.tiltX);
  const y1 = y0 * cx;
  const z1 = y0 * sx;
  const cz = Math.cos(orbit.tiltZ);
  const sz = Math.sin(orbit.tiltZ);
  return [x0 * cz - y1 * sz, x0 * sz + y1 * cz, z1];
}
