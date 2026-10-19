import { type Group, group } from '../dxf/groups';
import { DxfRecord, type Vec3 } from '../dxf/record';
import type { DxfDocument } from '../model/database';
import { apply, isDefaultExtrusion, norm, ocsToWcs, wcsToOcs } from '../geom/ocs';
import { decodeTextCodes, measure, SHX_FALLBACK } from '../render/text';
import type { DimStyle } from './style';
import { dimLabel } from './format';
import { arrowParts, isTick, type Pt } from './arrows';

type P = [number, number];

/** DIMENSION type (group 70 & 7). */
export const DIM_TYPE = { rotated: 0, aligned: 1, angular2: 2, diameter: 3, radius: 4, angular3: 5, ordinate: 6 } as const;

export interface DimGeometry {
  /** Graphics for the anonymous block (no handles/owners yet), in WCS/OCS. */
  entities: DxfRecord[];
  /** Value for group 42: length, or angle in radians. */
  measurement: number;
  /** Text midpoint (group 11, OCS). */
  textMid: Vec3;
  /** Final label as written in the block. */
  label: string;
  /** Normalised definition point 10 (WCS) where the type defines one on the dimension line. */
  def10?: Vec3;
  /**
   * Size of what is measured, for dynamic label height: the length, radius or diameter,
   * the dimension arc's length for angles, or the leader length for ordinates.
   */
  size: number;
}

// ---- small 2D helpers (all in the dimension's OCS plane) ---------------------------------------
const add = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1]];
const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]];
const mul = (a: P, k: number): P => [a[0] * k, a[1] * k];
const dot = (a: P, b: P) => a[0] * b[0] + a[1] * b[1];
const len = (a: P) => Math.hypot(a[0], a[1]);
const unit = (a: P): P => {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l] : [1, 0];
};
const perp = (a: P): P => [-a[1], a[0]];
const dirOf = (ang: number): P => [Math.cos(ang), Math.sin(ang)];
const TAU = Math.PI * 2;
const normAng = (a: number) => ((a % TAU) + TAU) % TAU;
/** Keep text upright: angle in (-90°, 90°]. */
function readable(a: number): number {
  a = normAng(a);
  if (a > Math.PI / 2 + 1e-9 && a <= (3 * Math.PI) / 2 + 1e-9) a -= Math.PI;
  return a;
}

/** Colour / linetype / lineweight of one part of a dimension (dimension line, ext line, text). */
interface Part {
  color: number; // ACI, 0 = ByBlock, 256 = ByLayer
  ltype: string; // '' = ByBlock
  lw: number; // 1/100 mm, -2 = ByBlock
}

/** Output helpers bound to one dimension: plane conversion and version-aware entity records. */
class Out {
  readonly ents: DxfRecord[] = [];
  private o2w;
  private extr: Group[];
  constructor(private doc: DxfDocument, readonly n: Vec3, readonly elev: number, private st: DimStyle) {
    this.o2w = ocsToWcs(n);
    this.extr = isDefaultExtrusion(n) ? [] : [group(210, n[0]), group(220, n[1]), group(230, n[2])];
  }
  wcs(p: P): Vec3 {
    return apply(this.o2w, [p[0], p[1], this.elev]);
  }
  private rec(type: string, sub: string | null, body: Group[], part: Part | null, layer = '0'): DxfRecord {
    const gs: Group[] = [];
    if (this.doc.isModern) gs.push(group(100, 'AcDbEntity'));
    gs.push(group(8, layer));
    if (part) {
      if (part.ltype) gs.push(group(6, part.ltype));
      gs.push(group(62, part.color));
      if (this.doc.isModern && part.lw !== -2) gs.push(group(370, part.lw));
    }
    if (this.doc.isModern && sub) gs.push(group(100, sub));
    gs.push(...body);
    const r = new DxfRecord(type, gs);
    this.ents.push(r);
    return r;
  }
  private pt(code: number, p: Vec3): Group[] {
    return [group(code, p[0]), group(code + 10, p[1]), group(code + 20, p[2])];
  }
  line(a: P, b: P, part: Part) {
    if (len(sub(a, b)) < 1e-12) return;
    this.rec('LINE', 'AcDbLine', [...this.pt(10, this.wcs(a)), ...this.pt(11, this.wcs(b))], part);
  }
  /** Filled triangle or quad (SOLID corner order 1, 2, 4, 3). */
  solid(pts: P[], part: Part) {
    const z = this.elev;
    const [a, b, c, d = c] = pts;
    this.rec('SOLID', 'AcDbTrace', [
      ...this.pt(10, [a[0], a[1], z]), ...this.pt(11, [b[0], b[1], z]),
      ...this.pt(12, [d[0], d[1], z]), ...this.pt(13, [c[0], c[1], z]), ...this.extr,
    ], part);
  }
  circle(c: P, r: number, part: Part) {
    this.rec('CIRCLE', 'AcDbCircle', [...this.pt(10, [c[0], c[1], this.elev]), group(40, r), ...this.extr], part);
  }
  arc(c: P, r: number, a0: number, a1: number, part: Part) {
    const deg = (a: number) => (normAng(a) * 180) / Math.PI;
    const rec = this.rec('ARC', 'AcDbCircle', [...this.pt(10, [c[0], c[1], this.elev]), group(40, r), ...this.extr], part);
    if (this.doc.isModern) rec.groups.push(group(100, 'AcDbArc'));
    rec.groups.push(group(50, deg(a0)), group(51, deg(a1)));
  }
  /** An arrowhead by block name, tip at `tip`, body toward `toward`, `size` long. */
  arrow(tip: P, toward: P, name: string, size: number, part: Part) {
    if (size <= 0) return;
    const ux = unit(toward), uy = perp(ux);
    const tr = (p: Pt): P => add(tip, add(mul(ux, p[0] * size), mul(uy, p[1] * size)));
    for (const a of arrowParts(name)) {
      if (a.k === 'line') this.line(tr(a.a), tr(a.b), part);
      else if (a.k === 'solid') this.solid(a.pts.map(tr), part);
      else if (a.k === 'circle') this.circle(tr(a.c), a.r * size, part);
      else if (a.k === 'disk') {
        // filled circle as a fan of SOLIDs (works in every DXF version)
        const c = tr(a.c), r = a.r * size, n = 16;
        for (let i = 0; i < n; i++) {
          const t0 = (i / n) * TAU, t1 = ((i + 1) / n) * TAU;
          this.solid([c, add(c, mul(dirOf(t0), r)), add(c, mul(dirOf(t1), r))], part);
        }
      } else if (a.k === 'thick') {
        const A = tr(a.a), B = tr(a.b), d = unit(sub(B, A)), w = mul(perp(d), (a.w * size) / 2);
        this.solid([add(A, w), add(B, w), sub(B, w), sub(A, w)], part);
      }
    }
  }
  /** Label centred at `pos`, baseline along `ang` (OCS radians), with optional frame and background. */
  text(pos: P, ang: number, s: string, part: Part, opts: { frame?: boolean; fill?: number; fillColor?: number } = {}) {
    const h = this.st.txt;
    if (!s) return;
    if (this.doc.isModern) {
      const ins = this.wcs(pos);
      const x = apply(this.o2w, [Math.cos(ang), Math.sin(ang), 0]);
      const body: Group[] = [
        ...this.pt(10, ins), group(40, h), group(71, 5), group(72, 1), group(1, s), group(7, this.st.textStyle),
        ...this.extr, ...this.pt(11, x),
      ];
      // background mask (DIMTFILL): 90 = 1 colour (63) / 3 drawing background; 45 = border scale
      if (opts.fill && this.doc.version >= 'AC1018') body.push(group(90, opts.fill === 2 ? 1 : 3), group(63, opts.fillColor ?? 7), group(45, 1.5));
      this.rec('MTEXT', 'AcDbMText', body, part);
    } else {
      const p: Vec3 = [pos[0], pos[1], this.elev];
      this.rec('TEXT', 'AcDbText', [
        ...this.pt(10, p), group(40, h), group(1, s.replace(/\\S([^;^#/]*)[/^#]([^;]*);/g, '$1/$2').replace(/\\X|\\P/g, ' ').replace(/\{\\[HA][^;]*;|\}/g, '')),
        group(50, (normAng(ang) * 180) / Math.PI), group(7, this.st.textStyle),
        group(72, 1), ...this.pt(11, p), ...this.extr, group(73, 2),
      ], part);
    }
    if (opts.frame) {
      // basic dimension: a box around the text (DIMGAP < 0)
      const g = this.st.gap, w = this.width(s) / 2 + g, hh = this.lines(s) * h * 0.85 + g;
      const ux = dirOf(ang), uy = perp(ux);
      const c = (sx: number, sy: number): P => add(pos, add(mul(ux, sx * w), mul(uy, sy * hh)));
      const box = [c(-1, -1), c(1, -1), c(1, 1), c(-1, 1)];
      box.forEach((p, i) => this.line(p, box[(i + 1) % 4], part));
    }
  }
  defpoint(p: Vec3) {
    this.rec('POINT', 'AcDbPoint', this.pt(10, p), null, 'Defpoints');
  }
  /** Approximate label width (drawing units) for layout decisions. */
  width(s: string): number {
    const plain = s.replace(/\{\\[HA][^;]*;/g, '').replace(/\}/g, '').replace(/\\S([^;^#/]*)[/^#]([^;]*);/g, (_, a, b) => (a.length > b.length ? a : b));
    const widest = plain.split(/\\X|\\P/).reduce((m, l) => Math.max(m, measure(decodeTextCodes(l), SHX_FALLBACK)), 0);
    return widest * this.st.txt;
  }
  lines(s: string): number {
    return s.split(/\\X|\\P/).length;
  }
}

/**
 * Regenerate a dimension's graphics from its definition points, like AutoCAD does after
 * creation or an edit. Returns null for types we can't build (they keep their old block).
 */
export function buildDimension(doc: DxfDocument, rec: DxfRecord, st: DimStyle): DimGeometry | null {
  const n = norm(rec.point(210, [0, 0, 1]));
  const w2o = wcsToOcs(n);
  // WCS definition points -> OCS 2D; OCS ones (11, 12, 16) are already in-plane
  const w = (code: number): P => {
    const q = apply(w2o, rec.point(code));
    return [q[0], q[1]];
  };
  const o = (code: number): P => {
    const q = rec.point(code);
    return [q[0], q[1]];
  };
  const elev = apply(w2o, rec.point(10))[2];
  const out = new Out(doc, n, elev, st);
  const type = rec.num(70, 0) & 7;
  const userText = (rec.num(70, 0) & 128) !== 0 && rec.hasPoint(11);
  const override = rec.has(1) ? rec.get(1) : undefined;
  const V = st.v;
  const num = (k: string) => Number(V[k]) || 0;
  const g = st.gap, h = st.txt, sc = st.scale;
  const hd = (-rec.num(51, 0) * Math.PI) / 180; // "horizontal" = UCS X in the OCS
  const dimPart: Part = { color: num('DIMCLRD'), ltype: String(V.DIMLTYPE || ''), lw: Number(V.DIMLWD ?? -2) };
  const extPart = (i: 1 | 2): Part => ({ color: num('DIMCLRE'), ltype: String((i === 1 ? V.DIMLTEX1 : V.DIMLTEX2) || ''), lw: Number(V.DIMLWE ?? -2) });
  const txtPart: Part = { color: num('DIMCLRT'), ltype: '', lw: -2 };
  const textOpts = { frame: Number(V.DIMGAP) < 0, fill: num('DIMTFILL'), fillColor: num('DIMTFILLCLR') || 7 };
  const sah = num('DIMSAH') !== 0;
  const arrow1 = String((sah ? V.DIMBLK1 : V.DIMBLK) ?? '');
  const arrow2 = String((sah ? V.DIMBLK2 : V.DIMBLK) ?? '');
  const tsz = num('DIMTSZ') * sc; // > 0: oblique ticks instead of arrows
  const dle = num('DIMDLE') * sc;
  /** Space an arrow needs on the dimension line. */
  const arrowSpace = (name: string) => (tsz > 0 ? 0 : isTick(name) ? st.asz / 2 : st.asz);
  const drawArrow = (tip: P, toward: P, name: string) => {
    if (tsz > 0) out.arrow(tip, toward, '_OBLIQUE', tsz, dimPart);
    else out.arrow(tip, toward, name, st.asz, dimPart);
  };
  /** Text angle for the inside/outside alignment settings (DIMTIH / DIMTOH; ISO = both off). */
  const textAngle = (along: number, inside: boolean) => (num(inside ? 'DIMTIH' : 'DIMTOH') ? hd : readable(along));

  let measurement = 0;
  let label = '';
  let textPos: P = [0, 0];
  let def10: Vec3 | undefined;
  let size = 0;

  switch (type) {
    case DIM_TYPE.rotated:
    case DIM_TYPE.aligned: {
      const p13 = w(13), p14 = w(14), p10 = w(10);
      const theta = type === DIM_TYPE.rotated ? (rec.num(50, 0) * Math.PI) / 180 : Math.atan2(p14[1] - p13[1], p14[0] - p13[0]);
      const u = dirOf(theta);
      const d1 = add(p10, mul(u, dot(sub(p13, p10), u)));
      const d2 = add(p10, mul(u, dot(sub(p14, p10), u)));
      measurement = Math.abs(dot(sub(p14, p13), u));
      size = measurement;
      label = dimLabel(measurement, 'linear', st, override);
      def10 = out.wcs(d2); // 10 sits where the dimension line meets the 2nd extension line

      // extension lines (DIMSE1/2 suppress, DIMEXO offset, DIMEXE overshoot, DIMFXLON fixed length)
      const fixed = num('DIMFXLON') ? num('DIMFXL') * sc : 0;
      ([[p13, d1, 1], [p14, d2, 2]] as [P, P, 1 | 2][]).forEach(([p, d, i]) => {
        if (num(i === 1 ? 'DIMSE1' : 'DIMSE2')) return;
        const v = sub(d, p);
        const l = len(v);
        if (l < 1e-9) return;
        const e = mul(v, 1 / l);
        const start = fixed > 0 ? sub(d, mul(e, Math.min(fixed, l - st.exo))) : add(p, mul(e, st.exo));
        if (dot(sub(d, start), e) > 0) out.line(start, add(d, mul(e, st.exe)), extPart(i));
      });

      const D = len(sub(d2, d1));
      const along = D > 1e-12 ? unit(sub(d2, d1)) : u;
      const tw = out.width(label);
      const centred = st.tad === 0;
      const textNeed = tw + 2 * g;
      const arrowsNeed = arrowSpace(arrow1) + arrowSpace(arrow2);
      const fitsBoth = centred ? D >= arrowsNeed + textNeed : D >= arrowsNeed && D >= textNeed;
      // DIMATFIT: 0 move both, 1 move arrows first, 2 move text first, 3 best fit; DIMTIX keeps text inside
      let arrowsIn = fitsBoth, textIn = fitsBoth;
      if (!fitsBoth) {
        const fit = num('DIMATFIT');
        if ((fit === 1 || fit === 3) && D >= textNeed) [arrowsIn, textIn] = [false, true];
        else if ((fit === 2 || fit === 3) && D >= arrowsNeed) [arrowsIn, textIn] = [true, false];
        else [arrowsIn, textIn] = [false, false];
      }
      if (num('DIMTIX')) textIn = true;
      const showArrowsOut = !arrowsIn && !num('DIMSOXD');

      // text position: DIMJUST along the line, DIMTAD across it
      const ang0 = Math.atan2(along[1], along[0]);
      const up = perp(dirOf(readable(ang0)));
      const outsideSign = Math.sign(dot(up, sub(d1, p13))) || 1; // DIMTAD 2: away from the origins
      const vOff = (tadIn: number) =>
        tadIn === 0 ? 0 : tadIn === 4 ? -(g + h / 2) : tadIn === 2 ? outsideSign * (g + h / 2) : g + h / 2;
      const just = num('DIMJUST');
      let ang = textAngle(ang0, true);
      let lineBreak = false;
      if (userText) {
        textPos = o(11);
      } else if (textIn) {
        if (just === 3 || just === 4) {
          // over an extension line: text runs along it, beyond the dimension line
          const [p, d] = just === 3 ? [p13, d1] : [p14, d2];
          const e = unit(sub(d, p));
          textPos = add(d, mul(e, st.exe + g + tw / 2));
          ang = readable(Math.atan2(e[1], e[0]));
        } else {
          const base = just === 1 ? add(d1, mul(along, arrowSpace(arrow1) + g + tw / 2))
            : just === 2 ? sub(d2, mul(along, arrowSpace(arrow2) + g + tw / 2)) : mul(add(d1, d2), 0.5);
          textPos = add(base, mul(up, vOff(st.tad)));
          lineBreak = centred && num('DIMTIH') === 0;
        }
      } else {
        const tmove = num('DIMTMOVE');
        ang = textAngle(ang0, false);
        if (tmove === 0) {
          // beside the dimension line, past the 2nd extension line; the line extends to the text
          const offOut = arrowsIn ? 0 : arrowSpace(arrow2) * 2;
          textPos = add(add(d2, mul(along, offOut + g + tw / 2)), mul(up, vOff(st.tad)));
          out.line(d2, add(d2, mul(along, offOut + (centred ? 0 : tw + 2 * g))), dimPart);
        } else {
          // over the dimension line, with (1) or without (2) a leader
          const mid = mul(add(d1, d2), 0.5);
          textPos = add(add(mid, mul(up, g + h * 1.5 + st.asz)), mul(along, tw / 2 + st.asz));
          if (tmove === 1) {
            const elbow = sub(textPos, mul(along, tw / 2 + g));
            out.line(mid, elbow, dimPart);
          }
        }
      }

      // dimension line (DIMSD1/2 suppress halves; DIMDLE extends ticks; break around centred text)
      const mid = mul(add(d1, d2), 0.5);
      const ext = tsz > 0 || isTick(arrow1) || isTick(arrow2) ? dle : 0;
      const e1 = sub(d1, mul(along, ext)), e2 = add(d2, mul(along, ext));
      const sd1 = num('DIMSD1') !== 0, sd2 = num('DIMSD2') !== 0;
      const drawInside = arrowsIn || num('DIMTOFL');
      if (drawInside) {
        if (lineBreak && textIn) {
          const gapHalf = tw / 2 + g;
          const t = dot(sub(textPos, d1), along);
          if (!sd1) out.line(e1, add(d1, mul(along, Math.max(0, t - gapHalf))), dimPart);
          if (!sd2) out.line(add(d1, mul(along, Math.min(D, t + gapHalf))), e2, dimPart);
        } else {
          if (!sd1) out.line(e1, mid, dimPart);
          if (!sd2) out.line(mid, e2, dimPart);
        }
      }
      if (arrowsIn) {
        if (!sd1) drawArrow(d1, along, arrow1);
        if (!sd2) drawArrow(d2, mul(along, -1), arrow2);
      } else if (showArrowsOut) {
        const stub = Math.max(st.asz * 2, arrowSpace(arrow1) + st.asz);
        if (!sd1) {
          drawArrow(d1, mul(along, -1), arrow1);
          out.line(sub(d1, mul(along, stub)), d1, dimPart);
        }
        if (!sd2) {
          drawArrow(d2, along, arrow2);
          out.line(d2, add(d2, mul(along, stub)), dimPart);
        }
      }
      out.text(textPos, ang, label, txtPart, textOpts);
      out.defpoint(rec.point(13));
      out.defpoint(rec.point(14));
      out.defpoint(def10);
      break;
    }

    case DIM_TYPE.radius:
    case DIM_TYPE.diameter: {
      const radius = type === DIM_TYPE.radius;
      const q = w(15);
      const c = radius ? w(10) : mul(add(w(10), q), 0.5);
      const r = len(sub(q, c));
      measurement = radius ? r : 2 * r;
      size = measurement;
      label = dimLabel(measurement, 'linear', st, override, radius ? 'R' : '%%c');
      const tw = out.width(label);
      const dir = unit(sub(q, c));
      const pos = userText ? o(11) : add(q, mul(dir, 2 * st.asz + tw / 2 + g));
      const outside = len(sub(pos, c)) > r + 1e-9;
      // center mark / center lines (DIMCEN), drawn when the dimension sits outside the curve
      const cen = num('DIMCEN') * sc;
      if (cen && outside) {
        const m = Math.abs(cen);
        for (const d of [[1, 0], [0, 1]] as P[]) out.line(sub(c, mul(d, m)), add(c, mul(d, m)), dimPart);
        if (cen < 0) {
          for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]] as P[]) out.line(add(c, mul(d, 2 * m)), add(c, mul(d, r + m)), dimPart);
        }
      }
      if (radius) {
        if (outside) {
          // arrow on the curve pointing in, leader out to a horizontal landing beside the text
          const side = pos[0] >= q[0] ? 1 : -1;
          const landing: P = [pos[0] - side * (tw / 2 + g), pos[1]];
          drawArrow(q, unit(sub(landing, q)), arrow2);
          out.line(q, landing, dimPart);
          textPos = pos;
          out.text(textPos, num('DIMTOH') ? hd : 0, label, txtPart, textOpts);
        } else {
          out.line(c, q, dimPart);
          drawArrow(q, mul(dir, -1), arrow2);
          const ang = textAngle(Math.atan2(dir[1], dir[0]), true);
          textPos = userText ? pos : add(mul(add(c, q), 0.5), mul(perp(dirOf(readable(Math.atan2(dir[1], dir[0])))), g + h / 2));
          out.text(textPos, ang, label, txtPart, textOpts);
        }
      } else {
        const q2 = sub(mul(c, 2), q);
        out.line(q2, q, dimPart);
        drawArrow(q, mul(dir, -1), arrow2);
        drawArrow(q2, dir, arrow1);
        if (outside) {
          const near = len(sub(pos, q)) < len(sub(pos, q2)) ? q : q2;
          const side = pos[0] >= near[0] ? 1 : -1;
          const landing: P = [pos[0] - side * (tw / 2 + g), pos[1]];
          out.line(near, landing, dimPart);
          textPos = pos;
          out.text(textPos, num('DIMTOH') ? hd : 0, label, txtPart, textOpts);
        } else {
          const ang = textAngle(Math.atan2(dir[1], dir[0]), true);
          textPos = userText ? pos : add(c, mul(perp(dirOf(readable(Math.atan2(dir[1], dir[0])))), g + h / 2));
          out.text(textPos, ang, label, txtPart, textOpts);
        }
      }
      out.defpoint(rec.point(15));
      out.defpoint(rec.point(10));
      break;
    }

    case DIM_TYPE.angular3:
    case DIM_TYPE.angular2: {
      let v: P, a: P, b: P, loc: P;
      if (type === DIM_TYPE.angular3) {
        v = w(15); a = w(13); b = w(14); loc = w(10);
      } else {
        // two lines: 13-14 and 15-10, arc through 16; vertex = their intersection
        const l1a = w(13), l1b = w(14), l2a = w(15), l2b = w(10);
        loc = o(16);
        const d1 = sub(l1b, l1a), d2 = sub(l2b, l2a);
        const den = d1[0] * d2[1] - d1[1] * d2[0];
        if (Math.abs(den) < 1e-12) return null; // parallel lines
        const t = ((l2a[0] - l1a[0]) * d2[1] - (l2a[1] - l1a[1]) * d2[0]) / den;
        v = add(l1a, mul(d1, t));
        // rays toward each line's far end; flip so the arc location lies between them (< 180°)
        const far = (p1: P, p2: P) => (len(sub(p1, v)) > len(sub(p2, v)) ? p1 : p2);
        let r1 = unit(sub(far(l1a, l1b), v)), r2 = unit(sub(far(l2a, l2b), v));
        const al = Math.atan2(loc[1] - v[1], loc[0] - v[0]);
        let found = false;
        for (const s1 of [1, -1]) {
          for (const s2 of [1, -1]) {
            const x1 = mul(r1, s1), x2 = mul(r2, s2);
            const a1 = Math.atan2(x1[1], x1[0]), sweep = normAng(Math.atan2(x2[1], x2[0]) - a1);
            if (sweep < Math.PI && normAng(al - a1) <= sweep) {
              r1 = x1;
              r2 = x2;
              found = true;
              break;
            }
          }
          if (found) break;
        }
        a = add(v, mul(r1, Math.max(len(sub(far(l1a, l1b), v)), 1e-9)));
        b = add(v, mul(r2, Math.max(len(sub(far(l2a, l2b), v)), 1e-9)));
      }
      const r = len(sub(loc, v));
      const a1 = Math.atan2(a[1] - v[1], a[0] - v[0]), a2 = Math.atan2(b[1] - v[1], b[0] - v[0]);
      const al = Math.atan2(loc[1] - v[1], loc[0] - v[0]);
      let start = a1, sweep = normAng(a2 - a1);
      if (normAng(al - a1) > sweep) {
        start = a2;
        sweep = TAU - sweep;
      }
      measurement = sweep;
      size = r * sweep; // arc length of the dimension arc
      label = dimLabel(sweep, 'angular', st, override);
      const end = start + sweep;
      // extension lines from just past each defining point out beyond the arc
      ([[a, start, 1], [b, end, 2]] as [P, number, 1 | 2][]).forEach(([p, ang, i]) => {
        if (num(i === 1 ? 'DIMSE1' : 'DIMSE2')) return;
        const dp = len(sub(p, v));
        const e = dirOf(ang);
        if (dp + st.exo < r) out.line(add(v, mul(e, dp + st.exo)), add(v, mul(e, r + st.exe)), extPart(i));
      });
      out.arc(v, r, start, end, dimPart);
      const ps = add(v, mul(dirOf(start), r)), pe = add(v, mul(dirOf(end), r));
      drawArrow(ps, perp(dirOf(start)), arrow1);
      drawArrow(pe, mul(perp(dirOf(end)), -1), arrow2);
      const m = start + sweep / 2;
      const ang = textAngle(m - Math.PI / 2, true);
      textPos = userText ? o(11) : add(v, mul(dirOf(m), r + g + h / 2));
      out.text(textPos, ang, label, txtPart, textOpts);
      out.defpoint(rec.point(10));
      break;
    }

    case DIM_TYPE.ordinate: {
      const origin = w(10), f = w(13), end = w(14);
      const ax = dirOf(hd), ay = perp(ax);
      const xType = (rec.num(70, 0) & 64) !== 0;
      const measAxis = xType ? ax : ay; // which coordinate is reported
      const lead = xType ? ay : ax; // the leader runs across it
      const value = dot(sub(f, origin), measAxis);
      measurement = Math.abs(value);
      size = len(sub(end, f)); // leader length
      label = dimLabel(measurement, 'linear', st, override);
      const along = dot(sub(end, f), lead);
      const s = along >= 0 ? 1 : -1;
      const L = Math.abs(along);
      const offset = dot(sub(end, f), measAxis); // sideways shift -> dog-leg
      const start = add(f, mul(lead, s * st.exo));
      const leaderPart = extPart(1);
      if (Math.abs(offset) < 1e-9 || L < 4 * st.asz) out.line(start, end, leaderPart);
      else {
        const k1 = add(f, mul(lead, s * Math.max(st.exo, L - 4 * st.asz)));
        const k2 = add(add(k1, mul(measAxis, offset)), mul(lead, s * 2 * st.asz));
        out.line(start, k1, leaderPart);
        out.line(k1, k2, leaderPart);
        out.line(k2, end, leaderPart);
      }
      const tw = out.width(label);
      const ang = num('DIMTOH') ? hd : readable(Math.atan2(lead[1] * s, lead[0] * s));
      textPos = userText ? o(11) : add(end, mul(lead, s * (g + tw / 2)));
      out.text(textPos, ang, label, txtPart, textOpts);
      out.defpoint(rec.point(13));
      out.defpoint(rec.point(14));
      break;
    }

    default:
      return null;
  }
  return { entities: out.ents, measurement, textMid: [textPos[0], textPos[1], elev], label, def10, size };
}
