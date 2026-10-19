import type { DxfRecord, Vec3 } from '../dxf/record';
import { apply, isDefaultExtrusion, ocsToWcs, wcsToOcs } from '../geom/ocs';
import { formatValue } from '../dxf/groups';
import { vertices } from '../render/geometry';

/**
 * Grips: editable handle points on an entity, like AutoCAD's blue squares.
 * `move: true` grips translate the whole entity; others reshape it.
 */
export interface Grip {
  x: number;
  y: number;
  /** World Z of the grip; drags move within the plane Z = z. */
  z: number;
  id: string;
  move?: boolean;
}

const DEG = Math.PI / 180;

function planar(r: DxfRecord): boolean {
  return isDefaultExtrusion(r.point(210, [0, 0, 1]));
}

export function gripsFor(r: DxfRecord): Grip[] {
  const p = (code: number, id = String(code), move = false): Grip => {
    const q = r.point(code);
    return { x: q[0], y: q[1], z: q[2], id, move };
  };
  switch (r.type) {
    case 'LINE': {
      const a = r.point(10), b = r.point(11);
      return [p(10), p(11), { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, z: (a[2] + b[2]) / 2, id: 'mid', move: true }];
    }
    case 'POINT':
      return [p(10, '10', true)];
    case 'CIRCLE': {
      if (!planar(r)) return [];
      const c = r.point(10), rad = r.num(40, 0);
      return [
        p(10, 'c', true),
        { x: c[0] + rad, y: c[1], z: c[2], id: 'q' }, { x: c[0], y: c[1] + rad, z: c[2], id: 'q' },
        { x: c[0] - rad, y: c[1], z: c[2], id: 'q' }, { x: c[0], y: c[1] - rad, z: c[2], id: 'q' },
      ];
    }
    case 'ARC': {
      if (!planar(r)) return [];
      const c = r.point(10), rad = r.num(40, 0);
      const a0 = r.num(50, 0) * DEG;
      let a1 = r.num(51, 0) * DEG;
      if (a1 <= a0) a1 += Math.PI * 2;
      const am = (a0 + a1) / 2;
      return [
        p(10, 'c', true),
        { x: c[0] + rad * Math.cos(a0), y: c[1] + rad * Math.sin(a0), z: c[2], id: 'a0' },
        { x: c[0] + rad * Math.cos(a1), y: c[1] + rad * Math.sin(a1), z: c[2], id: 'a1' },
        { x: c[0] + rad * Math.cos(am), y: c[1] + rad * Math.sin(am), z: c[2], id: 'q' },
      ];
    }
    case 'ELLIPSE': {
      if (!planar(r)) return [];
      const c = r.point(10), m = r.point(11), ratio = r.num(40, 1);
      return [
        p(10, 'c', true),
        { x: c[0] + m[0], y: c[1] + m[1], z: c[2], id: 'major' },
        { x: c[0] - m[1] * ratio, y: c[1] + m[0] * ratio, z: c[2], id: 'minor' },
      ];
    }
    case 'LWPOLYLINE':
      if (!planar(r)) return [];
      return vertices(r, 10).map((v, i) => ({ x: v[0], y: v[1], z: r.num(38, 0), id: 'v' + i }));
    case 'POLYLINE': {
      const f = r.num(70, 0);
      if (f & (16 | 64)) return [];
      if (!(f & 8) && !planar(r)) return [];
      const elev = r.point(10)[2];
      return r.children.filter((c) => c.type === 'VERTEX').map((v, i) => {
        const q = v.point(10);
        return { x: q[0], y: q[1], z: f & 8 ? q[2] : elev, id: 'v' + i };
      });
    }
    case 'SPLINE': {
      const ctrl = vertices(r, 10);
      if (ctrl.length) return ctrl.map((v, i) => ({ x: v[0], y: v[1], z: v[2], id: 'cp' + i }));
      return vertices(r, 11).map((v, i) => ({ x: v[0], y: v[1], z: v[2], id: 'fp' + i }));
    }
    case 'SOLID':
    case 'TRACE':
      if (!planar(r)) return [];
      return [p(10), p(11), p(12), p(13)].filter((_, i) => i < 3 || r.hasPoint(13));
    case '3DFACE':
      return [p(10), p(11), p(12), p(13)];
    case 'TEXT':
    case 'ATTDEF':
      if (!planar(r)) return [];
      return [p(10, 'ins', true)];
    case 'DIMENSION':
      return dimensionGrips(r);
    case 'MTEXT':
    case 'INSERT':
    case 'LEADER':
    case 'MULTILEADER':
    case 'DIMENSION':
    case 'HATCH':
    case 'IMAGE':
    case 'WIPEOUT':
    case 'ACAD_TABLE':
    case 'XLINE':
    case 'RAY':
      if (r.type === 'INSERT' && !planar(r)) return [];
      if (r.type === 'HATCH' || r.type.endsWith('LEADER') || r.type === 'DIMENSION') return [];
      return [p(10, 'ins', true)];
    default:
      return [];
  }
}

/** Definition-point grips of a dimension (WCS points; 11 and 16 are stored in the OCS). */
const DIM_GRIPS: Record<number, number[]> = { 0: [13, 14, 10, 11], 1: [13, 14, 10, 11], 2: [16, 11], 3: [11], 4: [11], 5: [13, 14, 15, 10, 11], 6: [13, 14, 11] };
const OCS_CODES = new Set([11, 12, 16]);

function dimensionGrips(r: DxfRecord): Grip[] {
  const n = r.point(210, [0, 0, 1]);
  const o2w = ocsToWcs(n);
  return (DIM_GRIPS[r.num(70, 0) & 7] ?? []).map((code) => {
    const p = OCS_CODES.has(code) ? apply(o2w, r.point(code)) : r.point(code);
    return { x: p[0], y: p[1], z: p[2], id: 'd' + code };
  });
}

function applyDimensionGrip(r: DxfRecord, g: Grip, x: number, y: number) {
  const code = Number(g.id.slice(1));
  const n = r.point(210, [0, 0, 1]);
  const w: Vec3 = [x, y, g.z];
  if (OCS_CODES.has(code)) r.setPoint(code, apply(wcsToOcs(n), w));
  else r.setPoint(code, w);
  if (code !== 11) return;
  r.set(70, r.num(70, 0) | 128); // text placed by the user
  const type = r.num(70, 0) & 7;
  if (type === 3 || type === 4) {
    // radius/diameter: the leader follows the label around the curve
    const q = r.point(15), other = r.point(10);
    const c: Vec3 = type === 4 ? other : [(q[0] + other[0]) / 2, (q[1] + other[1]) / 2, (q[2] + other[2]) / 2];
    const rad = Math.hypot(q[0] - c[0], q[1] - c[1], q[2] - c[2]);
    const d: Vec3 = [w[0] - c[0], w[1] - c[1], w[2] - c[2]];
    const l = Math.hypot(...d);
    if (l > 1e-12 && rad > 0) {
      const nq: Vec3 = [c[0] + (d[0] / l) * rad, c[1] + (d[1] / l) * rad, c[2] + (d[2] / l) * rad];
      r.setPoint(15, nq);
      if (type === 3) r.setPoint(10, [2 * c[0] - nq[0], 2 * c[1] - nq[1], 2 * c[2] - nq[2]]);
    }
  }
}

function setNth(r: DxfRecord, code: number, n: number, x: number, y: number): void {
  let k = -1;
  for (let i = 0; i < r.groups.length; i++) {
    if (r.groups[i].code !== code) continue;
    if (++k !== n) continue;
    r.groups[i].value = formatValue(code, x);
    if (r.groups[i + 1]?.code === code + 10) r.groups[i + 1].value = formatValue(code + 10, y);
    return;
  }
}

/** Reshape an entity by dragging a non-move grip to (x, y). */
export function applyGrip(r: DxfRecord, g: Grip, x: number, y: number): void {
  const z = (code: number) => r.point(code)[2];
  switch (r.type) {
    case 'DIMENSION':
      applyDimensionGrip(r, g, x, y);
      return;
    case 'LINE':
    case 'SOLID':
    case 'TRACE':
    case '3DFACE': {
      const code = Number(g.id);
      r.setPoint(code, [x, y, z(code)] as Vec3);
      return;
    }
    case 'CIRCLE':
    case 'ARC': {
      const c = r.point(10);
      if (g.id === 'q') r.set(40, Math.hypot(x - c[0], y - c[1]));
      else if (g.id === 'a0' || g.id === 'a1') {
        let a = Math.atan2(y - c[1], x - c[0]) / DEG;
        if (a < 0) a += 360;
        r.set(g.id === 'a0' ? 50 : 51, a);
      }
      return;
    }
    case 'ELLIPSE': {
      const c = r.point(10);
      if (g.id === 'major') {
        const oldLen = Math.hypot(...(r.point(11).slice(0, 2) as [number, number]));
        const minorLen = oldLen * r.num(40, 1);
        const newLen = Math.hypot(x - c[0], y - c[1]);
        r.setPoint(11, [x - c[0], y - c[1], 0]);
        if (newLen > 0) r.set(40, Math.min(1, minorLen / newLen));
      } else if (g.id === 'minor') {
        const m = r.point(11);
        const ml = Math.hypot(m[0], m[1]);
        // distance from the major axis line
        const d = Math.abs(((x - c[0]) * m[1] - (y - c[1]) * m[0]) / (ml || 1));
        if (ml > 0) r.set(40, Math.max(1e-6, Math.min(1, d / ml)));
      }
      return;
    }
    case 'LWPOLYLINE':
      setNth(r, 10, Number(g.id.slice(1)), x, y);
      return;
    case 'POLYLINE': {
      const v = r.children.filter((c) => c.type === 'VERTEX')[Number(g.id.slice(1))];
      if (v) {
        const q = v.point(10);
        v.setPoint(10, [x, y, q[2]]);
      }
      return;
    }
    case 'SPLINE':
      setNth(r, g.id.startsWith('cp') ? 10 : 11, Number(g.id.slice(2)), x, y);
      return;
  }
}
