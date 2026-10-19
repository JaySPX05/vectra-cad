import type { LibreDwgEx } from '@mlightcad/libredwg-web';
import type { DxfRecord } from '../dxf/record';
import type { DxfDocument } from '../model/database';

/** DWG version strings (file header) and their releases. */
export const DWG_VERSIONS: Record<string, string> = {
  AC1012: 'R13', AC1014: 'R14', AC1015: 'AutoCAD 2000', AC1018: 'AutoCAD 2004', AC1021: 'AutoCAD 2007',
  AC1024: 'AutoCAD 2010', AC1027: 'AutoCAD 2013', AC1032: 'AutoCAD 2018',
};

/** The 6-byte version tag every DWG starts with (e.g. "AC1032"), or null if this isn't a DWG. */
export function dwgVersion(bytes: Uint8Array): string | null {
  if (bytes.length < 6) return null;
  const tag = String.fromCharCode(...bytes.subarray(0, 6));
  return /^AC1\d{3}$/.test(tag) ? tag : null;
}

export class DwgError extends Error {}

/**
 * Convert DWG bytes to DXF bytes with LibreDWG (GPL-3, compiled to WebAssembly). The DXF keeps
 * the DWG's version, so the rest of the app reads it like any DXF file.
 */
export function convertWithLibreDwg(lib: LibreDwgEx, bytes: Uint8Array): Uint8Array {
  const ver = dwgVersion(bytes);
  if (!ver) throw new DwgError('This is not a DWG file (no AC10xx version header).');
  if (ver < 'AC1012') throw new DwgError(`${ver} (pre-R13) DWG files are not supported; save them in a newer version first.`);
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  let out: Uint8Array | null;
  try {
    out = lib.dwg_write_dxf(ab);
  } catch (e) {
    throw new DwgError(`LibreDWG could not read this ${DWG_VERSIONS[ver] ?? ver} drawing (${(e as Error).message}).`);
  }
  if (!out || out.length < 20) throw new DwgError(`LibreDWG could not convert this ${DWG_VERSIONS[ver] ?? ver} drawing.`);
  return out;
}

/**
 * Tidy known LibreDWG output gaps. For AutoCAD 2010+ files it writes tables as empty
 * "ACAD_TABLE" records (no groups, no owner); those carry no data, so they're dropped and
 * counted so the user can be told. Everything else is kept as converted.
 */
export function repairLibreDwgDxf(doc: DxfDocument): { emptyTables: number } {
  let emptyTables = 0;
  const prune = (list: DxfRecord[]) => {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].type === 'ACAD_TABLE' && list[i].groups.length === 0) {
        list.splice(i, 1);
        emptyTables++;
      }
    }
  };
  prune(doc.entities);
  for (const b of doc.blocks) prune(b.entities);
  return { emptyTables };
}
