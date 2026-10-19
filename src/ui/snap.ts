import type { DxfRecord, Vec3 } from '../dxf/record';
import { isDefaultExtrusion } from '../geom/ocs';
import { project } from '../geom/view';
import { vertices } from '../render/geometry';
import type { EntityGeom } from '../render/prims';
import type { Scene } from '../render/scene';

export type SnapKind = 'endpoint' | 'midpoint' | 'center' | 'quadrant' | 'intersection' | 'insertion' | 'node' | 'nearest';

/** A snap point in world coordinates. */
export interface SnapPoint {
  x: number;
  y: number;
  z: number;
  kind: SnapKind;
}

const DEG = Math.PI / 180;

/** Object snap points defined by an entity's own data (not its tessellation), in WCS. */
function recordSnaps(r: DxfRecord): SnapPoint[] {
  const out: SnapPoint[] = [];
  const add = (x: number, y: number, z: number, kind: SnapKind) => out.push({ x, y, z, kind });
  const planar = isDefaultExtrusion(r.point(210, [0, 0, 1]));
  switch (r.type) {
    case 'LINE': {
      const a = r.point(10), b = r.point(11);
      add(a[0], a[1], a[2], 'endpoint');
      add(b[0], b[1], b[2], 'endpoint');
      add((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2, 'midpoint');
      break;
    }
    case 'CIRCLE':
    case 'ARC': {
      if (!planar) break;
      const c = r.point(10), rad = r.num(40, 0), z = c[2];
      add(c[0], c[1], z, 'center');
      if (r.type === 'CIRCLE') {
        for (let k = 0; k < 4; k++) add(c[0] + rad * Math.cos((k * Math.PI) / 2), c[1] + rad * Math.sin((k * Math.PI) / 2), z, 'quadrant');
      } else {
        const a0 = r.num(50, 0) * DEG;
        let a1 = r.num(51, 0) * DEG;
        if (a1 <= a0) a1 += Math.PI * 2;
        add(c[0] + rad * Math.cos(a0), c[1] + rad * Math.sin(a0), z, 'endpoint');
        add(c[0] + rad * Math.cos(a1), c[1] + rad * Math.sin(a1), z, 'endpoint');
        add(c[0] + rad * Math.cos((a0 + a1) / 2), c[1] + rad * Math.sin((a0 + a1) / 2), z, 'midpoint');
      }
      break;
    }
    case 'ELLIPSE': {
      const c = r.point(10), m = r.point(11), k = r.num(40, 1);
      add(c[0], c[1], c[2], 'center');
      add(c[0] + m[0], c[1] + m[1], c[2] + m[2], 'quadrant');
      add(c[0] - m[0], c[1] - m[1], c[2] - m[2], 'quadrant');
      if (planar) {
        add(c[0] - m[1] * k, c[1] + m[0] * k, c[2], 'quadrant');
        add(c[0] + m[1] * k, c[1] - m[0] * k, c[2], 'quadrant');
      }
      break;
    }
    case 'LWPOLYLINE': {
      if (!planar) break;
      const z = r.num(38, 0);
      const v = vertices(r, 10);
      v.forEach((p) => add(p[0], p[1], z, 'endpoint'));
      const closed = (r.num(70, 0) & 1) === 1;
      const bulges = r.all(42).length;
      for (let i = 0; i < v.length - (closed ? 0 : 1); i++) {
        const a = v[i], b = v[(i + 1) % v.length];
        if (!bulges) add((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, z, 'midpoint');
      }
      break;
    }
    case 'POLYLINE': {
      const flags = r.num(70, 0);
      if (!(flags & (8 | 16 | 64)) && !planar) break;
      const elev = r.point(10)[2];
      for (const c of r.children) {
        const f = c.num(70, 0);
        if (c.type !== 'VERTEX' || (f & 128 && !(f & 64))) continue; // skip polyface face records
        const p = c.point(10);
        add(p[0], p[1], flags & (8 | 16 | 64) ? p[2] : elev, 'endpoint');
      }
      break;
    }
    case '3DFACE':
    case 'SOLID':
      if (r.type === 'SOLID' && !planar) break;
      for (const c of [10, 11, 12, 13]) if (r.hasPoint(c)) {
        const p = r.point(c);
        add(p[0], p[1], p[2], 'endpoint');
      }
      break;
    case 'MESH': {
      const vi = r.indexOf(92);
      if (vi < 0) break;
      const n = Number(r.groups[vi].value);
      let k = 0;
      for (let i = vi + 1; i < r.groups.length && k < n; i++) {
        if (r.groups[i].code !== 10) continue;
        add(Number(r.groups[i].value), Number(r.groups[i + 1]?.value ?? 0), Number(r.groups[i + 2]?.value ?? 0), 'endpoint');
        k++;
      }
      break;
    }
    case 'POINT': {
      const p = r.point(10);
      add(p[0], p[1], p[2], 'node');
      break;
    }
    case 'TEXT':
    case 'MTEXT':
    case 'INSERT':
    case 'ATTDEF': {
      const p = r.point(10);
      if (planar || r.type === 'MTEXT') add(p[0], p[1], p[2], 'insertion');
      break;
    }
  }
  return out;
}

/** Endpoints from short tessellated polylines (catches geometry inside blocks and dimensions). */
function primSnaps(g: EntityGeom): SnapPoint[] {
  const out: SnapPoint[] = [];
  if (g.rec.type !== 'INSERT' && !g.rec.type.endsWith('DIMENSION')) return out;
  for (const p of g.prims3) {
    if (p.k === 'line' && p.pts.length <= 48) for (let i = 0; i < p.pts.length; i += 3) out.push({ x: p.pts[i], y: p.pts[i + 1], z: p.pts[i + 2], kind: 'endpoint' });
    if (p.k === 'face') for (let i = 0; i < p.pts.length; i += 3) out.push({ x: p.pts[i], y: p.pts[i + 1], z: p.pts[i + 2], kind: 'endpoint' });
  }
  return out;
}

/** A projected segment plus the world endpoints it came from. */
interface Seg {
  a: number[]; // camera ax, ay, bx, by
  w0: Vec3;
  w1: Vec3;
}

function segments(g: EntityGeom, box: [number, number, number, number]): Seg[] {
  const out: Seg[] = [];
  g.prims.forEach((p, pi) => {
    const p3 = g.prims3[pi];
    if (p.k !== 'line' || !p3 || p3.k !== 'line') return;
    const n = p.pts.length;
    const segs = p.closed ? n / 2 : n / 2 - 1;
    for (let s = 0; s < segs; s++) {
      const i = s * 2, j = (i + 2) % n;
      const ax = p.pts[i], ay = p.pts[i + 1], bx = p.pts[j], by = p.pts[j + 1];
      if (Math.max(ax, bx) < box[0] || Math.min(ax, bx) > box[2] || Math.max(ay, by) < box[1] || Math.min(ay, by) > box[3]) continue;
      const i3 = s * 3, j3 = (i3 + 3) % p3.pts.length;
      out.push({ a: [ax, ay, bx, by], w0: [p3.pts[i3], p3.pts[i3 + 1], p3.pts[i3 + 2]], w1: [p3.pts[j3], p3.pts[j3 + 1], p3.pts[j3 + 2]] });
    }
  });
  return out;
}

/** Apparent intersection of two projected segments; returns the parameter along `a`. */
function intersect(a: number[], b: number[]): number | null {
  const d1x = a[2] - a[0], d1y = a[3] - a[1], d2x = b[2] - b[0], d2y = b[3] - b[1];
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-14) return null;
  const t = ((b[0] - a[0]) * d2y - (b[1] - a[1]) * d2x) / den;
  const u = ((b[0] - a[0]) * d1y - (b[1] - a[1]) * d1x) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return t;
}

const PRIORITY: Record<SnapKind, number> = {
  endpoint: 0, intersection: 1, center: 2, midpoint: 3, quadrant: 4, insertion: 5, node: 6, nearest: 9,
};

/**
 * Best object snap within `tol` of the camera-space point (cx, cy). Candidates are world
 * points compared after projection, so snapping works in any view; the result is in WCS.
 */
export function findSnap(scene: Scene, cx: number, cy: number, tol: number, exclude?: Set<DxfRecord>): SnapPoint | null {
  const box: [number, number, number, number] = [cx - tol, cy - tol, cx + tol, cy + tol];
  const cands: SnapPoint[] = [];
  const near: EntityGeom[] = [];
  for (const g of scene.query(box)) {
    if (exclude?.has(g.rec)) continue;
    if (g.bbox && (g.bbox[0] > box[2] || g.bbox[2] < box[0] || g.bbox[1] > box[3] || g.bbox[3] < box[1])) continue;
    near.push(g);
    cands.push(...recordSnaps(g.rec), ...primSnaps(g));
  }
  // apparent intersections between nearby entities, lifted back to 3D along the first segment
  if (near.length <= 40) {
    const segs = near.map((g) => segments(g, box));
    for (let i = 0; i < segs.length; i++)
      for (let j = i + 1; j < segs.length; j++)
        for (const a of segs[i]) for (const b of segs[j]) {
          const t = intersect(a.a, b.a);
          if (t === null) continue;
          cands.push({ x: a.w0[0] + (a.w1[0] - a.w0[0]) * t, y: a.w0[1] + (a.w1[1] - a.w0[1]) * t, z: a.w0[2] + (a.w1[2] - a.w0[2]) * t, kind: 'intersection' });
        }
  }
  let best: SnapPoint | null = null;
  let bestScore = Infinity;
  for (const c of cands) {
    const q = project(scene.rot, [c.x, c.y, c.z]);
    const d = Math.hypot(q[0] - cx, q[1] - cy);
    if (d > tol) continue;
    const score = d / tol + PRIORITY[c.kind] * 0.05;
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}
