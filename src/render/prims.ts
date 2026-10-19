import type { DxfRecord, Vec3 } from '../dxf/record';
import type { Mat } from '../geom/ocs';
import type { Style } from './style';

/** 2D affine [a, b, c, d, e, f]: x' = a*x + c*y + e, y' = b*x + d*y + f (canvas convention). */
export type Affine2 = [number, number, number, number, number, number];

/**
 * Drawing primitives projected to 2D camera space (for the top view, camera space = WCS XY).
 * `d` is the mean camera depth (larger = nearer the viewer), used for back-to-front drawing.
 */
export type Prim = (
  | { k: 'line'; pts: number[]; closed: boolean; style: Style; width?: number }
  | { k: 'fill'; rings: number[][]; style: Style; bg?: boolean; alpha?: number; gradient?: { colors: [number, number]; angle: number } }
  | { k: 'text'; m: Affine2; text: string; font: string; bold: boolean; italic: boolean; h: number; w: number; style: Style }
  | { k: 'point'; x: number; y: number; style: Style }
  | { k: 'xline'; x: number; y: number; dx: number; dy: number; ray: boolean; style: Style }
  | { k: 'pattern'; rings: number[][]; lines: PatternLine[]; style: Style }
  /** 3D face (triangle/quad): `edges` bit i set = edge i..i+1 visible; `shade` = lighting factor 0..1. */
  | { k: 'face'; pts: number[]; edges: number; shade: number; style: Style }
) & { d?: number };

export interface PatternLine {
  ox: number; oy: number; // a point on line 0
  ux: number; uy: number; // unit-length direction in pattern units (world length = |u|)
  vx: number; vy: number; // offset to the next parallel line
  dashes: number[]; // in pattern units (scale by |u|)
}

/** Glyph space -> world: p = o + x*u + y*v (all WCS). */
export type Frame3 = { o: Vec3; u: Vec3; v: Vec3 };

/** Primitives in 3D world coordinates, built once per entity and projected per view. */
export type Prim3 =
  | { k: 'line'; pts: number[] /* x,y,z stride 3 */; closed: boolean; style: Style; width?: number }
  | { k: 'fill'; rings: number[][] /* stride 3 */; style: Style; bg?: boolean; alpha?: number; gradient?: { colors: [number, number]; dir: Vec3 } }
  | { k: 'text'; f: Frame3; text: string; font: string; bold: boolean; italic: boolean; h: number; w: number; style: Style }
  | { k: 'point'; p: Vec3; style: Style }
  | { k: 'xline'; p: Vec3; dir: Vec3; ray: boolean; style: Style }
  | { k: 'pattern'; rings: number[][] /* stride 3 */; lines: PatternLine3[]; style: Style }
  | { k: 'face'; pts: number[] /* 3 or 4 vertices, stride 3 */; edges: number; style: Style };

export interface PatternLine3 {
  o: Vec3;
  u: Vec3;
  v: Vec3;
  dashes: number[];
}

export interface EntityGeom {
  rec: DxfRecord;
  /** World-space primitives (view independent). */
  prims3: Prim3[];
  /** Primitives projected for the current view. */
  prims: Prim[];
  /** minX, minY, maxX, maxY in camera space; null when the entity produced nothing measurable. */
  bbox: [number, number, number, number] | null;
}

// ---- projection ----------------------------------------------------------------------

/** Light direction in camera space (upper left, toward the viewer). */
const LIGHT: Vec3 = (() => {
  const l: Vec3 = [-0.35, 0.5, 0.8];
  const n = Math.hypot(...l);
  return [l[0] / n, l[1] / n, l[2] / n];
})();

function projFlat(rot: Mat, src: number[], depth: { sum: number; n: number }): number[] {
  const out = new Array((src.length / 3) * 2);
  for (let i = 0, j = 0; i < src.length; i += 3, j += 2) {
    const x = src[i], y = src[i + 1], z = src[i + 2];
    out[j] = rot[0] * x + rot[1] * y + rot[2] * z;
    out[j + 1] = rot[4] * x + rot[5] * y + rot[6] * z;
    depth.sum += rot[8] * x + rot[9] * y + rot[10] * z;
    depth.n++;
  }
  return out;
}

const pv = (rot: Mat, p: Vec3): Vec3 => [
  rot[0] * p[0] + rot[1] * p[1] + rot[2] * p[2],
  rot[4] * p[0] + rot[5] * p[1] + rot[6] * p[2],
  rot[8] * p[0] + rot[9] * p[1] + rot[10] * p[2],
];

const crossV = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const subV = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** Parallel projection of a world primitive into camera space (an affine map, so shapes stay exact). */
export function projectPrim(p: Prim3, rot: Mat): Prim {
  const dep = { sum: 0, n: 0 };
  const depth = () => (dep.n ? dep.sum / dep.n : 0);
  switch (p.k) {
    case 'line': {
      const pts = projFlat(rot, p.pts, dep);
      return { k: 'line', pts, closed: p.closed, style: p.style, width: p.width, d: depth() };
    }
    case 'fill': {
      const rings = p.rings.map((r) => projFlat(rot, r, dep));
      let gradient: { colors: [number, number]; angle: number } | undefined;
      if (p.gradient) {
        const g = pv(rot, p.gradient.dir);
        gradient = { colors: p.gradient.colors, angle: Math.atan2(g[1], g[0]) };
      }
      return { k: 'fill', rings, style: p.style, bg: p.bg, alpha: p.alpha, gradient, d: depth() };
    }
    case 'pattern': {
      const rings = p.rings.map((r) => projFlat(rot, r, dep));
      const lines = p.lines.map((l) => {
        const o = pv(rot, l.o), u = pv(rot, l.u), v = pv(rot, l.v);
        return { ox: o[0], oy: o[1], ux: u[0], uy: u[1], vx: v[0], vy: v[1], dashes: l.dashes };
      });
      return { k: 'pattern', rings, lines, style: p.style, d: depth() };
    }
    case 'text': {
      const o = pv(rot, p.f.o), u = pv(rot, p.f.u), v = pv(rot, p.f.v);
      return { k: 'text', m: [u[0], u[1], v[0], v[1], o[0], o[1]], text: p.text, font: p.font, bold: p.bold, italic: p.italic, h: p.h, w: p.w, style: p.style, d: o[2] };
    }
    case 'point': {
      const q = pv(rot, p.p);
      return { k: 'point', x: q[0], y: q[1], style: p.style, d: q[2] };
    }
    case 'xline': {
      const q = pv(rot, p.p), d = pv(rot, p.dir);
      return { k: 'xline', x: q[0], y: q[1], dx: d[0], dy: d[1], ray: p.ray, style: p.style, d: q[2] };
    }
    case 'face': {
      const s = p.pts;
      const a: Vec3 = [s[0], s[1], s[2]], b: Vec3 = [s[3], s[4], s[5]], c: Vec3 = [s[6], s[7], s[8]];
      // world normal (quads: cross of the diagonals; triangles: of two edges), rotated into camera space
      const n = s.length >= 12 ? crossV(subV(c, a), subV([s[9], s[10], s[11]], b)) : crossV(subV(b, a), subV(c, a));
      const nc = pv(rot, n);
      const nl = Math.hypot(...nc) || 1;
      const shade = Math.abs((nc[0] * LIGHT[0] + nc[1] * LIGHT[1] + nc[2] * LIGHT[2]) / nl); // two-sided
      const pts = projFlat(rot, s, dep);
      return { k: 'face', pts, edges: p.edges, shade, style: p.style, d: depth() };
    }
  }
}

// ---- boxes ---------------------------------------------------------------------------------
export function emptyBox(): [number, number, number, number] {
  return [Infinity, Infinity, -Infinity, -Infinity];
}

export function growBox(b: [number, number, number, number], x: number, y: number): void {
  if (x < b[0]) b[0] = x;
  if (y < b[1]) b[1] = y;
  if (x > b[2]) b[2] = x;
  if (y > b[3]) b[3] = y;
}

export function primBox(p: Prim, b: [number, number, number, number]): void {
  switch (p.k) {
    case 'line': {
      const pad = (p.width ?? 0) / 2;
      for (let i = 0; i < p.pts.length; i += 2) {
        growBox(b, p.pts[i] - pad, p.pts[i + 1] - pad);
        growBox(b, p.pts[i] + pad, p.pts[i + 1] + pad);
      }
      break;
    }
    case 'fill':
    case 'pattern':
      for (const r of p.rings) for (let i = 0; i < r.length; i += 2) growBox(b, r[i], r[i + 1]);
      break;
    case 'face':
      for (let i = 0; i < p.pts.length; i += 2) growBox(b, p.pts[i], p.pts[i + 1]);
      break;
    case 'text': {
      const [a, bb, c, d, e, f] = p.m;
      for (const [x, y] of [[0, -0.3 * p.h], [p.w, -0.3 * p.h], [0, p.h], [p.w, p.h]]) {
        growBox(b, a * x + c * y + e, bb * x + d * y + f);
      }
      break;
    }
    case 'point':
      growBox(b, p.x, p.y);
      break;
    case 'xline':
      break; // infinite: excluded from extents
  }
}
