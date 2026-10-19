import type { DxfRecord } from '../dxf/record';
import type { DxfDocument } from './database';
import type { Tx } from '../edit/history';

export const ROMANS_FILE = 'romans.shx';

/** MTEXT inline font switches: \fFamily|b1|i0...; and \Ffile.shx; (not an escaped "\\f"). */
const FONT_CODES = /(?<!\\)\\[fF][^;]*;/g;
const HAS_FONT_CODE = /(?<!\\)\\[fF][^;]*;/;

/** Remove the ACAD application XDATA (TrueType family name and flags) from a STYLE entry. */
function dropTrueTypeXdata(r: DxfRecord): boolean {
  const gs = r.groups;
  const i = gs.findIndex((g) => g.code === 1001 && g.value.trim().toUpperCase() === 'ACAD');
  if (i < 0) return false;
  let end = i + 1;
  while (end < gs.length && gs[end].code !== 1001) end++;
  gs.splice(i, end - i);
  return true;
}

/**
 * Make every text style use Roman Simplex (romans.shx), like changing each style's font in
 * AutoCAD's STYLE dialog, and drop MTEXT inline font switches so paragraphs follow their style.
 * Shape-file styles (flag 1) are left alone. Returns what changed.
 */
export function convertToRomans(doc: DxfDocument, tx: Tx): { styles: number; mtext: number } {
  let styles = 0;
  let mtext = 0;
  for (const st of doc.table('STYLE')?.entries ?? []) {
    if (st.num(70, 0) & 1) continue; // shape file, not a text font
    const hasTtf = st.groups.some((g) => g.code === 1001 && g.value.trim().toUpperCase() === 'ACAD');
    if (st.str(3).toLowerCase() === ROMANS_FILE && !hasTtf) continue;
    tx.touch(st);
    st.set(3, ROMANS_FILE);
    dropTrueTypeXdata(st);
    styles++;
  }
  for (const r of doc.allRecords()) {
    if (r.type !== 'MTEXT') continue;
    if (!r.groups.some((g) => (g.code === 1 || g.code === 3) && HAS_FONT_CODE.test(g.value))) continue;
    tx.touch(r);
    for (const g of r.groups) if (g.code === 1 || g.code === 3) g.value = g.value.replace(FONT_CODES, '');
    mtext++;
  }
  if (styles || mtext) tx.global = true;
  return { styles, mtext };
}
