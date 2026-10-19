import { group, type Group } from '../dxf/groups';
import type { DxfRecord } from '../dxf/record';

/**
 * Dynamic label height: the label follows the measured value of its own dimension
 * (length, radius, diameter, arc length or leader length), kept within limits and
 * optionally rounded to a standard text height.
 */
export interface DynText {
  ratio: number; // label height / measured size (0.08 = 8 %)
  min: number;
  max: number;
  round: boolean;
}

export const XDATA_APP = 'CADWEB';
const TAG = 'DYNTXT';

/** Standard text heights per decade (ISO-like series), used for rounding. */
const SERIES = [1, 1.5, 2, 2.5, 3.5, 5, 7];

/** Nearest standard height on a log scale (… 2.5, 3.5, 5, 7, 10 …). */
export function roundToStandard(h: number): number {
  if (!(h > 0)) return h;
  const e = Math.floor(Math.log10(h));
  let best = h, bestD = Infinity;
  for (const k of [e - 1, e, e + 1]) {
    for (const v of SERIES) {
      const c = v * 10 ** k;
      const d = Math.abs(Math.log(c / h));
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
  }
  return +best.toPrecision(6);
}

/** Label height for a dimension whose measured size is `size`. */
export function dynamicHeight(size: number, d: DynText): number {
  let h = Math.min(d.max, Math.max(d.min, size * d.ratio));
  if (d.round) h = roundToStandard(h);
  return h;
}

/** Our settings, stored as XDATA: 1001 CADWEB, 1000 DYNTXT, 1040 ratio, 1040 min, 1040 max, 1070 round. */
export function readDynamic(rec: DxfRecord): DynText | null {
  const gs = rec.groups;
  const a = gs.findIndex((g) => g.code === 1001 && g.value.trim().toUpperCase() === XDATA_APP);
  if (a < 0) return null;
  for (let i = a + 1; i < gs.length && gs[i].code !== 1001; i++) {
    if (gs[i].code === 1000 && gs[i].value.trim().toUpperCase() === TAG) {
      const n = (k: number) => Number(gs[i + k]?.value);
      const d = { ratio: n(1), min: n(2), max: n(3), round: n(4) !== 0 };
      return [d.ratio, d.min, d.max].every(Number.isFinite) && d.ratio > 0 ? d : null;
    }
  }
  return null;
}

/** Store (or with null remove) the dynamic settings; the CADWEB XDATA block is ours alone. */
export function writeDynamic(rec: DxfRecord, d: DynText | null): void {
  const gs = rec.groups;
  const a = gs.findIndex((g) => g.code === 1001 && g.value.trim().toUpperCase() === XDATA_APP);
  if (a >= 0) {
    let end = a + 1;
    while (end < gs.length && gs[end].code !== 1001) end++;
    gs.splice(a, end - a);
  }
  if (!d) return;
  const block: Group[] = [
    group(1001, XDATA_APP), group(1000, TAG),
    group(1040, d.ratio), group(1040, d.min), group(1040, d.max), group(1070, d.round ? 1 : 0),
  ];
  gs.push(...block);
}
