// Dev helper: print per-entity bbox for a DXF. Usage: npx vite-node scripts/inspect_scene.ts <file>
import { readFileSync } from 'node:fs';
import { parseDxf } from '../src/dxf/parser';
import { Scene } from '../src/render/scene';

const scene = new Scene(parseDxf(new Uint8Array(readFileSync(process.argv[2]))));
for (const g of scene.items) {
  console.log(g.rec.type.padEnd(16), (g.rec.handle ?? '').padEnd(6), g.rec.layer.padEnd(12), g.prims.length, g.bbox?.map((v) => +v.toFixed(2)).join(','));
}
