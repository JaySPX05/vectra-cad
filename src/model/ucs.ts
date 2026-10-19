import { type Group, group } from '../dxf/groups';
import { DxfRecord, type Vec3 } from '../dxf/record';
import { apply, applyDir, cross, dot, type Mat, norm } from '../geom/ocs';
import type { DxfDocument } from './database';
import type { Tx } from '../edit/history';

/**
 * User Coordinate System: an origin and orthonormal X/Y axes in WCS (Z = X × Y).
 * Points typed or picked by the user are UCS coordinates; geometry is stored in WCS/OCS.
 */
export class Ucs {
  readonly x: Vec3;
  readonly y: Vec3;
  readonly z: Vec3;

  constructor(readonly origin: Vec3 = [0, 0, 0], x: Vec3 = [1, 0, 0], y: Vec3 = [0, 1, 0], readonly name = '') {
    // re-orthonormalise so stored (rounded) axes still give an exact frame
    this.x = norm(x);
    this.z = norm(cross(this.x, y));
    this.y = cross(this.z, this.x);
  }

  static readonly WORLD = new Ucs();

  get isWorld(): boolean {
    const e = 1e-12;
    return this.origin.every((v) => Math.abs(v) < e) && Math.abs(this.x[0] - 1) < e && Math.abs(this.y[1] - 1) < e;
  }

  /** True when the UCS XY plane is parallel to the WCS XY plane (Z axis unchanged). */
  get zParallel(): boolean {
    return Math.abs(this.z[2] - 1) < 1e-12;
  }

  /** UCS -> WCS matrix. */
  matrix(): Mat {
    const [o, x, y, z] = [this.origin, this.x, this.y, this.z];
    return [x[0], y[0], z[0], o[0], x[1], y[1], z[1], o[1], x[2], y[2], z[2], o[2]];
  }

  /** WCS -> UCS matrix (transpose of the rotation, then translation). */
  inverse(): Mat {
    const [o, x, y, z] = [this.origin, this.x, this.y, this.z];
    return [x[0], x[1], x[2], -dot(x, o), y[0], y[1], y[2], -dot(y, o), z[0], z[1], z[2], -dot(z, o)];
  }

  toWcs(p: Vec3 | [number, number]): Vec3 {
    return apply(this.matrix(), p);
  }
  fromWcs(p: Vec3): Vec3 {
    return apply(this.inverse(), p);
  }
  dirToWcs(d: Vec3): Vec3 {
    return applyDir(this.matrix(), d);
  }

  withOrigin(o: Vec3): Ucs {
    return new Ucs(o, this.x, this.y);
  }

  /** Rotate the axes about the UCS's own X, Y or Z axis (right-hand rule). */
  rotated(axis: 'X' | 'Y' | 'Z', angle: number): Ucs {
    const c = Math.cos(angle), s = Math.sin(angle);
    const rot = (u: Vec3, v: Vec3): [Vec3, Vec3] => [
      [u[0] * c + v[0] * s, u[1] * c + v[1] * s, u[2] * c + v[2] * s],
      [v[0] * c - u[0] * s, v[1] * c - u[1] * s, v[2] * c - u[2] * s],
    ];
    if (axis === 'Z') {
      const [x, y] = rot(this.x, this.y);
      return new Ucs(this.origin, x, y);
    }
    if (axis === 'X') {
      const [y] = rot(this.y, this.z);
      return new Ucs(this.origin, this.x, y);
    }
    const [z, x] = rot(this.z, this.x);
    return new Ucs(this.origin, x, cross(z, x));
  }

  /** AutoCAD's 3-point UCS: origin, a point on +X, and a point in the XY plane (positive Y side). */
  static threePoint(o: Vec3, px: Vec3, py?: Vec3): Ucs | null {
    const x: Vec3 = [px[0] - o[0], px[1] - o[1], px[2] - o[2]];
    if (Math.hypot(...x) < 1e-12) return null;
    if (!py) {
      // keep the current Z: Y = Z x X in the plane perpendicular to world Z when possible
      const z: Vec3 = Math.abs(norm(x)[2]) > 1 - 1e-9 ? [0, 1, 0] : [0, 0, 1];
      return new Ucs(o, x, cross(z, norm(x)));
    }
    const v: Vec3 = [py[0] - o[0], py[1] - o[1], py[2] - o[2]];
    if (Math.hypot(...cross(x, v)) < 1e-12) return null;
    return new Ucs(o, x, v);
  }

  equals(u: Ucs): boolean {
    const close = (a: Vec3, b: Vec3) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
    return close(this.origin, u.origin) && close(this.x, u.x) && close(this.y, u.y);
  }
}

// ---- persistence ------------------------------------------------------------------------------

/** Current model-space UCS from the header ($UCSORG / $UCSXDIR / $UCSYDIR / $UCSNAME). */
export function readUcs(doc: DxfDocument): Ucs {
  const o = doc.headerPoint('$UCSORG') ?? [0, 0, 0];
  const x = doc.headerPoint('$UCSXDIR') ?? [1, 0, 0];
  const y = doc.headerPoint('$UCSYDIR') ?? [0, 1, 0];
  if (Math.hypot(...cross(x, y)) < 1e-9) return Ucs.WORLD;
  return new Ucs(o, x, y, doc.headerValue('$UCSNAME') ?? '');
}

const pointGroups = (code: number, p: Vec3): Group[] => [group(code, p[0]), group(code + 10, p[1]), group(code + 20, p[2])];

/** Replace a header variable's groups in place (so the transaction can undo it). */
export function setHeaderGroups(doc: DxfDocument, name: string, groups: Group[], tx: Tx) {
  const hv = doc.headerVar(name);
  if (hv) {
    tx.touchArray(hv.groups).splice(0, hv.groups.length, ...groups);
    return;
  }
  const vars = doc.headerVars;
  // headerVars is the live array when a HEADER section exists
  if (doc.sections.some((s) => s.kind === 'header')) tx.touchArray(vars).push({ name, groups });
}

/** Make `ucs` current: header variables plus the *Active viewport's UCS (R2000+). */
export function writeUcs(doc: DxfDocument, ucs: Ucs, tx: Tx): void {
  setHeaderGroups(doc, '$UCSORG', pointGroups(10, ucs.origin), tx);
  setHeaderGroups(doc, '$UCSXDIR', pointGroups(10, ucs.x), tx);
  setHeaderGroups(doc, '$UCSYDIR', pointGroups(10, ucs.y), tx);
  setHeaderGroups(doc, '$UCSNAME', [group(2, ucs.name)], tx);
  const vp = doc.tableEntry('VPORT', '*Active');
  if (vp && doc.isModern) {
    tx.touch(vp);
    vp.setPoint(110, ucs.origin);
    vp.setPoint(111, ucs.x);
    vp.setPoint(112, ucs.y);
    vp.set(79, 0);
  }
}

// ---- named UCSs (UCS table) ------------------------------------------------------------------------

export function namedUcsList(doc: DxfDocument): Ucs[] {
  return (doc.table('UCS')?.entries ?? []).map((e) => new Ucs(e.point(10), e.point(11, [1, 0, 0]), e.point(12, [0, 1, 0]), e.str(2)));
}

export function saveNamedUcs(doc: DxfDocument, name: string, ucs: Ucs, tx: Tx): boolean {
  const table = doc.table('UCS');
  if (!table) return false;
  const existing = doc.tableEntry('UCS', name);
  if (existing) {
    tx.touch(existing);
    existing.setPoint(10, ucs.origin);
    existing.setPoint(11, ucs.x);
    existing.setPoint(12, ucs.y);
    return true;
  }
  const gs: Group[] = [];
  if (doc.usesHandles) gs.push(group(5, doc.newHandle()));
  if (doc.isModern) {
    if (table.head.handle) gs.push(group(330, table.head.handle));
    gs.push(group(100, 'AcDbSymbolTableRecord'), group(100, 'AcDbUCSTableRecord'));
  }
  gs.push(group(2, name), group(70, 0), ...pointGroups(10, ucs.origin), ...pointGroups(11, ucs.x), ...pointGroups(12, ucs.y));
  if (doc.isModern) gs.push(group(79, 0), group(146, 0));
  tx.touchArray(table.entries).push(new DxfRecord('UCS', gs));
  doc.invalidateHandles();
  return true;
}

export function deleteNamedUcs(doc: DxfDocument, name: string, tx: Tx): boolean {
  const table = doc.table('UCS');
  const e = doc.tableEntry('UCS', name);
  if (!table || !e) return false;
  const arr = tx.touchArray(table.entries);
  arr.splice(arr.indexOf(e), 1);
  doc.invalidateHandles();
  return true;
}
