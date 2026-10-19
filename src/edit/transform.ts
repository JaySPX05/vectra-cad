import type { Group } from '../dxf/groups';
import { formatValue } from '../dxf/groups';
import type { DxfRecord, Vec3 } from '../dxf/record';
import type { DxfDocument } from '../model/database';
import type { Ucs } from '../model/ucs';
import { apply, applyDir, type Mat, mul, norm, ocsToWcs, rotateZ, scale, translate, wcsToOcs } from '../geom/ocs';

/**
 * A similarity transform in the WCS XY plane: p' = s * R(theta) * (p - base) + base + (dx, dy).
 * This covers MOVE, COPY, ROTATE and SCALE, which is what the editor offers.
 */
export interface Similarity {
  m: Mat;
  s: number; // uniform scale (> 0)
  theta: number; // rotation about +Z, radians
}

export function similarity(opts: { dx?: number; dy?: number; angle?: number; scale?: number; base?: [number, number] }): Similarity {
  const [bx, by] = opts.base ?? [0, 0];
  const s = opts.scale ?? 1;
  const th = opts.angle ?? 0;
  let m = translate(bx + (opts.dx ?? 0), by + (opts.dy ?? 0));
  m = mul(m, rotateZ(th));
  m = mul(m, scale(s, s, s));
  m = mul(m, translate(-bx, -by));
  return { m, s, theta: th };
}

/**
 * The same similarity expressed in a UCS: points/angles are UCS values, the result acts on WCS
 * (M = U * S * U^-1). Rotation stays "about the UCS Z axis".
 */
export function similarityInUcs(ucs: Ucs, opts: Parameters<typeof similarity>[0]): Similarity {
  const t = similarity(opts);
  if (ucs.isWorld) return t;
  // theta is used for "rotation about WCS Z" bookkeeping; a flipped UCS Z reverses its sense
  return { m: mul(ucs.matrix(), mul(t.m, ucs.inverse())), s: t.s, theta: t.theta * Math.sign(ucs.z[2] || 1) };
}

export class TransformError extends Error {}

const DEG = Math.PI / 180;

// ---- low-level group rewriting ------------------------------------------------------
function readP(gs: Group[], i: number): Vec3 {
  const c = gs[i].code;
  const x = Number(gs[i].value) || 0;
  const y = gs[i + 1]?.code === c + 10 ? Number(gs[i + 1].value) || 0 : 0;
  const z = gs[i + 2]?.code === c + 20 ? Number(gs[i + 2].value) || 0 : 0;
  return [x, y, z];
}
function writeP(gs: Group[], i: number, p: Vec3) {
  const c = gs[i].code;
  gs[i].value = formatValue(c, p[0]);
  if (gs[i + 1]?.code === c + 10) gs[i + 1].value = formatValue(c + 10, p[1]);
  if (gs[i + 2]?.code === c + 20) gs[i + 2].value = formatValue(c + 20, p[2]);
}
function setNum(g: Group, v: number) {
  g.value = formatValue(g.code, v);
}

/** Map every point group with one of `codes` (x codes) through f, optionally only within [from, to). */
function mapPoints(r: DxfRecord, codes: number[], f: (p: Vec3) => Vec3, from = 0, to = r.groups.length) {
  const gs = r.groups;
  for (let i = from; i < to; i++) if (codes.includes(gs[i].code)) writeP(gs, i, f(readP(gs, i)));
}
function mapNums(r: DxfRecord, codes: number[], f: (v: number) => number, from = 0, to = r.groups.length) {
  const gs = r.groups;
  for (let i = from; i < to; i++) if (codes.includes(gs[i].code)) setNum(gs[i], f(Number(gs[i].value) || 0));
}

/** OCS helper: transforms points/angles of an entity in its OCS and moves the extrusion. */
class Ocs {
  readonly n: Vec3;
  readonly n2: Vec3;
  private a: Mat; // OCS(n) -> OCS(n2) through the transform
  constructor(t: Similarity, n: Vec3) {
    this.n = norm(n);
    this.n2 = norm(applyDir(t.m, this.n));
    this.a = mul(wcsToOcs(this.n2), mul(t.m, ocsToWcs(this.n)));
  }
  point = (p: Vec3): Vec3 => apply(this.a, p);
  vector = (v: Vec3): Vec3 => applyDir(this.a, v);
  /** OCS angle in degrees -> transformed OCS angle in degrees. */
  angleDeg = (deg: number): number => {
    const d = applyDir(this.a, [Math.cos(deg * DEG), Math.sin(deg * DEG), 0]);
    let a = Math.atan2(d[1], d[0]) / DEG;
    if (a < 0) a += 360;
    return a;
  };
  angleRad = (rad: number): number => this.angleDeg(rad / DEG) * DEG;
  /** Whether the OCS map keeps the plane orientation (no mirror). */
  get mirrored(): boolean {
    return this.a[0] * this.a[5] - this.a[1] * this.a[4] < 0;
  }
  writeExtrusion(r: DxfRecord) {
    if (r.has(210) || Math.abs(this.n2[2] - 1) > 1e-12) r.setPoint(210, this.n2);
  }
}

function wcsPoint(t: Similarity) {
  return (p: Vec3) => apply(t.m, p);
}
function wcsVec(t: Similarity) {
  return (v: Vec3) => applyDir(t.m, v);
}

// ---- per-entity transforms -------------------------------------------------------------
type Fn = (r: DxfRecord, t: Similarity, doc: DxfDocument) => void;

const scaleBy = (t: Similarity) => (v: number) => v * t.s;

function ocsText(r: DxfRecord, t: Similarity) {
  const o = new Ocs(t, r.point(210, [0, 0, 1]));
  mapPoints(r, [10, 11], o.point);
  mapNums(r, [40], scaleBy(t));
  if (r.has(50) || t.theta) r.set(50, o.angleDeg(r.num(50, 0)));
  o.writeExtrusion(r);
}

const TRANSFORMS: Record<string, Fn> = {
  LINE(r, t) {
    mapPoints(r, [10, 11], wcsPoint(t));
    mapNums(r, [39], scaleBy(t));
    if (r.has(210)) r.setPoint(210, norm(applyDir(t.m, r.point(210))));
  },
  POINT(r, t) {
    mapPoints(r, [10], wcsPoint(t));
    if (r.has(50)) r.set(50, r.num(50, 0) + t.theta / DEG);
  },
  '3DFACE'(r, t) {
    mapPoints(r, [10, 11, 12, 13], wcsPoint(t));
  },
  CIRCLE(r, t) {
    const o = new Ocs(t, r.point(210, [0, 0, 1]));
    mapPoints(r, [10], o.point);
    mapNums(r, [40, 39], scaleBy(t));
    o.writeExtrusion(r);
  },
  ARC(r, t) {
    const o = new Ocs(t, r.point(210, [0, 0, 1]));
    mapPoints(r, [10], o.point);
    mapNums(r, [40, 39], scaleBy(t));
    const a0 = o.angleDeg(r.num(50, 0)), a1 = o.angleDeg(r.num(51, 0));
    if (o.mirrored) {
      r.set(50, a1);
      r.set(51, a0);
    } else {
      r.set(50, a0);
      r.set(51, a1);
    }
    o.writeExtrusion(r);
  },
  ELLIPSE(r, t) {
    mapPoints(r, [10], wcsPoint(t));
    mapPoints(r, [11], wcsVec(t));
    if (r.has(210)) r.setPoint(210, norm(applyDir(t.m, r.point(210))));
  },
  LWPOLYLINE(r, t) {
    const o = new Ocs(t, r.point(210, [0, 0, 1]));
    const elev = r.num(38, 0);
    let z = elev;
    const gs = r.groups;
    for (let i = 0; i < gs.length; i++) {
      if (gs[i].code !== 10) continue;
      const y = gs[i + 1]?.code === 20 ? Number(gs[i + 1].value) : 0;
      const q = o.point([Number(gs[i].value), y, elev]);
      setNum(gs[i], q[0]);
      if (gs[i + 1]?.code === 20) setNum(gs[i + 1], q[1]);
      z = q[2];
    }
    if (Math.abs(z - elev) > 1e-12 || r.has(38)) r.set(38, z);
    mapNums(r, [40, 41, 43, 39], scaleBy(t));
    if (o.mirrored) mapNums(r, [42], (b) => -b);
    o.writeExtrusion(r);
  },
  POLYLINE(r, t) {
    const flags = r.num(70, 0);
    if (flags & (8 | 16 | 64)) {
      for (const v of r.children) mapPoints(v, [10], wcsPoint(t));
      return;
    }
    const o = new Ocs(t, r.point(210, [0, 0, 1]));
    mapPoints(r, [10], o.point); // elevation point (0, 0, z)
    const elev = r.point(10)[2];
    for (const v of r.children) {
      if (v.type !== 'VERTEX') continue;
      const p = v.point(10);
      const q = o.point([p[0], p[1], p[2]]);
      v.setPoint(10, [q[0], q[1], elev]);
      mapNums(v, [40, 41], scaleBy(t));
      if (o.mirrored) mapNums(v, [42], (b) => -b);
      if (v.has(50)) v.set(50, o.angleDeg(v.num(50, 0)));
    }
    mapNums(r, [40, 41, 39], scaleBy(t));
    o.writeExtrusion(r);
  },
  SOLID(r, t) {
    const o = new Ocs(t, r.point(210, [0, 0, 1]));
    mapPoints(r, [10, 11, 12, 13], o.point);
    o.writeExtrusion(r);
  },
  TEXT: ocsText,
  ATTRIB: ocsText,
  ATTDEF: ocsText,
  MTEXT(r, t) {
    mapPoints(r, [10], wcsPoint(t));
    if (r.hasPoint(11)) mapPoints(r, [11], wcsVec(t));
    else if (r.has(50) || t.theta) r.set(50, r.num(50, 0) + t.theta / DEG);
    mapNums(r, [40, 41, 42, 43, 46], scaleBy(t));
  },
  INSERT(r, t, doc) {
    const o = new Ocs(t, r.point(210, [0, 0, 1]));
    mapPoints(r, [10], o.point);
    r.set(50, o.angleDeg(r.num(50, 0)));
    if (t.s !== 1) {
      for (const c of [41, 42, 43]) r.set(c, r.num(c, 1) * t.s);
      mapNums(r, [44, 45], scaleBy(t));
    }
    o.writeExtrusion(r);
    for (const a of r.children) if (a.type === 'ATTRIB') transformEntity(a, t, doc);
  },
  SPLINE(r, t) {
    mapPoints(r, [10, 11], wcsPoint(t));
    mapPoints(r, [12, 13], wcsVec(t));
    if (r.has(210)) r.setPoint(210, norm(applyDir(t.m, r.point(210))));
  },
  XLINE(r, t) {
    mapPoints(r, [10], wcsPoint(t));
    mapPoints(r, [11], (v) => norm(applyDir(t.m, v)));
  },
  LEADER(r, t) {
    mapPoints(r, [10], wcsPoint(t));
    mapPoints(r, [211, 212, 213], wcsVec(t));
    mapNums(r, [40, 41], scaleBy(t));
  },
  IMAGE(r, t) {
    mapPoints(r, [10], wcsPoint(t));
    mapPoints(r, [11, 12], wcsVec(t));
  },
  MLINE(r, t) {
    mapPoints(r, [10, 11], wcsPoint(t));
    mapPoints(r, [12, 13], wcsVec(t));
    mapNums(r, [40, 41, 42], scaleBy(t));
  },
  DIMENSION(r, t, doc) {
    const o = new Ocs(t, r.point(210, [0, 0, 1]));
    mapPoints(r, [10, 13, 14, 15], wcsPoint(t));
    mapPoints(r, [11, 12, 16], o.point);
    const type = r.num(70, 0) & 7;
    if (type !== 2 && type !== 5 && r.has(42)) r.set(42, r.num(42, 0) * t.s);
    for (const c of [50, 53]) if (r.has(c)) r.set(c, r.num(c, 0) + t.theta / DEG);
    o.writeExtrusion(r);
    transformBlock(doc, r.str(2), t);
  },
  ACAD_TABLE(r, t, doc) {
    if (t.s !== 1) throw new TransformError('Scaling tables is not supported');
    mapPoints(r, [10], wcsPoint(t));
    if (r.hasPoint(11)) mapPoints(r, [11], wcsVec(t));
    else r.setPoint(11, wcsVec(t)([1, 0, 0]));
    void doc; // block content is relative to the insertion point
  },
  MULTILEADER(r, t) {
    // Rotation is about Z, so normals (0,0,1) stay unchanged when treated as vectors.
    // Geometry lives in the CONTEXT_DATA{ ... } block (300 .. 301); groups after it are
    // style overrides (e.g. 10 = block scale vector, 41 = dogleg length, 42 = arrow size).
    const gs = r.groups;
    const a = gs.findIndex((g) => g.code === 300 && g.value.includes('CONTEXT_DATA{'));
    const b = a < 0 ? -1 : gs.findIndex((g, i) => i > a && g.code === 301);
    if (a < 0 || b < 0) throw new TransformError('MULTILEADER without context data');
    mapPoints(r, [10, 12, 15, 110], wcsPoint(t), a, b);
    mapPoints(r, [11, 13, 14, 111, 112], (v) => norm(applyDir(t.m, v)), a, b); // unit directions
    mapNums(r, [40, 41, 140, 145, 44], scaleBy(t), a, b);
    mapNums(r, [41, 42], scaleBy(t), b);
  },
  HATCH: transformHatch,
  MESH(r, t) {
    // WCS vertices sit between the vertex count (92) and the face list (93)
    const vi = r.indexOf(92);
    if (vi < 0) return;
    const fi = r.indexOf(93, vi);
    mapPoints(r, [10], wcsPoint(t), vi + 1, fi < 0 ? undefined : fi);
  },
  WIPEOUT(r, t) {
    mapPoints(r, [10], wcsPoint(t));
    mapPoints(r, [11, 12], wcsVec(t));
  },
};
TRANSFORMS.TRACE = TRANSFORMS.SOLID;
TRANSFORMS.RAY = TRANSFORMS.XLINE;
TRANSFORMS.HELIX = TRANSFORMS.SPLINE;
TRANSFORMS.MLEADER = TRANSFORMS.MULTILEADER;
TRANSFORMS.ARC_DIMENSION = TRANSFORMS.DIMENSION;
TRANSFORMS.LARGE_RADIAL_DIMENSION = TRANSFORMS.DIMENSION;

export function canTransform(r: DxfRecord): boolean {
  return r.type in TRANSFORMS;
}

/** Transform an entity in place (its groups are rewritten). */
export function transformEntity(r: DxfRecord, t: Similarity, doc: DxfDocument): void {
  const f = TRANSFORMS[r.type];
  if (!f) throw new TransformError(`${r.type} cannot be transformed (unsupported entity data)`);
  f(r, t, doc);
}

/** Transform the contents of a (dimension) block that lives in WCS. */
function transformBlock(doc: DxfDocument, name: string, t: Similarity) {
  const blk = doc.block(name);
  if (!blk || !name.startsWith('*')) return;
  for (const e of blk.entities) if (canTransform(e)) transformEntity(e, t, doc);
}

/** Records touched by a transform, so undo can snapshot them first. */
export function affectedRecords(r: DxfRecord, doc: DxfDocument): DxfRecord[] {
  const out = [r];
  if (r.type.endsWith('DIMENSION')) {
    const blk = doc.block(r.str(2));
    if (blk && r.str(2).startsWith('*')) out.push(...blk.entities);
  }
  return out;
}

// ---- HATCH -------------------------------------------------------------------------
/** Walks the hatch boundary/pattern data and rewrites each value by its meaning. */
function transformHatch(r: DxfRecord, t: Similarity) {
  const o = new Ocs(t, r.point(210, [0, 0, 1]));
  const gs = r.groups;
  const n = o.n, n2 = o.n2;
  if (Math.abs(n[0] - n2[0]) + Math.abs(n[1] - n2[1]) + Math.abs(n[2] - n2[2]) > 1e-9) {
    throw new TransformError('HATCH transform out of its plane is not supported');
  }
  const P = (i: number) => writeP(gs, i, o.point(readP(gs, i)));
  const V = (i: number) => writeP(gs, i, o.vector(readP(gs, i)));
  const S = (i: number) => setNum(gs[i], Number(gs[i].value) * t.s);
  const A = (i: number) => setNum(gs[i], o.angleDeg(Number(gs[i].value)));
  let i = gs.findIndex((g) => g.code === 100 && g.value.trim() === 'AcDbHatch');
  if (i < 0) i = 0;
  const at = (code: number) => {
    while (i < gs.length && gs[i].code !== code) i++;
    return i < gs.length ? i : -1;
  };
  // elevation point: x=y=0, z = elevation -> only z can change for in-plane transforms
  const ei = at(10);
  if (ei >= 0) {
    const p = o.point([0, 0, readP(gs, ei)[2]]);
    writeP(gs, ei, [0, 0, p[2]]);
  }
  const ni = at(91);
  if (ni < 0) return;
  const nPaths = Number(gs[ni].value);
  i = ni + 1;
  const num = () => Number(gs[i].value);
  for (let p = 0; p < nPaths; p++) {
    if (at(92) < 0) return;
    const flags = num();
    i++;
    if (flags & 2) {
      const hasBulge = gs[i]?.code === 72 ? Number(gs[i].value) : 0;
      const ci = at(93);
      const nv = Number(gs[ci].value);
      i++;
      for (let v = 0; v < nv; v++) {
        at(10);
        P(i);
        i += 2;
        if (hasBulge && gs[i]?.code === 42) {
          if (o.mirrored) setNum(gs[i], -Number(gs[i].value));
          i++;
        }
      }
    } else {
      const ne = Number(gs[at(93)].value);
      i++;
      for (let e = 0; e < ne; e++) {
        at(72);
        const type = num();
        i++;
        if (type === 1) {
          P(at(10)); i += 2;
          P(at(11)); i += 2;
        } else if (type === 2 || type === 3) {
          P(at(10)); i += 2;
          if (type === 3) { V(at(11)); i += 2; }
          const ri = at(40);
          if (type === 2) S(ri);
          i++;
          const si = at(50), ei2 = si + 1;
          const ccwI = gs[si + 2]?.code === 73 ? si + 2 : -1;
          const ccw = ccwI < 0 ? true : Number(gs[ccwI].value) !== 0;
          // clockwise edges store mirrored angles
          const conv = (a: number) => (ccw ? o.angleDeg(a) : 360 - o.angleDeg(360 - a));
          const a0 = conv(Number(gs[si].value)), a1 = conv(Number(gs[ei2].value));
          if (type === 2) {
            setNum(gs[si], a0);
            setNum(gs[ei2], a1 < a0 && ccw ? a1 + 360 : a1);
          }
          // ellipse params are relative to the (already rotated) major axis: unchanged
          i = ei2 + 1;
        } else if (type === 4) {
          const nk = Number(gs[at(95)].value);
          const nc = Number(gs[at(96)].value);
          i++;
          for (let k = 0; k < nk; k++) { at(40); i++; }
          for (let k = 0; k < nc; k++) { P(at(10)); i += 2; }
          if (gs[i]?.code === 42) while (gs[i]?.code === 42) i++;
          if (gs[i]?.code === 97) {
            const nf = Number(gs[i].value);
            i++;
            for (let k = 0; k < nf; k++) { P(at(11)); i += 2; }
            if (gs[i]?.code === 12) { V(i); i += 2; }
            if (gs[i]?.code === 13) { V(i); i += 2; }
          }
        }
      }
    }
    if (gs[i]?.code === 97) {
      const ns = Number(gs[i].value);
      i += 1 + ns;
    }
  }
  // pattern data
  for (; i < gs.length; i++) {
    const c = gs[i].code;
    if (c === 52 || c === 53) A(i);
    else if (c === 41 || c === 49) S(i);
    else if (c === 43 || c === 45) {
      // pattern base point (43/44) and offset vector (45/46) use non-standard y codes
      if (gs[i + 1]?.code !== c + 1) continue;
      const v: Vec3 = [Number(gs[i].value), Number(gs[i + 1].value), 0];
      const q = c === 43 ? o.point(v) : o.vector(v);
      setNum(gs[i], q[0]);
      setNum(gs[i + 1], q[1]);
      i++;
    }
    else if (c === 98) {
      const ns = Number(gs[i].value);
      i++;
      for (let k = 0; k < ns && gs[i]?.code === 10; k++) { P(i); i += 2; }
      break;
    } else if (c >= 450 || c === 1001) break;
  }
  o.writeExtrusion(r);
}
