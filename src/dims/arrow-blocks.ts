import { type Group, group } from '../dxf/groups';
import { DxfRecord } from '../dxf/record';
import type { DxfBlock, DxfDocument } from '../model/database';
import type { Tx } from '../edit/history';
import { arrowParts } from './arrows';
import { arrowName, type VarValue } from './style';
import type { DimVar } from './vars';

/**
 * An arrowhead block (e.g. _ArchTick) as AutoCAD defines it: unit size, tip at the origin, pointing
 * right with the body toward -X. Created once (BLOCK_RECORD + BLOCK) when a style first uses it.
 */
export function ensureArrowBlock(doc: DxfDocument, name: string, tx: Tx): string | undefined {
  const brTable = doc.table('BLOCK_RECORD');
  const existing = doc.tableEntry('BLOCK_RECORD', name);
  if (existing) return existing.handle;
  if (!brTable || !doc.isModern) return undefined;
  const brh = doc.newHandle();
  tx.touchArray(brTable.entries).push(new DxfRecord('BLOCK_RECORD', [
    group(5, brh), ...(brTable.head.handle ? [group(330, brTable.head.handle)] : []),
    group(100, 'AcDbSymbolTableRecord'), group(100, 'AcDbBlockTableRecord'), group(2, name), group(340, '0'),
  ]));
  const head = (sub: string): Group[] => [group(5, doc.newHandle()), group(330, brh), group(100, 'AcDbEntity'), group(8, '0'), group(100, sub)];
  const ents: DxfRecord[] = [];
  const P = (p: [number, number]): Group[] => [group(10, -p[0]), group(20, p[1]), group(30, 0)];
  const P2 = (code: number, p: [number, number]): Group[] => [group(code, -p[0]), group(code + 10, p[1]), group(code + 20, 0)];
  const ent = (type: string, sub: string, body: Group[]) => {
    const gs = head('AcDbEntity');
    gs.pop();
    gs.push(group(62, 0), group(100, sub), ...body);
    ents.push(new DxfRecord(type, gs));
  };
  for (const a of arrowParts(name)) {
    if (a.k === 'line') ent('LINE', 'AcDbLine', [...P2(10, a.a), ...P2(11, a.b)]);
    else if (a.k === 'circle') ent('CIRCLE', 'AcDbCircle', [...P(a.c), group(40, a.r)]);
    else if (a.k === 'disk') {
      // a filled dot is a closed, wide two-bulge polyline (a donut with no hole)
      const r = a.r / 2, cx = -a.c[0], cy = a.c[1];
      ent('LWPOLYLINE', 'AcDbPolyline', [group(90, 2), group(70, 1), group(43, a.r), group(10, cx - r), group(20, cy), group(42, 1), group(10, cx + r), group(20, cy), group(42, 1)]);
    }
    else if (a.k === 'solid') {
      const [p1, p2, p3, p4 = p3] = a.pts;
      ent('SOLID', 'AcDbTrace', [...P2(10, p1), ...P2(11, p2), ...P2(12, p4), ...P2(13, p3)]);
    } else if (a.k === 'thick') {
      ent('LWPOLYLINE', 'AcDbPolyline', [group(90, 2), group(70, 0), group(43, a.w), group(10, -a.a[0]), group(20, a.a[1]), group(10, -a.b[0]), group(20, a.b[1])]);
    }
  }
  const begin = new DxfRecord('BLOCK', [...head('AcDbBlockBegin'), group(2, name), group(70, 0), group(10, 0), group(20, 0), group(30, 0), group(3, name), group(1, '')]);
  const end = new DxfRecord('ENDBLK', head('AcDbBlockEnd'));
  tx.touchArray(doc.blocks).push({ begin, entities: ents, end } as DxfBlock);
  tx.global = true;
  doc.invalidateHandles();
  return brh;
}

/** Display name of an arrow block as AutoCAD writes it (_ArchTick, _Dot …). */
export const ARROW_BLOCK_NAMES: Record<string, string> = {
  _CLOSEDBLANK: '_ClosedBlank', _CLOSED: '_Closed', _DOT: '_Dot', _ARCHTICK: '_ArchTick', _OBLIQUE: '_Oblique',
  _OPEN: '_Open', _ORIGIN: '_Origin', _ORIGIN2: '_Origin2', _OPEN90: '_Open90', _OPEN30: '_Open30',
  _DOTSMALL: '_DotSmall', _DOTBLANK: '_DotBlank', _SMALL: '_Small', _BOXBLANK: '_BoxBlank', _BOXFILLED: '_BoxFilled',
  _DATUMBLANK: '_DatumBlank', _DATUMFILLED: '_DatumFilled', _INTEGRAL: '_Integral', _NONE: '_None',
};

/**
 * Handle of the named object a handle-type variable refers to (text style, linetype, arrow block),
 * creating a missing arrow block when `tx` is given. Undefined if it can't be stored as a handle.
 */
export function nameHandle(doc: DxfDocument, v: DimVar, value: VarValue, tx?: Tx): string | undefined {
  if (!doc.isModern) return undefined;
  const name = String(value ?? '');
  if (v.kind === 'style') return doc.tableEntry('STYLE', name || 'Standard')?.handle;
  if (v.kind === 'ltype') return name && !/^by(block|layer)$/i.test(name) ? doc.tableEntry('LTYPE', name)?.handle : undefined;
  if (v.kind === 'arrow') {
    const a = arrowName(name);
    if (!a) return undefined;
    const block = ARROW_BLOCK_NAMES[a] ?? a;
    return tx ? ensureArrowBlock(doc, block, tx) : doc.tableEntry('BLOCK_RECORD', block)?.handle;
  }
  return undefined;
}
