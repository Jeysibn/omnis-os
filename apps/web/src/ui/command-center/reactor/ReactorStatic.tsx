import { useMemo } from 'react';
import { ORBITS, buildMesh, orbitPoint, project, type Projected } from './geometry.js';
import { MARKER_CAP, MARKER_KINDS, type MarkerCounts, type MarkerKind } from './visual.js';

const VIEW = 400;
const CENTER = VIEW / 2;
const UNIT = VIEW * 0.3;
const YAW = 0.6;

type Paths = { edges: string; nodes: string; shell: string; orbits: string[] };
let cached: Paths | null = null;

/** One fixed frame of the same constellation the Canvas renderer animates. Built once. */
function staticPaths(): Paths {
  if (cached) return cached;
  const mesh = buildMesh({ nodes: 200, shell: 130, links: 3, distance: 0.45 });
  const p: Projected = { x: 0, y: 0, z: 0, scale: 1 };
  const at = (x: number, y: number, z: number, yaw = YAW) => {
    project(x, y, z, yaw, p);
    return [CENTER + p.x * UNIT, CENTER + p.y * UNIT] as const;
  };
  const f = (n: number) => n.toFixed(1);
  let edges = '';
  for (let e = 0; e < mesh.edges.length; e += 2) {
    const a = mesh.edges[e]! * 3;
    const b = mesh.edges[e + 1]! * 3;
    const [ax, ay] = at(mesh.pos[a]!, mesh.pos[a + 1]!, mesh.pos[a + 2]!);
    const [bx, by] = at(mesh.pos[b]!, mesh.pos[b + 1]!, mesh.pos[b + 2]!);
    edges += `M${f(ax)} ${f(ay)}L${f(bx)} ${f(by)}`;
  }
  let nodes = '';
  for (let i = 0; i < mesh.count; i++) {
    const [x, y] = at(mesh.pos[i * 3]!, mesh.pos[i * 3 + 1]!, mesh.pos[i * 3 + 2]!);
    nodes += `M${f(x)} ${f(y)}h0`;
  }
  let shell = '';
  for (let i = 0; i < mesh.shellCount; i++) {
    const [x, y] = at(
      mesh.shell[i * 3]!,
      mesh.shell[i * 3 + 1]!,
      mesh.shell[i * 3 + 2]!,
      YAW * 0.6,
    );
    shell += `M${f(x)} ${f(y)}h0`;
  }
  const orbits = ORBITS.map((orbit) => {
    let d = '';
    for (let s = 0; s <= 72; s++) {
      const [x, y, z] = orbitPoint(orbit, (s / 72) * Math.PI * 2);
      const [sx, sy] = at(x, y, z);
      d += `${s === 0 ? 'M' : 'L'}${f(sx)} ${f(sy)}`;
    }
    return d;
  });
  cached = { edges, nodes, shell, orbits };
  return cached;
}

const ORBIT_OF: Record<MarkerKind, number> = {
  running: 0,
  stopping: 0,
  queued: 1,
  unknown: 1,
  failed: 2,
  interrupted: 2,
};

function Marker({ kind, index }: { kind: MarkerKind; index: number }) {
  const angle = MARKER_KINDS.indexOf(kind) * 1.37 + index * 0.95;
  const [x, y, z] = orbitPoint(ORBITS[ORBIT_OF[kind]]!, angle);
  const p: Projected = { x: 0, y: 0, z: 0, scale: 1 };
  project(x, y, z, YAW, p);
  const cx = CENTER + p.x * UNIT;
  const cy = CENTER + p.y * UNIT;
  const r = 3.4 * p.scale;
  switch (kind) {
    case 'running':
      return <circle cx={cx} cy={cy} r={r + 0.8} className="ccx-m-jade" />;
    case 'stopping':
      return <rect x={cx - r} y={cy - r} width={r * 2} height={r * 2} className="ccx-m-amber" />;
    case 'queued':
      return <circle cx={cx} cy={cy} r={r + 0.6} className="ccx-m-blue ccx-m-ring" />;
    case 'unknown':
      return <circle cx={cx} cy={cy} r={r + 1} className="ccx-m-frost ccx-m-ring ccx-m-dash" />;
    case 'failed':
      return (
        <polygon
          points={`${cx},${cy - r - 1} ${cx + r + 1},${cy + r} ${cx - r - 1},${cy + r}`}
          className="ccx-m-red"
        />
      );
    case 'interrupted':
      return (
        <polygon
          points={`${cx},${cy - r - 1} ${cx + r + 1},${cy} ${cx},${cy + r + 1} ${cx - r - 1},${cy}`}
          className="ccx-m-amber"
        />
      );
  }
}

/**
 * The Reactor without any animation: the fallback while the renderer loads, when it cannot run,
 * and the whole presentation under prefers-reduced-motion. Decorative, so hidden from assistive
 * technology; the system state is always stated in text beside it.
 */
export function ReactorStatic({ markers }: { markers: MarkerCounts | null }) {
  const paths = staticPaths();
  const shown = useMemo(
    () =>
      markers
        ? MARKER_KINDS.flatMap((kind) =>
            Array.from({ length: Math.min(markers[kind], MARKER_CAP) }, (_, index) => ({
              kind,
              index,
            })),
          )
        : [],
    [markers],
  );
  return (
    <svg
      className="ccx-reactor-static"
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      aria-hidden="true"
      focusable="false"
      data-reactor-static
    >
      <defs>
        <radialGradient id="ccx-reactor-glow">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.22" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="ccx-reactor-core">
          <stop offset="0" stopColor="#f0fff9" stopOpacity="0.95" />
          <stop offset="0.28" stopColor="currentColor" stopOpacity="0.7" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx={CENTER} cy={CENTER} r={VIEW * 0.5} fill="url(#ccx-reactor-glow)" />
      <path
        d={paths.shell}
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        opacity="0.32"
        fill="none"
      />
      <path d={paths.edges} stroke="currentColor" strokeWidth="0.7" opacity="0.22" fill="none" />
      <path
        d={paths.nodes}
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        opacity="0.7"
        fill="none"
      />
      {paths.orbits.map((d, index) => (
        <path
          key={index}
          d={d}
          stroke="currentColor"
          strokeWidth="0.9"
          opacity={0.18 + index * 0.05}
          fill="none"
        />
      ))}
      <circle cx={CENTER} cy={CENTER} r={UNIT * 0.34 * 2.6} fill="url(#ccx-reactor-core)" />
      {shown.map(({ kind, index }) => (
        <Marker key={`${kind}-${index}`} kind={kind} index={index} />
      ))}
    </svg>
  );
}
