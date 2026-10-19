import { type Group, group } from '../dxf/groups';
import { DxfRecord } from '../dxf/record';
import type { DxfDocument } from '../model/database';
import type { Tx } from './history';
import type { Vec3 } from '../dxf/record';
import { Ucs } from '../model/ucs';
import { apply, applyDir, isDefaultExtrusion, wcsToOcs, DEG } from '../geom/ocs';

export interface NewProps {
  layer: string;
  color?: number; // ACI; omitted = BYLAYER
}

type P2 = [number, number];

/**
 * Build a new entity with the structure the file's DXF version expects:
 * R13+ needs a handle, an owner (the *Model_Space block record) and subclass markers;
 * R12 has neither markers nor (usually) handles.
 */
function make(doc: DxfDocument, type: string, subclass: string | null, body: Group[], props: NewProps, extraSub: Group[] = []): DxfRecord {
  const gs: Group[] = [];
  const modern = doc.isModern;
  if (doc.usesHandles) gs.push(group(5, doc.newHandle()));
  if (modern) {
    const owner = doc.modelSpaceHandle;
    if (owner) gs.push(group(330, owner));
    gs.push(group(100, 'AcDbEntity'));
  }
  gs.push(group(8, props.layer));
  if (props.color !== undefined && props.color !== 256) gs.push(group(62, props.color));
  if (modern && subclass) gs.push(group(100, subclass));
  gs.push(...body);
  if (modern) gs.push(...extraSub);
  return new DxfRecord(type, gs);
}

const pt = (code: number, p: P2 | Vec3, z = 0): Group[] => [group(code, p[0]), group(code + 10, p[1]), group(code + 20, p[2] ?? z)];

/**
 * Geometry given in UCS 2D coordinates -> the entity's OCS. Planar entities store points in the
 * OCS of their extrusion (= the UCS Z axis); for the world UCS this is plain WCS.
 */
function planeOcs(plane: Ucs) {
  const n = plane.z;
  const w2o = wcsToOcs(n);
  return {
    /** OCS point (x, y, elevation) of a UCS point. */
    point: (p: P2): Vec3 => apply(w2o, plane.toWcs(p)),
    /** OCS angle (degrees) of a UCS angle (degrees). */
    angle: (deg: number): number => {
      const d = applyDir(w2o, plane.dirToWcs([Math.cos(deg * DEG), Math.sin(deg * DEG), 0]));
      const a = (Math.atan2(d[1], d[0]) / DEG + 360) % 360;
      return Math.abs(a - 360) < 1e-9 ? 0 : a;
    },
    extrusion: isDefaultExtrusion(n) ? [] : pt(210, n),
  };
}

export function newLine(doc: DxfDocument, a: P2, b: P2, props: NewProps, plane: Ucs = Ucs.WORLD): DxfRecord {
  return make(doc, 'LINE', 'AcDbLine', [...pt(10, plane.toWcs(a)), ...pt(11, plane.toWcs(b))], props);
}

export function newCircle(doc: DxfDocument, c: P2, r: number, props: NewProps, plane: Ucs = Ucs.WORLD): DxfRecord {
  const o = planeOcs(plane);
  return make(doc, 'CIRCLE', 'AcDbCircle', [...pt(10, o.point(c)), group(40, r), ...o.extrusion], props);
}

/** Arc from start to end angle (degrees, counter-clockwise, measured in the UCS). */
export function newArc(doc: DxfDocument, c: P2, r: number, startDeg: number, endDeg: number, props: NewProps, plane: Ucs = Ucs.WORLD): DxfRecord {
  const o = planeOcs(plane);
  const rec = make(doc, 'ARC', 'AcDbCircle', [...pt(10, o.point(c)), group(40, r), ...o.extrusion], props);
  if (doc.isModern) rec.groups.push(group(100, 'AcDbArc'));
  rec.groups.push(group(50, o.angle(startDeg)), group(51, o.angle(endDeg)));
  return rec;
}

export function newText(doc: DxfDocument, p: P2, height: number, text: string, rotDeg: number, props: NewProps, plane: Ucs = Ucs.WORLD): DxfRecord {
  const o = planeOcs(plane);
  const body = [...pt(10, o.point(p)), group(40, height), group(1, text)];
  const rot = o.angle(rotDeg);
  if (rot) body.push(group(50, rot));
  body.push(...o.extrusion);
  return make(doc, 'TEXT', 'AcDbText', body, props, [group(100, 'AcDbText')]);
}

/** LWPOLYLINE on R2000+, POLYLINE + VERTEX + SEQEND on older files. */
export function newPolyline(doc: DxfDocument, pts: P2[], closed: boolean, props: NewProps, plane: Ucs = Ucs.WORLD): DxfRecord {
  const o = planeOcs(plane);
  const ocs = pts.map(o.point);
  const elev = ocs[0]?.[2] ?? 0;
  if (doc.version >= 'AC1015') {
    const body: Group[] = [group(90, pts.length), group(70, closed ? 1 : 0)];
    if (Math.abs(elev) > 1e-12) body.push(group(38, elev));
    for (const q of ocs) body.push(group(10, q[0]), group(20, q[1]));
    body.push(...o.extrusion);
    return make(doc, 'LWPOLYLINE', 'AcDbPolyline', body, props);
  }
  const pl = make(doc, 'POLYLINE', 'AcDb2dPolyline', [group(66, 1), ...pt(10, [0, 0, elev]), group(70, closed ? 1 : 0), ...o.extrusion], props);
  for (const q of ocs) {
    const v = make(doc, 'VERTEX', 'AcDbVertex', [...pt(10, [q[0], q[1], elev])], props);
    pl.children.push(v);
  }
  pl.seqend = make(doc, 'SEQEND', null, [], props);
  return pl;
}

/** Remove reactor / extension-dictionary links so a copy doesn't share objects with its source. */
function stripOwnedLinks(gs: Group[]): Group[] {
  const out: Group[] = [];
  let skipping = false;
  for (const g of gs) {
    if (g.code === 102) {
      const v = g.value.trim();
      if (v === '{ACAD_REACTORS' || v === '{ACAD_XDICTIONARY') {
        skipping = true;
        continue;
      }
      if (v === '}' && skipping) {
        skipping = false;
        continue;
      }
    }
    if (!skipping) out.push({ code: g.code, value: g.value });
  }
  return out;
}

/** Deep copy with fresh handles; children's owner handles point at the new parent. */
export function cloneEntity(doc: DxfDocument, src: DxfRecord, tx: Tx): DxfRecord {
  const c = src.clone();
  const fresh = (r: DxfRecord, owner?: string) => {
    r.groups = stripOwnedLinks(r.groups);
    const hi = r.indexOf(5);
    if (hi >= 0) r.groups[hi].value = doc.newHandle();
    if (owner) {
      const oi = r.indexOf(330);
      if (oi >= 0) r.groups[oi].value = owner;
    }
  };
  fresh(c);
  const h = c.handle;
  for (const ch of c.children) fresh(ch, h);
  if (c.seqend) fresh(c.seqend, h);
  // Dimensions and tables reference an anonymous block that must not be shared.
  if ((c.type.endsWith('DIMENSION') || c.type === 'ACAD_TABLE') && c.str(2).startsWith('*')) {
    const name = cloneAnonymousBlock(doc, c.str(2), tx);
    if (name) c.set(2, name);
  }
  return c;
}

function cloneAnonymousBlock(doc: DxfDocument, name: string, tx: Tx): string | null {
  const blk = doc.block(name);
  if (!blk) return null;
  const prefix = name.slice(0, 2).toUpperCase(); // *D, *T, *U
  let n = 1;
  const used = new Set(doc.blocks.map((b) => b.begin.str(2).toUpperCase()));
  while (used.has(`${prefix}${n}`)) n++;
  const newName = `${prefix}${n}`;
  tx.global = true;

  let recordHandle: string | undefined;
  const brTable = doc.table('BLOCK_RECORD');
  const oldBr = doc.tableEntry('BLOCK_RECORD', name);
  if (brTable && oldBr) {
    const br = oldBr.clone();
    br.groups = stripOwnedLinks(br.groups);
    recordHandle = doc.newHandle();
    br.groups[br.indexOf(5)].value = recordHandle;
    br.set(2, newName);
    // drop the cached preview/insert-unit pointers that belong to the original
    br.groups = br.groups.filter((g) => g.code !== 331 && g.code !== 310);
    tx.touchArray(brTable.entries).push(br);
  }
  const fix = (r: DxfRecord) => {
    r.groups = stripOwnedLinks(r.groups);
    const hi = r.indexOf(5);
    if (hi >= 0) r.groups[hi].value = doc.newHandle();
    if (recordHandle && r.indexOf(330) >= 0) r.groups[r.indexOf(330)].value = recordHandle;
    return r;
  };
  const begin = fix(blk.begin.clone());
  begin.set(2, newName);
  if (begin.has(3)) begin.set(3, newName);
  const end = fix(blk.end.clone());
  const entities = blk.entities.map((e) => {
    const c = fix(e.clone());
    for (const ch of c.children) fix(ch);
    if (c.seqend) fix(c.seqend);
    return c;
  });
  tx.touchArray(doc.blocks).push({ begin, entities, end });
  doc.invalidateHandles();
  return newName;
}

/** Make sure a layer exists (creating it in the LAYER table if needed). */
export function ensureLayer(doc: DxfDocument, name: string, tx: Tx, color = 7): DxfRecord | null {
  const existing = doc.layer(name);
  if (existing) return existing;
  const table = doc.table('LAYER');
  if (!table) return null;
  const gs: Group[] = [];
  if (doc.usesHandles) gs.push(group(5, doc.newHandle()));
  if (doc.isModern) {
    if (table.head.handle) gs.push(group(330, table.head.handle));
    gs.push(group(100, 'AcDbSymbolTableRecord'), group(100, 'AcDbLayerTableRecord'));
  }
  gs.push(group(2, name), group(70, 0), group(62, color), group(6, 'Continuous'));
  if (doc.isModern) gs.push(group(370, -3), group(390, doc.tableEntry('LAYER', '0')?.get(390) ?? '0'));
  const rec = new DxfRecord('LAYER', gs);
  tx.touchArray(table.entries).push(rec);
  tx.global = true;
  doc.invalidateHandles();
  return rec;
}
