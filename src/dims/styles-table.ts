import { type Group, group } from '../dxf/groups';
import { DxfRecord } from '../dxf/record';
import type { DxfDocument } from '../model/database';
import type { Tx } from '../edit/history';
import { setHeaderGroups } from '../model/ucs';
import { nameHandle } from './arrow-blocks';
import { ensureAppId, regenDimension } from './create';
import { arrowName, dimStyle, type VarValue } from './style';
import { DIM_VARS, type DimVar } from './vars';

/**
 * The DIMSTYLE table: list, read, write, create, rename, delete, set current, compare.
 * Writes follow the file's DXF version (variables newer than the file are not written) and
 * keep handles valid (text style, linetypes and arrow blocks are stored as handles in R2000+).
 */

/** Variables kept in our own XDATA on the style: DIMTFILLCLR's code 70 collides with the record flags. */
const XDATA_VARS = new Set(['DIMTFILL', 'DIMTFILLCLR']);
const XAPP = 'CADWEB';

export function listStyles(doc: DxfDocument): string[] {
  return (doc.table('DIMSTYLE')?.entries ?? []).map((e) => e.str(2)).filter(Boolean);
}

export function currentStyle(doc: DxfDocument): string {
  return dimStyle(doc).name;
}

/** Styles used by dimensions/leaders anywhere in the drawing, plus the current one. */
export function stylesInUse(doc: DxfDocument): Set<string> {
  const used = new Set<string>([currentStyle(doc).toUpperCase()]);
  const scan = (list: DxfRecord[]) => {
    for (const e of list) if (e.type.endsWith('DIMENSION') || e.type === 'LEADER' || e.type === 'TOLERANCE') used.add(e.str(3, 'Standard').toUpperCase());
  };
  scan(doc.entities);
  for (const b of doc.blocks) scan(b.entities);
  return used;
}

/** Can this file store the variable? (R12 has no handle-based or later variables.) */
export function supported(doc: DxfDocument, v: DimVar): boolean {
  return doc.version >= v.since;
}

/** Every variable of a style, resolved (stored value, header or AutoCAD default). */
export function readStyle(doc: DxfDocument, name: string): Record<string, VarValue> {
  const st = dimStyle(doc, name);
  const rec = doc.tableEntry('DIMSTYLE', name);
  const v = { ...st.v };
  if (rec) for (const k of XDATA_VARS) {
    const x = readXdataVar(rec, k);
    if (x !== undefined) v[k] = x;
  }
  return v;
}

function readXdataVar(rec: DxfRecord, name: string): number | undefined {
  const gs = rec.groups;
  const a = gs.findIndex((g) => g.code === 1001 && g.value.trim() === XAPP);
  if (a < 0) return undefined;
  for (let i = a + 1; i < gs.length && gs[i].code !== 1001; i++) {
    if (gs[i].code === 1000 && gs[i].value.trim() === name) return Number(gs[i + 1]?.value);
  }
  return undefined;
}

function writeXdataVars(rec: DxfRecord, vals: Record<string, number>) {
  const gs = rec.groups;
  const a = gs.findIndex((g) => g.code === 1001 && g.value.trim() === XAPP);
  if (a >= 0) {
    let end = a + 1;
    while (end < gs.length && gs[end].code !== 1001) end++;
    gs.splice(a, end - a);
  }
  const entries = Object.entries(vals).filter(([, v]) => v);
  if (!entries.length) return;
  gs.push(group(1001, XAPP), ...entries.flatMap(([k, v]) => [group(1000, k), group(1070, v)]));
}

// ---- handles for named objects -----------------------------------------------------------------
// ---- writing ---------------------------------------------------------------------------------------
/** Groups for one variable in a DIMSTYLE record (empty = leave unset / default). */
function varGroups(doc: DxfDocument, v: DimVar, value: VarValue, tx: Tx): Group[] {
  switch (v.kind) {
    case 'style':
    case 'ltype':
    case 'arrow': {
      if (!doc.isModern) {
        const name = v.kind === 'arrow' ? arrowName(String(value)) : '';
        return name && v.r12code ? [group(v.r12code, name)] : [];
      }
      const h = nameHandle(doc, v, value, tx);
      return h ? [group(v.code, h)] : [];
    }
    case 'string':
      return [group(v.code, String(value ?? ''))];
    default:
      return [group(v.code, Number(value))];
  }
}

/** Codes a DIMSTYLE record may use for variables (including R12 arrow strings). */
const VAR_CODES = new Set(DIM_VARS.flatMap((v) => (v.r12code ? [v.code, v.r12code] : [v.code])));

/** Write all variables to a style (created if missing). Only codes the file version supports are written. */
export function writeStyle(doc: DxfDocument, name: string, values: Record<string, VarValue>, tx: Tx): DxfRecord {
  let rec = doc.tableEntry('DIMSTYLE', name);
  if (!rec) rec = newStyleRecord(doc, name, tx);
  tx.touch(rec);
  tx.global = true;
  // keep head (handle, owner, markers, name, flags) and anything unknown; replace variable groups
  const gs = rec.groups;
  const flagsAt = gs.findIndex((g) => g.code === 70);
  const head = gs.slice(0, flagsAt + 1);
  const rest = gs.slice(flagsAt + 1);
  const xStart = rest.findIndex((g) => g.code >= 1000);
  const tail = xStart >= 0 ? rest.slice(xStart) : [];
  const keep = (xStart >= 0 ? rest.slice(0, xStart) : rest).filter((g) => !VAR_CODES.has(g.code));
  const vars: Group[] = [];
  for (const v of DIM_VARS) {
    if (XDATA_VARS.has(v.name) || !supported(doc, v)) continue;
    if (values[v.name] === undefined) continue;
    vars.push(...varGroups(doc, v, values[v.name], tx));
  }
  vars.sort((a, b) => a.code - b.code);
  rec.groups = [...head, ...keep, ...vars, ...tail];
  // the fill settings (see XDATA_VARS) go in our XDATA
  const fill = { DIMTFILL: Number(values.DIMTFILL) || 0, DIMTFILLCLR: Number(values.DIMTFILLCLR) || 0 };
  if (fill.DIMTFILL || fill.DIMTFILLCLR || readXdataVar(rec, 'DIMTFILL') !== undefined) {
    ensureAppId(doc, XAPP, tx);
    writeXdataVars(rec, fill);
  }
  doc.invalidateHandles();
  return rec;
}

function newStyleRecord(doc: DxfDocument, name: string, tx: Tx): DxfRecord {
  const table = doc.table('DIMSTYLE');
  if (!table) throw new Error('This drawing has no DIMSTYLE table.');
  const gs: Group[] = [];
  if (doc.usesHandles) gs.push(group(105, doc.newHandle()));
  if (doc.isModern) {
    if (table.head.handle) gs.push(group(330, table.head.handle));
    gs.push(group(100, 'AcDbSymbolTableRecord'), group(100, 'AcDbDimStyleTableRecord'));
  }
  gs.push(group(2, name), group(70, 0));
  const rec = new DxfRecord('DIMSTYLE', gs);
  tx.touchArray(table.entries).push(rec);
  doc.invalidateHandles();
  return rec;
}

/** New style: a copy of `base` (all its values) under a new name. */
export function createStyle(doc: DxfDocument, name: string, base: string, tx: Tx, changes: Record<string, VarValue> = {}): DxfRecord {
  if (!name.trim() || /[<>/\\":;?*|=`]/.test(name)) throw new Error(`"${name}" is not a valid style name.`);
  if (doc.tableEntry('DIMSTYLE', name)) throw new Error(`A dimension style named "${name}" already exists.`);
  return writeStyle(doc, name, { ...readStyle(doc, base), ...changes }, tx);
}

/** Rename a style and every reference to it (dimensions, leaders, $DIMSTYLE). */
export function renameStyle(doc: DxfDocument, from: string, to: string, tx: Tx): void {
  const rec = doc.tableEntry('DIMSTYLE', from);
  if (!rec) throw new Error(`No dimension style "${from}".`);
  if (/^standard$/i.test(from)) throw new Error('The Standard style cannot be renamed.');
  if (doc.tableEntry('DIMSTYLE', to)) throw new Error(`A dimension style named "${to}" already exists.`);
  tx.touch(rec);
  rec.set(2, to);
  const fix = (list: DxfRecord[]) => {
    for (const e of list) {
      if ((e.type.endsWith('DIMENSION') || e.type === 'LEADER' || e.type === 'TOLERANCE') && e.str(3).toUpperCase() === from.toUpperCase()) {
        tx.touch(e);
        e.set(3, to);
      }
    }
  };
  fix(doc.entities);
  for (const b of doc.blocks) fix(b.entities);
  if ((doc.headerValue('$DIMSTYLE') ?? '').toUpperCase() === from.toUpperCase()) setCurrent(doc, to, tx);
  tx.global = true;
}

/** Delete an unused style (AutoCAD refuses styles in use, the current one and Standard). */
export function deleteStyle(doc: DxfDocument, name: string, tx: Tx): void {
  const table = doc.table('DIMSTYLE');
  const rec = doc.tableEntry('DIMSTYLE', name);
  if (!table || !rec) throw new Error(`No dimension style "${name}".`);
  if (/^standard$/i.test(name)) throw new Error('The Standard style cannot be deleted.');
  if (stylesInUse(doc).has(name.toUpperCase())) throw new Error(`"${name}" is current or in use and cannot be deleted.`);
  const arr = tx.touchArray(table.entries);
  arr.splice(arr.indexOf(rec), 1);
  tx.global = true;
  doc.invalidateHandles();
}

/** Make a style current ($DIMSTYLE), so new dimensions use it. */
export function setCurrent(doc: DxfDocument, name: string, tx: Tx): void {
  setHeaderGroups(doc, '$DIMSTYLE', [group(2, name)], tx);
}

/** Regenerate every dimension that uses `name` (after its settings changed). Returns the count. */
export function regenStyle(doc: DxfDocument, name: string, tx: Tx): number {
  let n = 0;
  for (const e of doc.entities) {
    if (e.type === 'DIMENSION' && e.str(3, 'Standard').toUpperCase() === name.toUpperCase() && regenDimension(doc, e, tx)) n++;
  }
  for (const b of doc.blocks) {
    if (b.begin.str(2).startsWith('*')) continue;
    for (const e of b.entities) if (e.type === 'DIMENSION' && e.str(3, 'Standard').toUpperCase() === name.toUpperCase() && regenDimension(doc, e, tx)) n++;
  }
  return n;
}

/** Variables whose values differ between two styles (AutoCAD's Compare dialog). */
export function compareStyles(doc: DxfDocument, a: string, b: string): { name: string; label: string; a: VarValue; b: VarValue }[] {
  const va = readStyle(doc, a), vb = readStyle(doc, b);
  const same = (x: VarValue, y: VarValue) => (typeof x === 'number' && typeof y === 'number' ? Math.abs(x - y) < 1e-9 : String(x).toUpperCase() === String(y).toUpperCase());
  return DIM_VARS.filter((v) => !same(va[v.name], vb[v.name])).map((v) => ({ name: v.name, label: v.label, a: va[v.name], b: vb[v.name] }));
}
