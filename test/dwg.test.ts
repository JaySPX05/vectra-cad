import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LibreDwg } from '@mlightcad/libredwg-web';
import { convertWithLibreDwg, dwgVersion, DwgError, repairLibreDwgDxf } from '../src/dwg/libredwg';
import { parseDxf } from '../src/dxf/parser';
import { writeDxf } from '../src/dxf/writer';
import { Scene } from '../src/render/scene';

const samples = join(__dirname, '..', 'public', 'samples', 'public');
const wasmDir = join(__dirname, '..', 'node_modules', '@mlightcad', 'libredwg-web', 'wasm');
// a fresh LibreDWG instance per conversion, as the app's worker does
const convert = async (bytes: Uint8Array) => convertWithLibreDwg(await LibreDwg.create(wasmDir), bytes);

describe('DWG via LibreDWG', () => {
  it('recognises DWG headers', () => {
    expect(dwgVersion(new Uint8Array(readFileSync(join(samples, 'example_2018.dwg'))))).toBe('AC1032');
    expect(dwgVersion(new TextEncoder().encode('  0\r\nSECTION'))).toBeNull();
  });

  for (const [file, ver] of [['example_2018.dwg', 'AC1032'], ['example_2004.dwg', 'AC1018']] as const) {
    it(`opens ${file} like AutoCAD's own DXF of the same drawing`, async () => {
      const dxf = await convert(new Uint8Array(readFileSync(join(samples, file))));
      const doc = parseDxf(dxf);
      expect(doc.version).toBe(ver);
      // 2010+ tables come out as empty records; they're removed and counted
      expect(repairLibreDwgDxf(doc).emptyTables).toBe(ver >= 'AC1024' ? 1 : 0);
      expect(doc.entities.some((e) => e.type === 'ACAD_TABLE' && !e.groups.length)).toBe(false);
      const scene = new Scene(doc);
      const reference = new Scene(parseDxf(new Uint8Array(readFileSync(join(samples, 'example_2018.dxf')))));
      const handles = new Set(scene.items.map((g) => g.rec.handle));
      // every entity AutoCAD exported is present, except LibreDWG's known TABLE gap for 2010+ files
      const missing = reference.items.filter((g) => !handles.has(g.rec.handle)).map((g) => g.rec.type);
      expect(missing.filter((t) => t !== 'ACAD_TABLE')).toEqual([]);
      expect(scene.items.reduce((a, g) => a + g.prims.length, 0)).toBeGreaterThan(200);
      const out = writeDxf(doc);
      expect(writeDxf(parseDxf(out))).toBe(out);
    }, 60000);
  }

  it('reports files it cannot read', async () => {
    await expect(convert(new TextEncoder().encode('not a drawing at all'))).rejects.toBeInstanceOf(DwgError);
    await expect(convert(new TextEncoder().encode('AC1009 old R12 dwg'))).rejects.toThrow(/pre-R13/);
  });
});
