import { useMemo } from 'react';
import { ORBITS, buildConstellation, orbitPoint } from './geometry.js';

const YAW = 0.6;
const PITCH = 0.32;
const DEPTH = 3.6;

function project(x: number, y: number, z: number): [number, number, number] {
  const x1 = x * Math.cos(YAW) - z * Math.sin(YAW);
  const z1 = x * Math.sin(YAW) + z * Math.cos(YAW);
  const y2 = y * Math.cos(PITCH) - z1 * Math.sin(PITCH);
  const z2 = y * Math.sin(PITCH) + z1 * Math.cos(PITCH);
  const s = DEPTH / (DEPTH - z2);
  return [x1 * 100 * s, y2 * 100 * s, z2];
}

/** Static illustration of the reactor. Used when graphics are unavailable or loading. */
export function ReactorFallback({ dim = false }: { dim?: boolean }) {
  const art = useMemo(() => {
    const data = buildConstellation({
      primary: 150,
      shell: 120,
      linkDistance: 0.55,
      linksPerPoint: 2,
    });
    const pts: Array<[number, number, number]> = [];
    for (let i = 0; i < data.count; i++)
      pts.push(project(data.pos[i * 3]!, data.pos[i * 3 + 1]!, data.pos[i * 3 + 2]!));
    const lines: string[] = [];
    for (let i = 0; i < data.edges.length; i += 2) {
      const a = pts[data.edges[i]!]!;
      const b = pts[data.edges[i + 1]!]!;
      lines.push(`M${a[0].toFixed(1)} ${a[1].toFixed(1)}L${b[0].toFixed(1)} ${b[1].toFixed(1)}`);
    }
    const dust: Array<[number, number]> = [];
    for (let i = 0; i < data.shellCount; i++) {
      const p = project(data.shell[i * 3]!, data.shell[i * 3 + 1]!, data.shell[i * 3 + 2]!);
      dust.push([p[0], p[1]]);
    }
    const orbits = ORBITS.map((orbit) => {
      const points = Array.from({ length: 97 }, (_, s) => {
        const [x, y, z] = orbitPoint(orbit, (s / 96) * Math.PI * 2);
        const p = project(x, y, z);
        return `${s === 0 ? 'M' : 'L'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
      });
      return points.join('');
    });
    return { pts, lines: lines.join(''), dust, orbits };
  }, []);
  return (
    <svg
      className={`reactor-fallback${dim ? ' is-dim' : ''}`}
      viewBox="-240 -190 480 380"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <radialGradient id="nx-fb-halo">
          <stop offset="0" stopColor="#91F2CD" stopOpacity="0.28" />
          <stop offset="1" stopColor="#91F2CD" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="nx-fb-core">
          <stop offset="0" stopColor="#F2FFF9" />
          <stop offset="0.35" stopColor="#91F2CD" stopOpacity="0.8" />
          <stop offset="1" stopColor="#91F2CD" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle r="230" fill="url(#nx-fb-halo)" />
      {art.dust.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r="0.8" fill="#91F2CD" opacity="0.35" />
      ))}
      {art.orbits.map((d, i) => (
        <path key={i} d={d} fill="none" stroke="#91F2CD" strokeOpacity="0.25" strokeWidth="0.8" />
      ))}
      <path d={art.lines} fill="none" stroke="#91F2CD" strokeOpacity="0.28" strokeWidth="0.6" />
      {art.pts.map(([x, y, z], i) => (
        <circle
          key={i}
          cx={x}
          cy={y}
          r={0.9 + ((z + 1.4) / 2.8) * 1.4}
          fill="#CFF8E6"
          opacity="0.8"
        />
      ))}
      <circle r="27" fill="url(#nx-fb-core)" />
      <circle r="27" fill="none" stroke="#91F2CD" strokeOpacity="0.5" />
    </svg>
  );
}
