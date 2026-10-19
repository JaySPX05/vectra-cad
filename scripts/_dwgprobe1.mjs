import { readFileSync, writeFileSync } from 'node:fs';
import { LibreDwg } from '@mlightcad/libredwg-web';
const [file] = process.argv.slice(2);
const lib = await LibreDwg.create('./node_modules/@mlightcad/libredwg-web/wasm');
const buf = readFileSync(file);
const t0 = Date.now();
try {
  const dxf = lib.dwg_write_dxf(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  console.log(file.split('/').pop(), dxf ? `dxf ${dxf.length} bytes ${Date.now() - t0} ms` : 'null');
  if (dxf) writeFileSync(file + '.dxf', dxf);
} catch (e) { console.log(file.split('/').pop(), 'FAILED', e.message); }
