import { type Group, valueType } from './groups';
import type { DxfRecord } from './record';
import type { DxfDocument } from '../model/database';

/**
 * Serialize a document back to ASCII DXF. Section, record and group order is kept exactly;
 * only values that were edited differ from the input.
 */
export function writeDxf(doc: DxfDocument): string {
  const unicodeEscapes = doc.version < 'AC1021'; // pre-2007 files are ANSI; escape non-ASCII
  const out: string[] = [];
  const put = (code: number, value: string) => {
    let v = value.replace(/[\r\n]/g, ' ');
    if (unicodeEscapes && valueType(code) === 'string') {
      v = v.replace(/[^\x00-\x7f]/g, (c) => '\\U+' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'));
    }
    out.push(String(code).padStart(3, ' '), v);
  };
  const groups = (gs: Group[]) => {
    for (const g of gs) put(g.code, g.value);
  };
  const rec = (r: DxfRecord) => {
    put(0, r.type);
    groups(r.groups);
    for (const c of r.children) rec(c);
    if (r.seqend) rec(r.seqend);
  };

  for (const s of doc.sections) {
    put(0, 'SECTION');
    put(2, s.name);
    switch (s.kind) {
      case 'header':
        for (const v of s.vars) {
          put(9, v.name);
          groups(v.groups);
        }
        break;
      case 'classes':
      case 'objects':
        s.records.forEach(rec);
        break;
      case 'tables':
        for (const t of s.tables) {
          rec(t.head);
          t.entries.forEach(rec);
          rec(t.end);
        }
        break;
      case 'blocks':
        for (const b of s.blocks) {
          rec(b.begin);
          b.entities.forEach(rec);
          rec(b.end);
        }
        break;
      case 'entities':
        s.entities.forEach(rec);
        break;
      case 'raw':
        groups(s.groups);
        break;
    }
    put(0, 'ENDSEC');
  }
  put(0, 'EOF');
  return out.join('\r\n') + '\r\n';
}
