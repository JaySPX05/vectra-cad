import type { DxfRecord } from '../dxf/record';
import type { Vec3 } from '../dxf/record';
import { arcPoints, bulgePoints, ellipsePoints, splinePoints } from '../geom/tessellate';

const DEG = Math.PI / 180;

export interface HatchPatternDef {
  angle: number; // radians
  base: [number, number];
  offset: [number, number];
  dashes: number[];
}

export interface HatchData {
  solid: boolean;
  pattern: string;
  style: number; // 0 normal (odd parity), 1 outer, 2 ignore
  /** Boundary loops in OCS (x, y pairs). */
  loops: { pts: number[]; flags: number }[];
  lines: HatchPatternDef[];
  elevation: number;
  gradientColor: number | null;
  /** Two-colour linear gradient (approximation of all gradient types). */
  gradient: { colors: [number, number]; angle: number } | null;
}

/** Sequential reader over a record's groups. */
class Cursor {
  i: number;
  constructor(private rec: DxfRecord, start: number) {
    this.i = start;
  }
  peek(): number {
    return this.rec.groups[this.i]?.code ?? -1;
  }
  /** Read value if the next group has `code`, else return def without advancing. */
  opt(code: number, def = 0): number {
    if (this.peek() === code) return Number(this.rec.groups[this.i++].value) || 0;
    return def;
  }
  /** Read the next group with `code`, skipping unexpected groups (at most a few). */
  req(code: number, def = 0): number {
    for (let k = 0; k < 4 && this.i < this.rec.groups.length; k++) {
      if (this.peek() === code) return Number(this.rec.groups[this.i++].value) || 0;
      if (this.peek() === 92 || this.peek() === 75 || this.peek() === 0) break;
      this.i++;
    }
    return def;
  }
  xy(code: number): [number, number] {
    const x = this.req(code);
    const y = this.opt(code + 10);
    return [x, y];
  }
}

export function decodeHatch(rec: DxfRecord): HatchData {
  const sub = rec.groups.findIndex((g) => g.code === 100 && g.value.trim() === 'AcDbHatch');
  const start = sub >= 0 ? sub : 0;
  const elevation = rec.point(10)[2];
  const data: HatchData = {
    solid: rec.num(70, 0) === 1,
    pattern: rec.str(2),
    style: 0,
    loops: [],
    lines: [],
    elevation,
    gradientColor: null,
    gradient: null,
  };
  let i = rec.indexOf(91, start);
  if (i < 0) return data;
  const cur = new Cursor(rec, i);
  const nPaths = cur.req(91);
  for (let p = 0; p < nPaths && cur.i < rec.groups.length; p++) {
    while (cur.i < rec.groups.length && cur.peek() !== 92) cur.i++;
    const flags = cur.req(92);
    const pts: number[] = [];
    if (flags & 2) {
      const hasBulge = cur.opt(72);
      cur.opt(73);
      const n = cur.req(93);
      const verts: [number, number, number][] = [];
      for (let v = 0; v < n; v++) {
        const [x, y] = cur.xy(10);
        const b = hasBulge ? cur.opt(42) : 0;
        verts.push([x, y, b]);
      }
      for (let v = 0; v < verts.length; v++) {
        const a = verts[v], b = verts[(v + 1) % verts.length];
        if (v === 0) pts.push(a[0], a[1]);
        if (v === verts.length - 1 && a[2] === 0) break;
        for (const q of bulgePoints([a[0], a[1], 0], [b[0], b[1], 0], a[2])) pts.push(q[0], q[1]);
      }
    } else {
      const nEdges = cur.req(93);
      for (let e = 0; e < nEdges; e++) {
        const type = cur.req(72);
        let seg: Vec3[] = [];
        if (type === 1) {
          const a = cur.xy(10), b = cur.xy(11);
          seg = [[a[0], a[1], 0], [b[0], b[1], 0]];
        } else if (type === 2) {
          const c = cur.xy(10);
          const r = cur.req(40);
          const s = cur.req(50), en = cur.req(51);
          const ccw = cur.opt(73, 1);
          if (ccw) seg = arcPoints([c[0], c[1], 0], r, s * DEG, en * DEG);
          else seg = arcPoints([c[0], c[1], 0], r, -en * DEG, -s * DEG).reverse();
        } else if (type === 3) {
          const c = cur.xy(10), mj = cur.xy(11);
          const ratio = cur.req(40);
          const s = cur.req(50), en = cur.req(51);
          const ccw = cur.opt(73, 1);
          const major: Vec3 = [mj[0], mj[1], 0];
          const minor: Vec3 = [-mj[1] * ratio, mj[0] * ratio, 0];
          const cc: Vec3 = [c[0], c[1], 0];
          if (ccw) seg = ellipsePoints(cc, major, minor, s * DEG, en * DEG);
          else seg = ellipsePoints(cc, major, minor, -en * DEG, -s * DEG).reverse();
        } else if (type === 4) {
          const degree = cur.req(94);
          const rational = cur.opt(73);
          cur.opt(74);
          const nk = cur.req(95), nc = cur.req(96);
          const knots: number[] = [];
          for (let k = 0; k < nk; k++) knots.push(cur.req(40));
          const ctrl: Vec3[] = [];
          const w: number[] = [];
          for (let k = 0; k < nc; k++) {
            const q = cur.xy(10);
            ctrl.push([q[0], q[1], 0]);
            if (rational) w.push(cur.opt(42, 1));
          }
          if (cur.peek() === 97) {
            const nf = cur.req(97);
            for (let k = 0; k < nf; k++) cur.xy(11);
            if (cur.peek() === 12) cur.xy(12);
            if (cur.peek() === 13) cur.xy(13);
          }
          seg = splinePoints(degree, knots, ctrl, rational ? w : undefined);
        }
        for (let k = 0; k < seg.length; k++) {
          const n = pts.length;
          // skip the duplicated joint between consecutive edges
          if (k === 0 && n >= 2 && Math.abs(pts[n - 2] - seg[0][0]) < 1e-9 && Math.abs(pts[n - 1] - seg[0][1]) < 1e-9) continue;
          pts.push(seg[k][0], seg[k][1]);
        }
      }
    }
    // source boundary object references
    if (cur.peek() === 97) {
      const ns = cur.req(97);
      for (let k = 0; k < ns && cur.peek() === 330; k++) cur.i++;
    }
    if (pts.length >= 6) data.loops.push({ pts, flags });
  }
  data.style = cur.req(75);
  cur.opt(76);
  if (!data.solid) {
    cur.opt(52);
    cur.opt(41);
    cur.opt(77);
    const nLines = cur.opt(78);
    for (let l = 0; l < nLines; l++) {
      const angle = cur.req(53) * DEG;
      const bx = cur.req(43), by = cur.opt(44);
      const ox = cur.req(45), oy = cur.opt(46);
      const nd = cur.req(79);
      const dashes: number[] = [];
      for (let d = 0; d < nd; d++) dashes.push(cur.req(49));
      data.lines.push({ angle, base: [bx, by], offset: [ox, oy], dashes });
    }
  }
  if (rec.num(450, 0) === 1) {
    const gi = rec.indexOf(421);
    data.gradientColor = gi >= 0 ? Number(rec.groups[gi].value) & 0xffffff : null;
    data.solid = true;
    const cols = rec.all(421).map((v) => Number(v) & 0xffffff);
    if (cols.length >= 2) data.gradient = { colors: [cols[0], cols[1]], angle: rec.num(460, 0) };
    else if (cols.length === 1 && rec.num(452, 0) === 1) {
      // one-colour gradient: blend toward white by the tint (462)
      const t = rec.num(462, 1), c = cols[0];
      const mix = (ch: number) => Math.round(ch + (255 - ch) * (1 - t));
      data.gradient = { colors: [c, (mix(c >> 16 & 255) << 16) | (mix(c >> 8 & 255) << 8) | mix(c & 255)], angle: rec.num(460, 0) };
    }
  }
  return data;
}
