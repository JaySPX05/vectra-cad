import type { DxfDocument } from '../model/database';
import { type Group, group } from '../dxf/groups';
import { DxfRecord } from '../dxf/record';
import { DIM_VARS, type DimVar, VAR_BY_CODE, VAR_BY_NAME } from './vars';

export type VarValue = number | string;

/**
 * A resolved dimension style. `v` holds every variable by name (raw, unscaled, as stored);
 * the short fields are the most used ones, with sizes already multiplied by DIMSCALE.
 */
export interface DimStyle {
  name: string;
  v: Record<string, VarValue>;
  scale: number; // DIMSCALE
  asz: number; // DIMASZ arrow size
  exo: number; // DIMEXO extension line offset from the origin
  exe: number; // DIMEXE extension beyond the dimension line
  txt: number; // DIMTXT text height
  gap: number; // |DIMGAP| gap around text
  dec: number; // DIMDEC decimals
  adec: number; // DIMADEC angular decimals
  lfac: number; // DIMLFAC linear scale factor
  zin: number; // DIMZIN zero suppression
  azin: number; // DIMAZIN
  tad: number; // DIMTAD
  post: string; // DIMPOST prefix/suffix with <>
  textStyle: string; // DIMTXSTY (STYLE name)
}

/** True for metric drawings ($MEASUREMENT = 1 or metric $INSUNITS): ISO-25 style defaults. */
export function isMetric(doc: DxfDocument): boolean {
  const m = doc.headerValue('$MEASUREMENT');
  if (m !== undefined) return Number(m) === 1;
  return [4, 5, 6, 7, 14].includes(doc.headerNum('$INSUNITS', 0));
}

/** Group codes of commonly overridden variables, by name. */
export const DIMVAR = { DIMSCALE: 40, DIMASZ: 41, DIMEXO: 42, DIMEXE: 44, DIMTXT: 140, DIMGAP: 147, DIMDEC: 271, DIMTAD: 77 } as const;

const NAME_KINDS = new Set(['style', 'ltype', 'arrow']);

/** XDATA value group for a variable's override value. */
function xdataGroup(v: DimVar | undefined, value: VarValue): Group {
  if (!v) return typeof value === 'string' ? group(1000, value) : group(1040, value);
  if (NAME_KINDS.has(v.kind)) return group(1005, String(value)); // handle
  if (v.kind === 'string') return group(1000, String(value));
  if (v.kind === 'real' || v.kind === 'dist') return group(1040, Number(value));
  return group(1070, Math.round(Number(value)));
}

/**
 * Per-dimension overrides, stored like AutoCAD as XDATA:
 * 1001 ACAD, 1000 DSTYLE, 1002 {, (1070 <dimvar code>, <value>)*, 1002 }.
 */
export function readDimOverrides(rec: DxfRecord): Map<number, string> {
  const out = new Map<number, string>();
  const gs = rec.groups;
  const i = gs.findIndex((g, k) => g.code === 1000 && g.value.trim().toUpperCase() === 'DSTYLE' && isAcadXdata(gs, k));
  if (i < 0) return out;
  for (let k = i + 2; k + 1 < gs.length && !(gs[k].code === 1002 && gs[k].value.trim() === '}'); k += 2) {
    if (gs[k].code === 1070) out.set(Number(gs[k].value), gs[k + 1].value.trim());
  }
  return out;
}

/** Is group index k inside the ACAD application's XDATA? */
function isAcadXdata(gs: Group[], k: number): boolean {
  for (let j = k; j >= 0; j--) if (gs[j].code === 1001) return gs[j].value.trim().toUpperCase() === 'ACAD';
  return false;
}

/** Replace a dimension's DSTYLE overrides (empty map removes them). Handle variables take handles. */
export function writeDimOverrides(rec: DxfRecord, map: Map<number, VarValue>): void {
  const gs = rec.groups;
  const i = gs.findIndex((g, k) => g.code === 1000 && g.value.trim().toUpperCase() === 'DSTYLE' && isAcadXdata(gs, k));
  if (i >= 0) {
    let end = i + 1;
    while (end < gs.length && !(gs[end].code === 1002 && gs[end].value.trim() === '}')) end++;
    gs.splice(i, end - i + 1);
  }
  let acad = gs.findIndex((g) => g.code === 1001 && g.value.trim().toUpperCase() === 'ACAD');
  if (!map.size) {
    // remove an ACAD app block that is now empty
    if (acad >= 0 && (acad + 1 >= gs.length || gs[acad + 1].code === 1001)) gs.splice(acad, 1);
    return;
  }
  const body: Group[] = [group(1000, 'DSTYLE'), group(1002, '{')];
  for (const [code, v] of [...map].sort((a, b) => a[0] - b[0])) body.push(group(1070, code), xdataGroup(VAR_BY_CODE.get(code), v));
  body.push(group(1002, '}'));
  if (acad < 0) {
    gs.push(group(1001, 'ACAD'));
    acad = gs.length - 1;
  }
  gs.splice(acad + 1, 0, ...body);
}

/** The style a particular dimension uses: its DIMSTYLE plus its own overrides. */
export function dimStyleFor(doc: DxfDocument, rec: DxfRecord): DimStyle {
  return dimStyle(doc, rec.str(3), readDimOverrides(rec));
}

/** Name of the table record a handle points at ('' if unset or missing). */
function nameOf(doc: DxfDocument, handle: string | undefined): string {
  if (!handle || handle.trim() === '0') return '';
  return doc.byHandle(handle.trim())?.str(2) ?? '';
}

/** Normalised arrow name: AutoCAD arrow blocks are stored with any case; '' means closed filled. */
export function arrowName(name: string): string {
  let n = name.trim().toUpperCase();
  // the DIMBLK system variables take built-in names without the underscore ("ARCHTICK" = block _ARCHTICK)
  if (n && !n.startsWith('_') && BUILTIN_ARROWS.has('_' + n)) n = '_' + n;
  return n === '_CLOSEDFILLED' ? '' : n;
}
const BUILTIN_ARROWS = new Set(['_CLOSEDFILLED', '_CLOSEDBLANK', '_CLOSED', '_DOT', '_ARCHTICK', '_OBLIQUE', '_OPEN', '_ORIGIN', '_ORIGIN2',
  '_OPEN90', '_OPEN30', '_DOTSMALL', '_DOTBLANK', '_SMALL', '_BOXBLANK', '_BOXFILLED', '_DATUMBLANK', '_DATUMFILLED', '_INTEGRAL', '_NONE']);

/** Read one variable's raw value from a DIMSTYLE record (or undefined if it isn't stored there). */
export function readStyleVar(doc: DxfDocument, rec: DxfRecord, v: DimVar): VarValue | undefined {
  if (NAME_KINDS.has(v.kind)) {
    if (rec.has(v.code)) {
      const n = nameOf(doc, rec.get(v.code));
      return v.kind === 'arrow' ? arrowName(n) : n;
    }
    if (v.r12code !== undefined && rec.has(v.r12code)) return arrowName(rec.str(v.r12code));
    return undefined;
  }
  if (!rec.has(v.code)) return undefined;
  return v.kind === 'string' ? rec.get(v.code) ?? '' : rec.num(v.code, 0);
}

/** Resolve a dimension style: overrides, DIMSTYLE table entry, header $DIM*, then AutoCAD defaults. */
export function dimStyle(doc: DxfDocument, name?: string, overrides?: Map<number, string>): DimStyle {
  const styleName = name || doc.headerValue('$DIMSTYLE') || 'Standard';
  const rec = doc.tableEntry('DIMSTYLE', styleName);
  const metric = isMetric(doc);
  const v: Record<string, VarValue> = {};
  for (const dv of DIM_VARS) {
    let val: VarValue | undefined;
    const ov = overrides?.get(dv.code);
    if (ov !== undefined) {
      if (NAME_KINDS.has(dv.kind)) val = dv.kind === 'arrow' ? arrowName(nameOf(doc, ov)) : nameOf(doc, ov);
      else val = dv.kind === 'string' ? ov : Number(ov);
      if (typeof val === 'number' && !Number.isFinite(val)) val = undefined;
    }
    if (val === undefined && rec) val = readStyleVar(doc, rec, dv);
    if (val === undefined) {
      // header $DIMxxx (names for handle variables)
      const hv = doc.headerValue('$' + dv.name);
      if (hv !== undefined) val = dv.kind === 'string' || NAME_KINDS.has(dv.kind) ? (dv.kind === 'arrow' ? arrowName(hv) : hv) : Number(hv);
      if (typeof val === 'number' && !Number.isFinite(val)) val = undefined;
    }
    v[dv.name] = val ?? (metric ? dv.met : dv.imp);
  }
  const n = (k: string) => Number(v[k]);
  const scale = n('DIMSCALE') || 1;
  return {
    name: rec?.str(2) || styleName,
    v,
    scale,
    asz: n('DIMASZ') * scale,
    exo: n('DIMEXO') * scale,
    exe: n('DIMEXE') * scale,
    txt: n('DIMTXT') * scale,
    gap: Math.abs(n('DIMGAP')) * scale,
    dec: Math.max(0, Math.min(8, Math.round(n('DIMDEC')))),
    adec: Math.max(0, Math.min(8, Math.round(n('DIMADEC')))),
    lfac: n('DIMLFAC') || 1,
    zin: n('DIMZIN'),
    azin: n('DIMAZIN'),
    tad: n('DIMTAD'),
    post: String(v.DIMPOST ?? ''),
    textStyle: String(v.DIMTXSTY || 'Standard'),
  };
}

/** A style with some variables replaced (used by the dialog's live preview and overrides). */
export function withValues(st: DimStyle, changes: Record<string, VarValue>): DimStyle {
  const v = { ...st.v, ...changes };
  const n = (k: string) => Number(v[k]);
  const scale = n('DIMSCALE') || 1;
  return {
    ...st,
    v,
    scale,
    asz: n('DIMASZ') * scale,
    exo: n('DIMEXO') * scale,
    exe: n('DIMEXE') * scale,
    txt: n('DIMTXT') * scale,
    gap: Math.abs(n('DIMGAP')) * scale,
    dec: Math.max(0, Math.min(8, Math.round(n('DIMDEC')))),
    adec: Math.max(0, Math.min(8, Math.round(n('DIMADEC')))),
    lfac: n('DIMLFAC') || 1,
    zin: n('DIMZIN'),
    azin: n('DIMAZIN'),
    tad: n('DIMTAD'),
    post: String(v.DIMPOST ?? ''),
    textStyle: String(v.DIMTXSTY || 'Standard'),
  };
}

export { VAR_BY_NAME };

// Formatting lives in format.ts; re-exported for existing callers.
export { formatAngle, formatLinear, labelText } from './format';
