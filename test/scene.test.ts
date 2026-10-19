import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDxf } from '../src/dxf/parser';
import { Scene } from '../src/render/scene';

const root = join(__dirname, '..', 'public', 'samples');
const files = [
  ...readdirSync(root).filter((f) => f.endsWith('.dxf')).map((f) => join(root, f)),
  ...readdirSync(join(root, 'public')).filter((f) => f.endsWith('.dxf')).map((f) => join(root, 'public', f)),
];

describe('scene generation', () => {
  for (const f of files) {
    it(f.split(/[\\/]/).pop()!, () => {
      const doc = parseDxf(new Uint8Array(readFileSync(f)));
      const scene = new Scene(doc);
      const prims = scene.items.reduce((s, g) => s + g.prims.length, 0);
      const ext = scene.extents;
      console.log(f.split(/[\\/]/).pop(), 'entities', scene.items.length, 'prims', prims,
        'extents', ext?.map((v) => +v.toFixed(2)).join(','), 'unsupported', JSON.stringify([...scene.env.unsupported]));
      expect(scene.items.length).toBeGreaterThan(0);
      expect(prims).toBeGreaterThan(0);
      for (const g of scene.items) for (const p of g.prims) {
        if (p.k === 'line') expect(p.pts.every(Number.isFinite)).toBe(true);
      }
    });
  }
});
