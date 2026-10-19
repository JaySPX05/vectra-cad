import { type Group, group } from '../dxf/groups';
import { DxfRecord, type Vec3 } from '../dxf/record';
import type { DxfBlock, DxfDocument } from '../model/database';
import { Ucs } from '../model/ucs';
import type { Tx } from '../edit/history';
import { ensureLayer, type NewProps } from '../edit/create';
import { apply, applyDir, isDefaultExtrusion, wcsToOcs } from '../geom/ocs';
import { buildDimension, DIM_TYPE } from './build';
import { type DynText, dynamicHeight, readDynamic, writeDynamic, XDATA_APP } from './dynamic';
import { DIMVAR, dimStyleFor, readDimOverrides as readOverrides, type DimStyle, type VarValue, withValues, writeDimOverrides } from './style';
import { VAR_BY_NAME } from './vars';
import { nameHandle } from './arrow-blocks';

/** What the dimension commands produce; all points in WCS. `text` = override (group 1, "<>" = value). */
export type DimSpec = (
  | { kind: 'rotated'; p1: Vec3; p2: Vec3; loc: Vec3; /** measurement direction in WCS */ dir: Vec3 }
  | { kind: 'aligned'; p1: Vec3; p2: Vec3; loc: Vec3 }
  | { kind: 'radius' | 'diameter'; center: Vec3; radius: number; textPos: Vec3 }
  | { kind: 'angular3'; vertex: Vec3; p1: Vec3; p2: Vec3; loc: Vec3 }
  | { kind: 'angular2'; l1a: Vec3; l1b: Vec3; l2a: Vec3; l2b: Vec3; loc: Vec3 }
  | { kind: 'ordinate'; feature: Vec3; leaderEnd: Vec3; xDatum: boolean }
) & {
  text?: string;
  /** DIMSCALE override for this dimension (sizes text, arrows, gaps) */
  scale?: number;
  /** Label height in drawing units (a DIMTXT override; arrows keep their size) */
  textHeight?: number;
  /** Label height follows the measured value (recomputed on every regeneration) */
  dynamic?: DynText;
  /** Style overrides by variable name (the Dimension Style Manager's "Override"), stored as DSTYLE XDATA */
  overrides?: Record<string, VarValue>;
};

const hasOverrides = (spec: DimSpec) => Object.keys(spec.overrides ?? {}).length > 0;

const pt = (code: number, p: Vec3): Group[] => [group(code, p[0]), group(code + 10, p[1]), group(code + 20, p[2])];

/** Allocate an unused anonymous block name like *D7. */
function anonymousName(doc: DxfDocument, prefix: string): string {
  const used = new Set(doc.blocks.map((b) => b.begin.str(2).toUpperCase()));
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** Give block-content records handles and their owner (the block record). */
function adopt(doc: DxfDocument, recs: DxfRecord[], owner: string | undefined) {
  for (const r of recs) {
    const head: Group[] = [];
    if (doc.usesHandles) head.push(group(5, doc.newHandle()));
    if (doc.isModern && owner) head.push(group(330, owner));
    r.groups.unshift(...head);
  }
}

/** Create an anonymous block (*D/*U...) with its BLOCK_RECORD (R13+), inside the transaction. */
export function createAnonymousBlock(doc: DxfDocument, prefix: string, ents: DxfRecord[], tx: Tx): string {
  const name = anonymousName(doc, prefix);
  tx.global = true;
  const modern = doc.isModern;
  let brHandle: string | undefined;
  const brTable = doc.table('BLOCK_RECORD');
  if (modern && brTable) {
    brHandle = doc.newHandle();
    const gs: Group[] = [group(5, brHandle)];
    if (brTable.head.handle) gs.push(group(330, brTable.head.handle));
    gs.push(group(100, 'AcDbSymbolTableRecord'), group(100, 'AcDbBlockTableRecord'), group(2, name), group(340, '0'));
    tx.touchArray(brTable.entries).push(new DxfRecord('BLOCK_RECORD', gs));
  }
  const head = (): Group[] => {
    const gs: Group[] = [];
    if (doc.usesHandles) gs.push(group(5, doc.newHandle()));
    if (modern && brHandle) gs.push(group(330, brHandle));
    if (modern) gs.push(group(100, 'AcDbEntity'));
    gs.push(group(8, '0'));
    return gs;
  };
  const begin = new DxfRecord('BLOCK', [...head(), ...(modern ? [group(100, 'AcDbBlockBegin')] : []), group(2, name), group(70, 1), ...pt(10, [0, 0, 0]), group(3, name), group(1, '')]);
  const end = new DxfRecord('ENDBLK', [...head(), ...(modern ? [group(100, 'AcDbBlockEnd')] : [])]);
  adopt(doc, ents, brHandle);
  const blocks = doc.blocks;
  if (!doc.sections.some((s) => s.kind === 'blocks')) throw new Error('This file has no BLOCKS section.');
  tx.touchArray(blocks).push({ begin, entities: ents, end } as DxfBlock);
  doc.invalidateHandles();
  return name;
}

/**
 * Build a DIMENSION entity like AutoCAD: definition points, measurement, and an anonymous
 * block with the drawn graphics and label. Lies in the UCS plane (extrusion = UCS Z).
 */
export function newDimension(doc: DxfDocument, spec: DimSpec, ucs: Ucs, props: NewProps, tx: Tx): DxfRecord {
  const rec = dimensionRecord(doc, spec, ucs, props, true);
  ensureLayer(doc, 'Defpoints', tx, 7);
  if (spec.scale || spec.textHeight || spec.dynamic || hasOverrides(spec)) ensureAppId(doc, 'ACAD', tx);
  // arrow blocks named by overrides must exist before their handles are written
  for (const [k, v] of Object.entries(spec.overrides ?? {})) {
    const dv = VAR_BY_NAME.get(k);
    if (dv) nameHandle(doc, dv, v, tx);
  }
  if (spec.dynamic) ensureAppId(doc, XDATA_APP, tx);
  applyDynamic(doc, rec);
  const geo = buildDimension(doc, rec, dimStyleFor(doc, rec));
  if (!geo) throw new Error('Could not build the dimension geometry.');
  rec.set(42, geo.measurement);
  rec.setPoint(11, geo.textMid);
  rec.set(2, createAnonymousBlock(doc, '*D', geo.entities, tx));
  return rec;
}

/** The graphics a dimension would have, without changing the drawing (command previews). */
export function previewDimension(doc: DxfDocument, spec: DimSpec, ucs: Ucs): DxfRecord[] {
  const rec = dimensionRecord(doc, spec, ucs, { layer: '0' }, false);
  applyDynamic(doc, rec);
  return buildDimension(doc, rec, withValues(dimStyleFor(doc, rec), spec.overrides ?? {}))?.entities ?? [];
}

/** Graphics of a dimension drawn with an explicit style (the Dimension Style dialog's preview). */
export function previewWithStyle(doc: DxfDocument, spec: DimSpec, st: DimStyle): DxfRecord[] {
  const rec = dimensionRecord(doc, spec, Ucs.WORLD, { layer: '0' }, false);
  rec.set(3, st.name);
  return buildDimension(doc, rec, st)?.entities ?? [];
}

/** The DIMENSION record (groups for the file's version) before its block exists. */
function dimensionRecord(doc: DxfDocument, spec: DimSpec, ucs: Ucs, props: NewProps, handles: boolean): DxfRecord {
  const st = dimStyleFor(doc, new DxfRecord('DIMENSION', []));
  const n = ucs.z;
  const w2o = wcsToOcs(n);
  const ocs = (p: Vec3): Vec3 => apply(w2o, p);
  const ocsAngleDeg = (d: Vec3) => {
    const q = applyDir(w2o, d);
    return (Math.atan2(q[1], q[0]) * 180) / Math.PI;
  };
  const modern = doc.isModern;

  let type: number;
  let defs: Group[] = [];
  let sub: Group[] = [];
  let userText: Vec3 | null = null;
  const S = (name: string): Group[] => (modern ? [group(100, name)] : []);
  switch (spec.kind) {
    case 'rotated':
    case 'aligned': {
      type = spec.kind === 'rotated' ? DIM_TYPE.rotated : DIM_TYPE.aligned;
      // 10 = where the dimension line meets the 2nd extension line
      const d = spec.kind === 'rotated' ? spec.dir : [spec.p2[0] - spec.p1[0], spec.p2[1] - spec.p1[1], spec.p2[2] - spec.p1[2]] as Vec3;
      const l = Math.hypot(...d) || 1;
      const u: Vec3 = [d[0] / l, d[1] / l, d[2] / l];
      const t = (spec.p2[0] - spec.loc[0]) * u[0] + (spec.p2[1] - spec.loc[1]) * u[1] + (spec.p2[2] - spec.loc[2]) * u[2];
      const p10: Vec3 = [spec.loc[0] + u[0] * t, spec.loc[1] + u[1] * t, spec.loc[2] + u[2] * t];
      defs = pt(10, p10);
      sub = [...S('AcDbAlignedDimension'), ...pt(13, spec.p1), ...pt(14, spec.p2)];
      if (spec.kind === 'rotated') sub.push(group(50, ocsAngleDeg(u)), ...S('AcDbRotatedDimension'));
      break;
    }
    case 'radius':
    case 'diameter': {
      type = spec.kind === 'radius' ? DIM_TYPE.radius : DIM_TYPE.diameter;
      // the defining point lies on the curve in the direction of the label
      const c = spec.center, tp = spec.textPos;
      const d: Vec3 = [tp[0] - c[0], tp[1] - c[1], tp[2] - c[2]];
      const l = Math.hypot(...d) || 1;
      const q: Vec3 = [c[0] + (d[0] / l) * spec.radius, c[1] + (d[1] / l) * spec.radius, c[2] + (d[2] / l) * spec.radius];
      const q2: Vec3 = [2 * c[0] - q[0], 2 * c[1] - q[1], 2 * c[2] - q[2]];
      defs = pt(10, spec.kind === 'radius' ? c : q2);
      sub = [...S(spec.kind === 'radius' ? 'AcDbRadialDimension' : 'AcDbDiametricDimension'), ...pt(15, q), group(40, 0)];
      userText = ocs(tp);
      break;
    }
    case 'angular3':
      type = DIM_TYPE.angular3;
      defs = pt(10, spec.loc);
      sub = [...S('AcDb3PointAngularDimension'), ...pt(13, spec.p1), ...pt(14, spec.p2), ...pt(15, spec.vertex)];
      break;
    case 'angular2':
      type = DIM_TYPE.angular2;
      defs = pt(10, spec.l2b);
      sub = [...S('AcDb2LineAngularDimension'), ...pt(13, spec.l1a), ...pt(14, spec.l1b), ...pt(15, spec.l2a), ...pt(16, ocs(spec.loc))];
      break;
    case 'ordinate':
      type = DIM_TYPE.ordinate | (spec.xDatum ? 64 : 0);
      defs = pt(10, ucs.origin);
      sub = [...S('AcDbOrdinateDimension'), ...pt(13, spec.feature), ...pt(14, spec.leaderEnd)];
      break;
  }

  const gs: Group[] = [];
  if (handles && doc.usesHandles) gs.push(group(5, doc.newHandle()));
  if (modern) {
    const owner = doc.modelSpaceHandle;
    if (owner) gs.push(group(330, owner));
    gs.push(group(100, 'AcDbEntity'));
  }
  gs.push(group(8, props.layer));
  if (props.color !== undefined && props.color !== 256) gs.push(group(62, props.color));
  gs.push(...S('AcDbDimension'));
  gs.push(group(2, '*D0'), ...defs, ...pt(11, userText ?? [0, 0, 0]), group(70, type | 32 | (userText ? 128 : 0)), group(71, 5), group(42, 0), group(1, spec.text ?? ''), group(3, st.name));
  if (!isDefaultExtrusion(n)) gs.push(...pt(210, n));
  // 51: minus the angle of the UCS X axis in the OCS ("horizontal direction")
  const hd = -ocsAngleDeg(ucs.x);
  if (Math.abs(hd) > 1e-9) gs.push(group(51, hd));
  gs.push(...sub);
  const rec = new DxfRecord('DIMENSION', gs);
  const ov = new Map<number, VarValue>();
  for (const [k, v] of Object.entries(spec.overrides ?? {})) {
    const dv = VAR_BY_NAME.get(k);
    if (!dv) continue;
    if (dv.kind === 'style' || dv.kind === 'ltype' || dv.kind === 'arrow') {
      const h = nameHandle(doc, dv, v);
      if (h) ov.set(dv.code, h);
    } else ov.set(dv.code, v);
  }
  if (spec.scale) ov.set(DIMVAR.DIMSCALE, spec.scale);
  // DIMTXT is multiplied by DIMSCALE, so store height / scale to get exactly `textHeight`
  if (spec.textHeight) ov.set(DIMVAR.DIMTXT, spec.textHeight / (spec.scale ?? st.scale));
  if (ov.size) writeDimOverrides(rec, ov);
  if (spec.dynamic) writeDynamic(rec, spec.dynamic);
  return rec;
}

/**
 * For a dynamic dimension, measure it (first build pass) and store the resulting label height
 * as its DIMTXT override (height / DIMSCALE), so AutoCAD shows the same size.
 */
function applyDynamic(doc: DxfDocument, rec: DxfRecord): void {
  const d = readDynamic(rec);
  if (!d) return;
  const st = dimStyleFor(doc, rec);
  const geo = buildDimension(doc, rec, st);
  if (!geo || !(geo.size > 0)) return;
  const h = dynamicHeight(geo.size, d);
  const map = new Map<number, number | string>();
  for (const [k, v] of readOverrides(rec)) map.set(k, Number.isFinite(Number(v)) ? Number(v) : v);
  map.set(DIMVAR.DIMTXT, +(h / st.scale).toPrecision(10));
  writeDimOverrides(rec, map);
}

/** Turn dynamic label height on (settings) or off (null: the current height stays as a fixed override). */
export function setDimDynamic(doc: DxfDocument, rec: DxfRecord, d: DynText | null, tx: Tx): void {
  tx.touch(rec);
  if (d) {
    ensureAppId(doc, 'ACAD', tx);
    ensureAppId(doc, XDATA_APP, tx);
  }
  writeDynamic(rec, d);
  regenDimension(doc, rec, tx);
}

/** XDATA needs its application registered in the APPID table. */
export function ensureAppId(doc: DxfDocument, name: string, tx: Tx): void {
  const table = doc.table('APPID');
  if (!table || doc.tableEntry('APPID', name)) return;
  const gs: Group[] = [];
  if (doc.usesHandles) gs.push(group(5, doc.newHandle()));
  if (doc.isModern) {
    if (table.head.handle) gs.push(group(330, table.head.handle));
    gs.push(group(100, 'AcDbSymbolTableRecord'), group(100, 'AcDbRegAppTableRecord'));
  }
  gs.push(group(2, name), group(70, 0));
  tx.touchArray(table.entries).push(new DxfRecord('APPID', gs));
  tx.global = true;
}

/** Set (or with null clear) one DIMSTYLE override on a dimension and regenerate it. */
export function setDimOverride(doc: DxfDocument, rec: DxfRecord, code: number, value: number | null, tx: Tx): void {
  tx.touch(rec);
  const map = new Map<number, number | string>();
  for (const [k, v] of readOverrides(rec)) map.set(k, Number.isFinite(Number(v)) ? Number(v) : v);
  if (value === null) map.delete(code);
  else map.set(code, value);
  if (map.size) ensureAppId(doc, 'ACAD', tx);
  writeDimOverrides(rec, map);
  regenDimension(doc, rec, tx);
}

/** Recompute a dimension's measurement and block graphics after its definition points changed. */
export function regenDimension(doc: DxfDocument, rec: DxfRecord, tx: Tx): boolean {
  tx.touch(rec);
  applyDynamic(doc, rec);
  const geo = buildDimension(doc, rec, dimStyleFor(doc, rec));
  if (!geo) return false;
  rec.set(42, geo.measurement);
  if (geo.def10) rec.setPoint(10, geo.def10);
  if (!(rec.num(70, 0) & 128)) rec.setPoint(11, geo.textMid);
  const blk = doc.block(rec.str(2));
  if (blk && rec.str(2).startsWith('*')) {
    const owner = blk.entities[0]?.owner ?? doc.tableEntry('BLOCK_RECORD', rec.str(2))?.handle;
    adopt(doc, geo.entities, owner);
    tx.touchArray(blk.entities).splice(0, blk.entities.length, ...geo.entities);
  } else {
    rec.set(2, createAnonymousBlock(doc, '*D', geo.entities, tx));
  }
  doc.invalidateHandles();
  return true;
}
