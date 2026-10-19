import { DxfRecord, type Vec3 } from '../dxf/record';
import type { DxfDocument } from '../model/database';
import { apply, applyDir, cross, type Mat, mul, norm, ocsToWcs, rotateZ, scale, translate, DEG, ocsAxes } from '../geom/ocs';
import { arcPoints, bulgePoints, circlePoints, ellipsePoints, fitPointCurve, splinePoints } from '../geom/tessellate';
import { decodeHatch } from './hatch';
import type { Frame3, Prim3 } from './prims';
import { type Inherit, type Style, StyleResolver } from './style';
import { FontResolver, layoutMText, layoutText } from './text';

export interface Env {
  doc: DxfDocument;
  styles: StyleResolver;
  fonts: FontResolver;
  /** Entity types we could not draw, with counts. */
  unsupported: Map<string, number>;
}

export interface Ctx {
  m: Mat; // block -> world
  inh: Inherit;
  depth: number;
  inBlock: boolean;
  /** Block names on the current insert stack (cycle guard). */
  stack: string[];
}

export function createEnv(doc: DxfDocument): Env {
  return { doc, styles: new StyleResolver(doc), fonts: new FontResolver(doc), unsupported: new Map() };
}

const MAX_DEPTH = 24;

// ---- helpers -------------------------------------------------------------------
function polyPrim(m: Mat, pts: Vec3[], closed: boolean, style: Style, width?: number): Prim3 | null {
  if (pts.length < 2) return null;
  const flat: number[] = new Array(pts.length * 3);
  for (let i = 0; i < pts.length; i++) {
    const q = apply(m, pts[i]);
    flat[i * 3] = q[0];
    flat[i * 3 + 1] = q[1];
    flat[i * 3 + 2] = q[2];
  }
  return { k: 'line', pts: flat, closed, style, width };
}

/** World frame of the OCS plane at elevation z under matrix m. */
function planeFrame(m: Mat, z: number): Frame3 {
  return { o: apply(m, [0, 0, z]), u: applyDir(m, [1, 0, 0]), v: applyDir(m, [0, 1, 0]) };
}

/** Approximate uniform scale of a transform (XY plane, else volume). */
function linearScale(m: Mat): number {
  const d2 = Math.abs(m[0] * m[5] - m[1] * m[4]);
  if (d2 > 1e-12) return Math.sqrt(d2);
  const d3 = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
  return Math.cbrt(Math.abs(d3)) || 1;
}

/** Faces from 3D vertices (3 or 4); `edges` bit i = edge from vertex i to i+1 is visible. */
function facePrim(m: Mat, pts: Vec3[], edges: number, style: Style): Prim3 {
  const flat: number[] = [];
  for (const p of pts) flat.push(...apply(m, p));
  return { k: 'face', pts: flat, edges, style };
}

/**
 * Thickness (group 39): extrude an entity's outline along its OCS normal. Adds the top copy,
 * vertical edges at corners/ends, and wall faces (seen in hidden/shaded styles).
 */
function extrude(out: Prim3[], from: number, t: Vec3) {
  const base = out.slice(from);
  for (const p of base) {
    if (p.k === 'point') {
      out.push({ k: 'line', pts: [...p.p, p.p[0] + t[0], p.p[1] + t[1], p.p[2] + t[2]], closed: false, style: p.style });
      continue;
    }
    if (p.k !== 'line') continue;
    const s = p.pts, n = s.length / 3;
    const top = s.map((v, i) => v + t[i % 3]);
    out.push({ ...p, pts: top });
    const segs = p.closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = i * 3, b = ((i + 1) % n) * 3;
      out.push({ k: 'face', pts: [s[a], s[a + 1], s[a + 2], s[b], s[b + 1], s[b + 2], top[b], top[b + 1], top[b + 2], top[a], top[a + 1], top[a + 2]], edges: 0, style: p.style });
    }
    // vertical edges where the outline turns sharply, and at open ends
    for (let i = 0; i < n; i++) {
      const prev = i > 0 ? i - 1 : p.closed ? n - 1 : -1;
      const next = i < n - 1 ? i + 1 : p.closed ? 0 : -1;
      let corner = prev < 0 || next < 0;
      if (!corner) {
        const ax = s[i * 3] - s[prev * 3], ay = s[i * 3 + 1] - s[prev * 3 + 1], az = s[i * 3 + 2] - s[prev * 3 + 2];
        const bx = s[next * 3] - s[i * 3], by = s[next * 3 + 1] - s[i * 3 + 1], bz = s[next * 3 + 2] - s[i * 3 + 2];
        const la = Math.hypot(ax, ay, az), lb = Math.hypot(bx, by, bz);
        corner = la > 0 && lb > 0 && (ax * bx + ay * by + az * bz) / (la * lb) < Math.cos(Math.PI / 6);
      }
      if (corner) out.push({ k: 'line', pts: [s[i * 3], s[i * 3 + 1], s[i * 3 + 2], top[i * 3], top[i * 3 + 1], top[i * 3 + 2]], closed: false, style: p.style });
    }
  }
}

const THICK = new Set(['LINE', 'CIRCLE', 'ARC', 'LWPOLYLINE', 'POLYLINE', 'POINT']);

function extrusion(rec: DxfRecord): Vec3 {
  return rec.point(210, [0, 0, 1]);
}

/** OCS -> world for an entity. */
function ocsMat(ctx: Ctx, rec: DxfRecord): Mat {
  return mul(ctx.m, ocsToWcs(extrusion(rec)));
}

// ---- entry ---------------------------------------------------------------------
export function buildEntity(env: Env, rec: DxfRecord, ctx: Ctx, out: Prim3[]): void {
  if (rec.num(60, 0) === 1) return; // invisible flag
  const layer = env.styles.effectiveLayer(rec, ctx.inh);
  if (!env.styles.layerVisible(layer)) {
    // An INSERT on an off (not frozen) layer still shows children that live on other layers.
    if (!(rec.type === 'INSERT' && !env.styles.layerFrozen(layer))) return;
  }
  const style = env.styles.style(rec, ctx.inh);
  const b = BUILDERS[rec.type];
  const start = out.length;
  if (b) b(env, rec, ctx, style, out);
  else {
    env.unsupported.set(rec.type, (env.unsupported.get(rec.type) ?? 0) + 1);
    return;
  }
  const th = THICK.has(rec.type) ? rec.num(39, 0) : 0;
  if (th && !(rec.type === 'POLYLINE' && rec.num(70, 0) & (8 | 16 | 64))) {
    // LINE and POINT extrude along their extrusion vector too (default +Z)
    const wcsEntity = rec.type === 'LINE' || rec.type === 'POINT';
    const n = norm(extrusion(rec));
    const t = wcsEntity ? applyDir(ctx.m, [n[0] * th, n[1] * th, n[2] * th]) : applyDir(ocsMat(ctx, rec), [0, 0, th]);
    extrude(out, start, t);
  }
}

type Builder = (env: Env, rec: DxfRecord, ctx: Ctx, style: Style, out: Prim3[]) => void;

function push(out: Prim3[], p: Prim3 | null) {
  if (p) out.push(p);
}

const BUILDERS: Record<string, Builder> = {
  LINE(_e, r, ctx, st, out) {
    push(out, polyPrim(ctx.m, [r.point(10), r.point(11)], false, st));
  },

  POINT(_e, r, ctx, st, out) {
    out.push({ k: 'point', p: apply(ctx.m, r.point(10)), style: st });
  },

  CIRCLE(_e, r, ctx, st, out) {
    const c = r.point(10);
    push(out, polyPrim(ocsMat(ctx, r), circlePoints(c, r.num(40, 0)), true, st));
  },

  ARC(_e, r, ctx, st, out) {
    const c = r.point(10);
    push(out, polyPrim(ocsMat(ctx, r), arcPoints(c, r.num(40, 0), r.num(50, 0) * DEG, r.num(51, 360) * DEG), false, st));
  },

  ELLIPSE(_e, r, ctx, st, out) {
    const c = r.point(10);
    const major = r.point(11, [1, 0, 0]);
    const minor = cross(norm(extrusion(r)), major).map((v) => v * r.num(40, 1)) as Vec3;
    const t0 = r.num(41, 0), t1 = r.num(42, Math.PI * 2);
    const full = Math.abs(t1 - t0 - Math.PI * 2) < 1e-9 || Math.abs(t1 - t0) < 1e-12;
    push(out, polyPrim(ctx.m, ellipsePoints(c, major, minor, t0, full ? t0 + Math.PI * 2 : t1), full, st));
  },

  LWPOLYLINE(_e, r, ctx, st, out) {
    const elev = r.num(38, 0);
    const constW = r.num(43, 0);
    const verts: { p: Vec3; sw: number; ew: number; b: number }[] = [];
    const gs = r.groups;
    for (let i = 0; i < gs.length; i++) {
      const g = gs[i];
      if (g.code === 10) {
        const y = gs[i + 1]?.code === 20 ? Number(gs[i + 1].value) : 0;
        verts.push({ p: [Number(g.value), y, elev], sw: constW, ew: constW, b: 0 });
      } else if (verts.length) {
        const v = verts[verts.length - 1];
        if (g.code === 40) v.sw = Number(g.value);
        else if (g.code === 41) v.ew = Number(g.value);
        else if (g.code === 42) v.b = Number(g.value);
      }
    }
    emitPolyline(ocsMat(ctx, r), verts, (r.num(70, 0) & 1) === 1, st, out);
  },

  POLYLINE(env, r, ctx, st, out) {
    const flags = r.num(70, 0);
    const verts = r.children.filter((c) => c.type === 'VERTEX');
    if (flags & 16) return meshPolyline(r, verts, ctx, st, out);
    if (flags & 64) return polyfacePolyline(env, verts, ctx, st, out);
    const is3d = (flags & 8) !== 0;
    const m = is3d ? ctx.m : ocsMat(ctx, r);
    const elev = r.point(10)[2];
    const hasFit = verts.some((v) => v.num(70, 0) & 8);
    const dsw = r.num(40, 0), dew = r.num(41, 0);
    const vs = verts
      .filter((v) => {
        const f = v.num(70, 0);
        return !(f & 16) && (!hasFit || f & 8 || f & 1);
      })
      .map((v) => {
        const p = v.point(10);
        return { p: (is3d ? p : [p[0], p[1], elev]) as Vec3, sw: v.num(40, dsw), ew: v.num(41, dew), b: is3d ? 0 : v.num(42, 0) };
      });
    emitPolyline(m, vs, (flags & 1) === 1, st, out);
  },

  SOLID: solid,
  TRACE: solid,

  '3DFACE'(_e, r, ctx, st, out) {
    const a = r.point(10), b = r.point(11), c = r.point(12), d = r.hasPoint(13) ? r.point(13) : c;
    const vis = ~r.num(70, 0) & 15;
    if (d[0] === c[0] && d[1] === c[1] && d[2] === c[2]) {
      // triangle: the closing edge is the 4th edge (13 -> 10)
      out.push(facePrim(ctx.m, [a, b, c], (vis & 3) | (((vis >> 3) & 1) << 2), st));
    } else out.push(facePrim(ctx.m, [a, b, c, d], vis, st));
  },

  MESH(_e, r, ctx, st, out) {
    // AcDbSubDMesh: 92 vertex count + 10 vertices, then 93 face-list size + 90 stream [n, i1..in]...
    const gs = r.groups;
    const vi = r.indexOf(92);
    if (vi < 0) return;
    const nv = Number(gs[vi].value);
    const verts: Vec3[] = [];
    let i = vi + 1;
    for (; i < gs.length && verts.length < nv; i++) {
      if (gs[i].code === 10) {
        verts.push([Number(gs[i].value), Number(gs[i + 1]?.value ?? 0), Number(gs[i + 2]?.value ?? 0)]);
        i += 2;
      }
    }
    const fi = r.indexOf(93, i);
    if (fi < 0) return;
    const size = Number(gs[fi].value);
    const stream: number[] = [];
    for (let k = fi + 1; k < gs.length && stream.length < size; k++) if (gs[k].code === 90) stream.push(Number(gs[k].value));
    for (let k = 0; k < stream.length; ) {
      const n = stream[k];
      const idx = stream.slice(k + 1, k + 1 + n);
      k += n + 1;
      if (n < 3 || idx.some((x) => !verts[x])) continue;
      if (n <= 4) out.push(facePrim(ctx.m, idx.map((x) => verts[x]), 15, st));
      else {
        // fan-triangulate larger polygons; only the polygon's own edges are visible
        for (let t = 1; t < n - 1; t++) {
          const e = (t === 1 ? 1 : 0) | 2 | (t === n - 2 ? 4 : 0);
          out.push(facePrim(ctx.m, [verts[idx[0]], verts[idx[t]], verts[idx[t + 1]]], e, st));
        }
      }
    }
  },

  SPLINE: spline,
  HELIX: spline,

  TEXT(env, r, ctx, st, out) {
    out.push(...layoutText(r, env.fonts, planeFrame(ocsMat(ctx, r), r.point(10)[2]), st));
  },
  ATTRIB(env, r, ctx, st, out) {
    if (r.num(70, 0) & 1) return; // invisible attribute
    out.push(...layoutText(r, env.fonts, planeFrame(ocsMat(ctx, r), r.point(10)[2]), st));
  },
  ATTDEF(env, r, ctx, st, out) {
    if (ctx.inBlock) return; // definitions are templates; the ATTRIBs carry values
    out.push(...layoutText(r, env.fonts, planeFrame(ocsMat(ctx, r), r.point(10)[2]), st, r.get(2) ?? ''));
  },

  MTEXT(env, r, ctx, st, out) {
    const ins = r.point(10);
    const n = norm(extrusion(r));
    let xd: Vec3;
    if (r.hasPoint(11)) xd = norm(r.point(11));
    else {
      const [ax, ay] = ocsAxes(n);
      const a = r.num(50, 0) * DEG;
      xd = [ax[0] * Math.cos(a) + ay[0] * Math.sin(a), ax[1] * Math.cos(a) + ay[1] * Math.sin(a), ax[2] * Math.cos(a) + ay[2] * Math.sin(a)];
    }
    const yd = norm(cross(n, xd));
    const o = apply(ctx.m, ins), ux = applyDir(ctx.m, xd), uy = applyDir(ctx.m, yd);
    out.push(...layoutMText(r, env.fonts, { o, u: ux, v: uy }, st));
  },

  INSERT(env, r, ctx, st, out) {
    const blk = env.doc.block(r.str(2));
    const layer = env.styles.effectiveLayer(r, ctx.inh);
    if (blk && ctx.depth < MAX_DEPTH && !ctx.stack.includes(blk.begin.str(2).toUpperCase())) {
      const base = blk.begin.point(10);
      const ins = r.point(10);
      const sx = r.num(41, 1), sy = r.num(42, 1), sz = r.num(43, 1);
      const rot = r.num(50, 0) * DEG;
      const cols = Math.max(1, r.num(70, 1)), rows = Math.max(1, r.num(71, 1));
      const cs = r.num(44, 0), rs = r.num(45, 0);
      const o = ocsMat(ctx, r);
      const inh: Inherit = {
        color: st.color,
        linetype: env.styles.linetypeName(r, ctx.inh),
        lineweight: env.styles.lineweightRaw(r, ctx.inh),
        layer,
        ltScale: ctx.inh.ltScale,
      };
      for (let ci = 0; ci < cols; ci++) {
        for (let ri = 0; ri < rows; ri++) {
          let m = mul(o, translate(ins[0], ins[1], ins[2]));
          m = mul(m, rotateZ(rot));
          if (ci || ri) m = mul(m, translate(ci * cs, ri * rs));
          m = mul(m, scale(sx, sy, sz));
          m = mul(m, translate(-base[0], -base[1], -base[2]));
          const child: Ctx = { m, inh: { ...inh, ltScale: (ctx.inh.ltScale * linearScale(m)) / linearScale(ctx.m) }, depth: ctx.depth + 1, inBlock: true, stack: [...ctx.stack, blk.begin.str(2).toUpperCase()] };
          for (const e of blk.entities) buildEntity(env, e, child, out);
        }
      }
    }
    for (const a of r.children) if (a.type === 'ATTRIB') buildEntity(env, a, ctx, out);
  },

  DIMENSION: blockGraphic,
  ARC_DIMENSION: blockGraphic,
  LARGE_RADIAL_DIMENSION: blockGraphic,

  TOLERANCE(env, r, ctx, st, out) {
    // Feature control frame: text with %%v cell separators, drawn as plain text.
    const h = env.doc.headerNum('$DIMTXT', 0.18) * (env.doc.headerNum('$DIMSCALE', 1) || 1);
    const d = norm(r.point(11, [1, 0, 0]));
    const ins = r.point(10);
    const text = (r.get(1) ?? '').replace(/%%v/gi, ' | ').replace(/\{\\Fgdt;(\w)\}/gi, '$1').replace(/\^J/g, ' ');
    const fake = new DxfRecord('TEXT', [{ code: 1, value: text }, { code: 40, value: String(h) }]);
    const o = apply(ctx.m, ins), ux = applyDir(ctx.m, d), uy = applyDir(ctx.m, [-d[1], d[0], 0]);
    out.push(...layoutText(fake, env.fonts, { o, u: ux, v: uy }, st));
  },

  // Lights have no plotted graphics.
  LIGHT() {},
  ACAD_TABLE(env, r, ctx, st, out) {
    // A table is a block reference to its anonymous *T block.
    const blk = env.doc.block(r.str(2));
    if (!blk) return;
    const ins = r.point(10);
    const d = r.point(11, [1, 0, 0]);
    const m = mul(mul(ctx.m, translate(ins[0], ins[1], ins[2])), rotateZ(Math.atan2(d[1], d[0])));
    const base = blk.begin.point(10);
    drawBlockContents(env, r, blk.entities, mul(m, translate(-base[0], -base[1], -base[2])), ctx, st, out);
  },

  LEADER(env, r, ctx, st, out) {
    const pts = vertices(r, 10);
    push(out, polyPrim(ctx.m, pts, false, st));
    if (r.num(71, 1) && pts.length >= 2) {
      const size = env.doc.headerNum('$DIMASZ', 0.18) * (env.doc.headerNum('$DIMSCALE', 1) || 1);
      arrowHead(out, ctx.m, pts[0], pts[1], size, st);
    }
  },

  MULTILEADER: mleader,
  MLEADER: mleader,

  XLINE(_e, r, ctx, st, out) {
    out.push({ k: 'xline', p: apply(ctx.m, r.point(10)), dir: applyDir(ctx.m, r.point(11, [1, 0, 0])), ray: false, style: st });
  },
  RAY(_e, r, ctx, st, out) {
    out.push({ k: 'xline', p: apply(ctx.m, r.point(10)), dir: applyDir(ctx.m, r.point(11, [1, 0, 0])), ray: true, style: st });
  },

  HATCH(env, r, ctx, st, out) {
    const h = decodeHatch(r);
    if (!h.loops.length) return;
    const m = ocsMat(ctx, r);
    let loops = h.loops;
    if (h.style === 2) {
      const ext = loops.filter((l) => l.flags & 1);
      loops = ext.length ? ext : loops.slice(0, 1);
    }
    const rings = loops.map((l) => {
      const ring: number[] = [];
      for (let i = 0; i < l.pts.length; i += 2) ring.push(...apply(m, [l.pts[i], l.pts[i + 1], h.elevation]));
      return ring;
    });
    if (h.solid) {
      const s = h.gradientColor !== null ? { ...st, color: h.gradientColor } : st;
      if (h.gradient) {
        // gradient direction is in the hatch OCS; rotate it into world
        const dir = applyDir(m, [Math.cos(h.gradient.angle), Math.sin(h.gradient.angle), 0]);
        out.push({ k: 'fill', rings, style: s, gradient: { colors: h.gradient.colors, dir } });
      } else out.push({ k: 'fill', rings, style: s });
      return;
    }
    const lines = h.lines.map((d) => {
      const o = apply(m, [d.base[0], d.base[1], h.elevation]);
      const u = applyDir(m, [Math.cos(d.angle), Math.sin(d.angle), 0]);
      const v = applyDir(m, [d.offset[0], d.offset[1], 0]);
      return { o, u, v, dashes: d.dashes };
    });
    if (!lines.length) {
      out.push({ k: 'fill', rings, style: st, alpha: 0.25 });
      return;
    }
    out.push({ k: 'pattern', rings, lines, style: { ...st, linetype: null } });
  },

  IMAGE: imageFrame,
  WIPEOUT(env, r, ctx, st, out) {
    const m = ctx.m;
    const ins = r.point(10), u = r.point(11), v = r.point(12), size = r.point(13, [1, 1, 0]);
    const raw = vertices(r, 14);
    let bpts = raw;
    if (raw.length === 2) {
      const [a, b] = raw;
      bpts = [a, [b[0], a[1], 0], b, [a[0], b[1], 0]];
    }
    if (bpts.length < 3) return imageFrame(env, r, ctx, st, out);
    const ring: number[] = [];
    for (const p of bpts) {
      const fx = (p[0] + 0.5) * size[0], fy = (0.5 - p[1]) * size[1];
      ring.push(...apply(m, [ins[0] + u[0] * fx + v[0] * fy, ins[1] + u[1] * fx + v[1] * fy, ins[2] + u[2] * fx + v[2] * fy]));
    }
    out.push({ k: 'fill', rings: [ring], style: st, bg: true });
  },

  MLINE(_e, r, ctx, st, out) {
    push(out, polyPrim(ctx.m, vertices(r, 11), (r.num(71, 0) & 2) !== 0, st));
  },

  OLE2FRAME(_e, r, ctx, st, out) {
    const a = r.point(10), b = r.point(11);
    push(out, polyPrim(ctx.m, [a, [b[0], a[1], 0], b, [a[0], b[1], 0]], true, st));
  },

  // Paper-space viewports are not shown in the model view.
  VIEWPORT() {},
};

// ---- builders shared between types -----------------------------------------------
function solid(_e: Env, r: DxfRecord, ctx: Ctx, st: Style, out: Prim3[]) {
  const m = ocsMat(ctx, r);
  const p1 = r.point(10), p2 = r.point(11), p3 = r.point(12), p4 = r.hasPoint(13) ? r.point(13) : p3;
  const ring: number[] = [];
  for (const p of [p1, p2, p4, p3]) ring.push(...apply(m, p));
  out.push({ k: 'fill', rings: [ring], style: st });
}

function spline(_e: Env, r: DxfRecord, ctx: Ctx, st: Style, out: Prim3[]) {
  const ctrl = vertices(r, 10);
  const closed = (r.num(70, 0) & 1) === 1;
  let pts: Vec3[];
  if (ctrl.length) {
    const knots = r.all(40).map(Number);
    const w = r.all(41).map(Number);
    pts = splinePoints(r.num(71, 3), knots, ctrl, w.length === ctrl.length ? w : undefined);
  } else {
    const fit = vertices(r, 11);
    pts = fitPointCurve(closed && fit.length > 2 ? [...fit, fit[0]] : fit);
  }
  push(out, polyPrim(ctx.m, pts, false, st));
}

function blockGraphic(env: Env, r: DxfRecord, ctx: Ctx, st: Style, out: Prim3[]) {
  const blk = env.doc.block(r.str(2));
  if (!blk) {
    env.unsupported.set(r.type + ' (no block)', (env.unsupported.get(r.type + ' (no block)') ?? 0) + 1);
    return;
  }
  // Dimension blocks are defined in WCS at their final location.
  drawBlockContents(env, r, blk.entities, ctx.m, ctx, st, out);
}

function drawBlockContents(env: Env, r: DxfRecord, ents: DxfRecord[], m: Mat, ctx: Ctx, st: Style, out: Prim3[]) {
  const name = r.str(2).toUpperCase();
  if (ctx.depth >= MAX_DEPTH || ctx.stack.includes(name)) return;
  const inh: Inherit = {
    color: st.color,
    linetype: env.styles.linetypeName(r, ctx.inh),
    lineweight: env.styles.lineweightRaw(r, ctx.inh),
    layer: env.styles.effectiveLayer(r, ctx.inh),
    ltScale: ctx.inh.ltScale,
  };
  const child: Ctx = { m, inh, depth: ctx.depth + 1, inBlock: true, stack: [...ctx.stack, name] };
  for (const e of ents) buildEntity(env, e, child, out);
}

function imageFrame(_e: Env, r: DxfRecord, ctx: Ctx, st: Style, out: Prim3[]) {
  const ins = r.point(10), u = r.point(11), v = r.point(12), size = r.point(13, [1, 1, 0]);
  const U: Vec3 = [u[0] * size[0], u[1] * size[0], u[2] * size[0]];
  const V: Vec3 = [v[0] * size[1], v[1] * size[1], v[2] * size[1]];
  const p = (a: number, b: number): Vec3 => [ins[0] + U[0] * a + V[0] * b, ins[1] + U[1] * a + V[1] * b, ins[2] + U[2] * a + V[2] * b];
  push(out, polyPrim(ctx.m, [p(0, 0), p(1, 0), p(1, 1), p(0, 1)], true, st));
  push(out, polyPrim(ctx.m, [p(0, 0), p(1, 1)], false, st));
  push(out, polyPrim(ctx.m, [p(1, 0), p(0, 1)], false, st));
}

/** All points of a repeated point code, in order. */
export function vertices(r: DxfRecord, code: number): Vec3[] {
  const out: Vec3[] = [];
  const gs = r.groups;
  for (let i = 0; i < gs.length; i++) {
    if (gs[i].code !== code) continue;
    const x = Number(gs[i].value);
    const y = gs[i + 1]?.code === code + 10 ? Number(gs[i + 1].value) : 0;
    const z = gs[i + 2]?.code === code + 20 ? Number(gs[i + 2].value) : 0;
    out.push([x, y, z]);
  }
  return out;
}

function arrowHead(out: Prim3[], m: Mat, tip: Vec3, from: Vec3, size: number, st: Style) {
  const t = apply(m, tip), f = apply(m, from);
  const d: Vec3 = [f[0] - t[0], f[1] - t[1], f[2] - t[2]];
  const l = Math.hypot(...d);
  if (l < 1e-12 || size <= 0) return;
  const s = size * linearScale(m);
  const u: Vec3 = [d[0] / l, d[1] / l, d[2] / l];
  const n = norm(applyDir(m, [0, 0, 1]));
  const w = cross(n, u);
  const b: Vec3 = [t[0] + u[0] * s, t[1] + u[1] * s, t[2] + u[2] * s];
  const k = s / 6;
  out.push({ k: 'fill', rings: [[...t, b[0] + w[0] * k, b[1] + w[1] * k, b[2] + w[2] * k, b[0] - w[0] * k, b[1] - w[1] * k, b[2] - w[2] * k]], style: st });
}

function mleader(env: Env, r: DxfRecord, ctx: Ctx, st: Style, out: Prim3[]) {
  const gs = r.groups;
  const ctxStart = gs.findIndex((g) => g.code === 300 && g.value.includes('CONTEXT_DATA{'));
  if (ctxStart < 0) return;
  const textHeight = Number(gs[gs.findIndex((g, i) => i > ctxStart && g.code === 41)]?.value ?? 2.5) || 2.5;
  const arrowSize = Number(gs[gs.findIndex((g, i) => i > ctxStart && g.code === 140)]?.value ?? 2.5) || 2.5;
  let i = ctxStart;
  let text = '';
  let textLoc: Vec3 | null = null;
  let textDir: Vec3 = [1, 0, 0];
  let attach = 1;
  let width = 0;
  let inLeader = 0;
  let inLine = false;
  let lastPt: Vec3 | null = null;
  let dogleg: Vec3 = [1, 0, 0];
  let doglegLen = 0;
  let line: Vec3[] = [];
  const leaders: { pts: Vec3[]; arrow: boolean }[] = [];
  const read = (k: number): Vec3 => [Number(gs[k].value), Number(gs[k + 1]?.value ?? 0), Number(gs[k + 2]?.value ?? 0)];
  for (i = ctxStart + 1; i < gs.length; i++) {
    const g = gs[i];
    if (g.code === 301) break;
    if (g.code === 302) { inLeader++; lastPt = null; doglegLen = 0; continue; }
    if (g.code === 303) {
      inLeader--;
      if (lastPt && doglegLen > 0) {
        leaders.push({ pts: [lastPt, [lastPt[0] + dogleg[0] * doglegLen, lastPt[1] + dogleg[1] * doglegLen, lastPt[2]]], arrow: false });
      }
      continue;
    }
    if (g.code === 304 && g.value.includes('LEADER_LINE{')) { inLine = true; line = []; continue; }
    if (g.code === 305) {
      inLine = false;
      if (lastPt) line.push(lastPt);
      leaders.push({ pts: line, arrow: true });
      continue;
    }
    if (inLine && g.code === 10) { line.push(read(i)); continue; }
    if (inLeader && !inLine) {
      if (g.code === 10) lastPt = read(i);
      else if (g.code === 11) dogleg = read(i);
      else if (g.code === 40) doglegLen = Number(g.value);
      continue;
    }
    if (!inLeader) {
      if (g.code === 304 && !text) text = g.value;
      else if (g.code === 12) textLoc = read(i);
      else if (g.code === 13) textDir = read(i);
      else if (g.code === 171) attach = Number(g.value) || 1;
      else if (g.code === 43) width = Number(g.value);
    }
  }
  for (const l of leaders) {
    push(out, polyPrim(ctx.m, l.pts, false, st));
    if (l.arrow && l.pts.length >= 2) arrowHead(out, ctx.m, l.pts[0], l.pts[1], arrowSize, st);
  }
  if (text && textLoc) {
    const fake = new DxfRecord('MTEXT', [
      { code: 1, value: text },
      { code: 40, value: String(textHeight) },
      { code: 41, value: String(width) },
      { code: 71, value: String(attach) },
    ]);
    const xd = norm(textDir);
    const o = apply(ctx.m, textLoc), ux = applyDir(ctx.m, xd), uy = applyDir(ctx.m, [-xd[1], xd[0], 0]);
    out.push(...layoutMText(fake, env.fonts, { o, u: ux, v: uy }, st));
  }
}

// ---- polylines -------------------------------------------------------------------
interface PV {
  p: Vec3;
  sw: number;
  ew: number;
  b: number;
}

function emitPolyline(m: Mat, verts: PV[], closed: boolean, st: Style, out: Prim3[]) {
  if (!verts.length) return;
  const s = linearScale(m);
  const n = verts.length;
  const segs = closed ? n : n - 1;
  const widths = verts.slice(0, Math.max(segs, 1)).flatMap((v) => [v.sw, v.ew]);
  const uniform = widths.every((w) => Math.abs(w - widths[0]) < 1e-12);

  if (uniform) {
    const pts: Vec3[] = [verts[0].p];
    for (let i = 0; i < segs; i++) {
      const a = verts[i], b = verts[(i + 1) % n];
      pts.push(...bulgePoints(a.p, b.p, a.b));
    }
    if (closed) pts.pop();
    push(out, polyPrim(m, pts, closed && n > 1, st, widths[0] > 0 ? widths[0] * s : undefined));
    if (n === 1) out.push({ k: 'point', p: apply(m, verts[0].p), style: st });
    return;
  }
  // Varying widths: one filled outline per segment.
  for (let i = 0; i < segs; i++) {
    const a = verts[i], b = verts[(i + 1) % n];
    const pts = [a.p, ...bulgePoints(a.p, b.p, a.b)];
    if (a.sw === 0 && a.ew === 0) {
      push(out, polyPrim(m, pts, false, st));
      continue;
    }
    const left: number[] = [], right: number[] = [];
    for (let k = 0; k < pts.length; k++) {
      const t = k / (pts.length - 1);
      const w = (a.sw + (a.ew - a.sw) * t) / 2;
      const p = pts[k];
      const q = pts[Math.min(k + 1, pts.length - 1)], o = pts[Math.max(k - 1, 0)];
      let dx = q[0] - o[0], dy = q[1] - o[1];
      const l = Math.hypot(dx, dy) || 1;
      dx /= l;
      dy /= l;
      const L = apply(m, [p[0] - dy * w, p[1] + dx * w, p[2]]);
      const R = apply(m, [p[0] + dy * w, p[1] - dx * w, p[2]]);
      left.push(L[0], L[1], L[2]);
      right.unshift(R[0], R[1], R[2]); // prepends the triple, keeping x,y,z order
    }
    out.push({ k: 'fill', rings: [[...left, ...right]], style: st });
  }
}

function meshPolyline(r: DxfRecord, verts: DxfRecord[], ctx: Ctx, st: Style, out: Prim3[]) {
  const M = r.num(71, 0), N = r.num(72, 0);
  const flags = r.num(70, 0);
  const pts = verts.map((v) => v.point(10));
  if (M * N > pts.length || M < 2 || N < 2) {
    push(out, polyPrim(ctx.m, pts, false, st));
    return;
  }
  const closeM = (flags & 1) !== 0, closeN = (flags & 32) !== 0;
  for (let i = 0; i < (closeM ? M : M - 1); i++) {
    for (let j = 0; j < (closeN ? N : N - 1); j++) {
      const i2 = (i + 1) % M, j2 = (j + 1) % N;
      out.push(facePrim(ctx.m, [pts[i * N + j], pts[i * N + j2], pts[i2 * N + j2], pts[i2 * N + j]], 15, st));
    }
  }
}

function polyfacePolyline(_env: Env, verts: DxfRecord[], ctx: Ctx, st: Style, out: Prim3[]) {
  const loc: Vec3[] = [];
  const faces: number[][] = [];
  for (const v of verts) {
    const f = v.num(70, 0);
    if (f & 64) loc.push(v.point(10));
    else if (f & 128) faces.push([v.num(71, 0), v.num(72, 0), v.num(73, 0), v.num(74, 0)].filter((x) => x !== 0));
  }
  for (const face of faces) {
    const pts = face.map((i) => loc[Math.abs(i) - 1]);
    if (pts.length < 3 || pts.some((p) => !p)) continue;
    // a negative index hides the edge that starts at that vertex
    let edges = 0;
    face.forEach((i, k) => {
      if (i > 0) edges |= 1 << k;
    });
    out.push(facePrim(ctx.m, pts, edges, st));
  }
}
