import type { DxfRecord } from '../dxf/record';
import type { DxfDocument } from '../model/database';
import { buildEntity, createEnv, type Env } from './geometry';
import { emptyBox, type EntityGeom, type Prim, type Prim3, primBox, projectPrim } from './prims';
import { TOP_INHERIT } from './style';
import { IDENTITY, type Mat } from '../geom/ocs';
import type { Vec3 } from '../dxf/record';

type Box = [number, number, number, number];

/**
 * Display list for model space: one EntityGeom per top-level entity, with a
 * uniform-grid spatial index for culling and picking. Edits call `rebuild(rec)`.
 */
export class Scene {
  env: Env;
  items: EntityGeom[] = [];
  private byRec = new Map<DxfRecord, EntityGeom>();
  private grid = new Map<number, EntityGeom[]>();
  private big: EntityGeom[] = [];
  private cell = 1;
  private origin: [number, number] = [0, 0];
  extents: Box | null = null;
  /** Current view rotation (world -> camera); identity = top/plan view. */
  rot: Mat = IDENTITY;
  private order: { g: EntityGeom; p: Prim }[] | null = null;
  private worldBox: [Vec3, Vec3] | null | undefined;

  constructor(public doc: DxfDocument) {
    this.env = createEnv(doc);
    this.rebuildAll();
  }

  /** Model space: ENTITIES section records not flagged as paper space (67=1). */
  modelEntities(): DxfRecord[] {
    return this.doc.entities.filter((e) => e.num(67, 0) !== 1);
  }

  private build(rec: DxfRecord): EntityGeom {
    const prims3: Prim3[] = [];
    try {
      buildEntity(this.env, rec, { m: IDENTITY, inh: TOP_INHERIT, depth: 0, inBlock: false, stack: [] }, prims3);
    } catch (err) {
      console.warn('Failed to build', rec.type, rec.handle, err);
    }
    const g: EntityGeom = { rec, prims3, prims: [], bbox: null };
    this.project(g);
    return g;
  }

  /** Project an entity's world primitives with the current view. */
  private project(g: EntityGeom): void {
    g.prims = g.prims3.map((p) => projectPrim(p, this.rot));
    const b = emptyBox();
    for (const p of g.prims) primBox(p, b);
    g.bbox = b[0] <= b[2] ? b : null;
  }

  /** Change the view rotation: reproject everything and rebuild the spatial index. */
  setView(rot: Mat): void {
    this.rot = rot;
    for (const g of this.items) this.project(g);
    this.order = null;
    this.computeExtents();
    this.reindex();
  }

  /** All projected primitives sorted back to front (for hidden / shaded visual styles). */
  depthOrder(): { g: EntityGeom; p: Prim }[] {
    if (!this.order) {
      const all: { g: EntityGeom; p: Prim }[] = [];
      for (const g of this.items) for (const p of g.prims) all.push({ g, p });
      all.sort((a, b) => (a.p.d ?? 0) - (b.p.d ?? 0));
      this.order = all;
    }
    return this.order;
  }

  /** World-space bounding box of all geometry (view independent). */
  worldBounds(): [Vec3, Vec3] | null {
    if (this.worldBox !== undefined) return this.worldBox;
    const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    const add = (x: number, y: number, z: number) => {
      if (x < lo[0]) lo[0] = x; if (y < lo[1]) lo[1] = y; if (z < lo[2]) lo[2] = z;
      if (x > hi[0]) hi[0] = x; if (y > hi[1]) hi[1] = y; if (z > hi[2]) hi[2] = z;
    };
    for (const g of this.items) for (const p of g.prims3) {
      if (p.k === 'line' || p.k === 'face') for (let i = 0; i < p.pts.length; i += 3) add(p.pts[i], p.pts[i + 1], p.pts[i + 2]);
      else if (p.k === 'fill' || p.k === 'pattern') for (const r of p.rings) for (let i = 0; i < r.length; i += 3) add(r[i], r[i + 1], r[i + 2]);
      else if (p.k === 'text') add(p.f.o[0], p.f.o[1], p.f.o[2]);
      else if (p.k === 'point') add(p.p[0], p.p[1], p.p[2]);
    }
    this.worldBox = lo[0] <= hi[0] ? [lo, hi] : null;
    return this.worldBox;
  }

  rebuildAll(): void {
    this.env.styles.reset();
    this.env.fonts.reset();
    this.env.unsupported.clear();
    this.items = this.modelEntities().map((r) => this.build(r));
    this.byRec = new Map(this.items.map((g) => [g.rec, g]));
    this.order = null;
    this.worldBox = undefined;
    this.computeExtents();
    this.reindex();
  }

  /** Re-generate one entity (after an edit), or add it if new. */
  rebuild(rec: DxfRecord): void {
    this.order = null;
    this.worldBox = undefined;
    const old = this.byRec.get(rec);
    const g = this.build(rec);
    if (old) {
      this.unindex(old);
      const i = this.items.indexOf(old);
      this.items[i] = g;
    } else this.items.push(g);
    this.byRec.set(rec, g);
    this.index(g);
  }

  remove(rec: DxfRecord): void {
    this.order = null;
    this.worldBox = undefined;
    const old = this.byRec.get(rec);
    if (!old) return;
    this.unindex(old);
    this.items.splice(this.items.indexOf(old), 1);
    this.byRec.delete(rec);
  }

  /** Re-sync with the entity list after structural edits (keeps draw order = file order). */
  sync(): void {
    const recs = this.modelEntities();
    const set = new Set(recs);
    for (const r of [...this.byRec.keys()]) if (!set.has(r)) this.remove(r);
    for (const r of recs) if (!this.byRec.has(r)) this.rebuild(r);
    this.items = recs.map((r) => this.byRec.get(r)!).filter(Boolean);
    this.order = null;
  }

  /** Primitives for records that are not (or not yet) in the drawing, e.g. command previews. */
  previewPrims(recs: DxfRecord[]): Prim[] {
    return recs.flatMap((r) => this.build(r).prims);
  }

  /** World-space primitives for records not in the drawing. */
  previewPrims3(recs: DxfRecord[]): Prim3[] {
    return recs.flatMap((r) => this.build(r).prims3);
  }

  geomOf(rec: DxfRecord): EntityGeom | undefined {
    return this.byRec.get(rec);
  }

  computeExtents(): Box | null {
    const b = emptyBox();
    for (const g of this.items) {
      if (!g.bbox) continue;
      if (b[0] > g.bbox[0]) b[0] = g.bbox[0];
      if (b[1] > g.bbox[1]) b[1] = g.bbox[1];
      if (b[2] < g.bbox[2]) b[2] = g.bbox[2];
      if (b[3] < g.bbox[3]) b[3] = g.bbox[3];
    }
    this.extents = b[0] <= b[2] ? b : null;
    return this.extents;
  }

  // ---- spatial index -------------------------------------------------------------
  private reindex(): void {
    this.grid.clear();
    this.big = [];
    const e = this.extents ?? [0, 0, 1, 1];
    this.origin = [e[0], e[1]];
    this.cell = Math.max((e[2] - e[0]) / 128, (e[3] - e[1]) / 128, 1e-9);
    for (const g of this.items) this.index(g);
  }
  private cellRange(b: Box): [number, number, number, number] {
    const c = this.cell, [ox, oy] = this.origin;
    return [Math.floor((b[0] - ox) / c), Math.floor((b[1] - oy) / c), Math.floor((b[2] - ox) / c), Math.floor((b[3] - oy) / c)];
  }
  private key(i: number, j: number): number {
    return (i + 32768) * 65536 + (j + 32768);
  }
  private index(g: EntityGeom): void {
    if (!g.bbox || g.prims.some((p) => p.k === 'xline')) {
      this.big.push(g);
      return;
    }
    const [i0, j0, i1, j1] = this.cellRange(g.bbox);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 256 || Math.abs(i0) > 30000 || Math.abs(j1) > 30000) {
      this.big.push(g);
      return;
    }
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const k = this.key(i, j);
        let a = this.grid.get(k);
        if (!a) this.grid.set(k, (a = []));
        a.push(g);
      }
  }
  private unindex(g: EntityGeom): void {
    const bi = this.big.indexOf(g);
    if (bi >= 0) {
      this.big.splice(bi, 1);
      return;
    }
    if (!g.bbox) return;
    const [i0, j0, i1, j1] = this.cellRange(g.bbox);
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const a = this.grid.get(this.key(i, j));
        if (a) {
          const k = a.indexOf(g);
          if (k >= 0) a.splice(k, 1);
        }
      }
  }

  /** Candidates whose cells overlap the box. */
  query(b: Box): Set<EntityGeom> {
    const out = new Set<EntityGeom>(this.big);
    const [i0, j0, i1, j1] = this.cellRange(b);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 20000) return new Set(this.items);
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const a = this.grid.get(this.key(i, j));
        if (a) for (const g of a) out.add(g);
      }
    return out;
  }

  // ---- picking -------------------------------------------------------------------
  pick(x: number, y: number, tol: number): EntityGeom | null {
    let best: EntityGeom | null = null;
    let bestD = tol;
    for (const g of this.query([x - tol, y - tol, x + tol, y + tol])) {
      if (g.bbox && (x < g.bbox[0] - tol || x > g.bbox[2] + tol || y < g.bbox[1] - tol || y > g.bbox[3] + tol)) continue;
      for (const p of g.prims) {
        const d = primDistance(p, x, y);
        if (d <= bestD) {
          bestD = d;
          best = g;
        }
      }
    }
    return best;
  }

  /** Window (fully inside) or crossing (touching) selection. */
  inRect(b: Box, crossing: boolean): EntityGeom[] {
    const out: EntityGeom[] = [];
    for (const g of this.query(b)) {
      if (!g.bbox) continue;
      const inside = g.bbox[0] >= b[0] && g.bbox[2] <= b[2] && g.bbox[1] >= b[1] && g.bbox[3] <= b[3];
      if (inside) out.push(g);
      else if (crossing && boxesOverlap(g.bbox, b) && g.prims.some((p) => primTouchesRect(p, b))) out.push(g);
    }
    return out;
  }
}

function boxesOverlap(a: Box, b: Box) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

export function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function ringsContain(rings: number[][], x: number, y: number): boolean {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function ringsDistance(rings: number[][], x: number, y: number): number {
  let d = Infinity;
  for (const r of rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) d = Math.min(d, segDist(x, y, r[j], r[j + 1], r[i], r[i + 1]));
  }
  return d;
}

export function primDistance(p: Prim, x: number, y: number): number {
  switch (p.k) {
    case 'line': {
      let d = Infinity;
      const n = p.pts.length;
      for (let i = 2; i < n; i += 2) d = Math.min(d, segDist(x, y, p.pts[i - 2], p.pts[i - 1], p.pts[i], p.pts[i + 1]));
      if (p.closed && n >= 4) d = Math.min(d, segDist(x, y, p.pts[n - 2], p.pts[n - 1], p.pts[0], p.pts[1]));
      if (n === 2) d = Math.hypot(x - p.pts[0], y - p.pts[1]);
      return Math.max(0, d - (p.width ?? 0) / 2);
    }
    case 'fill':
    case 'pattern':
      return ringsContain(p.rings, x, y) ? 0 : ringsDistance(p.rings, x, y);
    case 'face':
      // pick faces by their visible edges (wireframe) — interior picks would hide what's behind
      return faceEdgeDistance(p.pts, p.edges, x, y);
    case 'text': {
      const [a, b, c, d, e, f] = p.m;
      const det = a * d - b * c;
      if (!det) return Infinity;
      const lx = (d * (x - e) - c * (y - f)) / det;
      const ly = (-b * (x - e) + a * (y - f)) / det;
      if (lx >= 0 && lx <= p.w && ly >= -0.3 * p.h && ly <= p.h) return 0;
      const corners = [[0, -0.3 * p.h], [p.w, -0.3 * p.h], [p.w, p.h], [0, p.h]].flatMap(([u, v]) => [a * u + c * v + e, b * u + d * v + f]);
      return ringsDistance([corners], x, y);
    }
    case 'point':
      return Math.hypot(x - p.x, y - p.y);
    case 'xline': {
      const l = Math.hypot(p.dx, p.dy) || 1;
      const ux = p.dx / l, uy = p.dy / l;
      const t = (x - p.x) * ux + (y - p.y) * uy;
      if (p.ray && t < 0) return Math.hypot(x - p.x, y - p.y);
      return Math.abs((x - p.x) * uy - (y - p.y) * ux);
    }
  }
}

function segTouchesRect(ax: number, ay: number, bx: number, by: number, r: Box): boolean {
  // Liang-Barsky clip test
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  const tests: [number, number][] = [[-dx, ax - r[0]], [dx, r[2] - ax], [-dy, ay - r[1]], [dy, r[3] - ay]];
  for (const [p, q] of tests) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
  }
  return true;
}

function primTouchesRect(p: Prim, r: Box): boolean {
  switch (p.k) {
    case 'line': {
      const n = p.pts.length;
      if (n === 2) return p.pts[0] >= r[0] && p.pts[0] <= r[2] && p.pts[1] >= r[1] && p.pts[1] <= r[3];
      for (let i = 2; i < n; i += 2) if (segTouchesRect(p.pts[i - 2], p.pts[i - 1], p.pts[i], p.pts[i + 1], r)) return true;
      return p.closed && segTouchesRect(p.pts[n - 2], p.pts[n - 1], p.pts[0], p.pts[1], r);
    }
    case 'face': {
      const n = p.pts.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        if (segTouchesRect(p.pts[i * 2], p.pts[i * 2 + 1], p.pts[j * 2], p.pts[j * 2 + 1], r)) return true;
      }
      return false;
    }
    case 'fill':
    case 'pattern':
      for (const ring of p.rings)
        for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2)
          if (segTouchesRect(ring[j], ring[j + 1], ring[i], ring[i + 1], r)) return true;
      return ringsContain(p.rings, r[0], r[1]);
    case 'text': {
      const b = emptyBox();
      primBox(p, b);
      return boxesOverlap(b, r);
    }
    case 'point':
      return p.x >= r[0] && p.x <= r[2] && p.y >= r[1] && p.y <= r[3];
    case 'xline':
      return segTouchesRect(p.x - p.dx * 1e9, p.y - p.dy * 1e9, p.x + p.dx * 1e9, p.y + p.dy * 1e9, r);
  }
}

function faceEdgeDistance(pts: number[], edges: number, x: number, y: number): number {
  const n = pts.length / 2;
  let d = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    // invisible edges still count for picking so edge-less walls (thickness) can be selected
    const k = edges & (1 << i) ? 1 : 1.0001;
    d = Math.min(d, segDist(x, y, pts[i * 2], pts[i * 2 + 1], pts[j * 2], pts[j * 2 + 1]) * k);
  }
  return d;
}
