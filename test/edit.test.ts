import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDxf } from '../src/dxf/parser';
import { writeDxf } from '../src/dxf/writer';
import { Scene } from '../src/render/scene';
import { Editor } from '../src/edit/editor';
import { similarity, canTransform } from '../src/edit/transform';
import { apply, ocsAxes } from '../src/geom/ocs';
import { bulgePoints } from '../src/geom/tessellate';
import { ACI_RGB } from '../src/model/aci';
import { newLine, newCircle, newPolyline, newText } from '../src/edit/create';
import type { Prim } from '../src/render/prims';

const root = join(__dirname, '..', 'public', 'samples');
const load = (name: string) => parseDxf(new Uint8Array(readFileSync(join(root, name))));

describe('geometry math', () => {
  it('arbitrary axis algorithm matches the DXF reference cases', () => {
    const [ax, ay] = ocsAxes([0, 0, -1]);
    expect(ax.map((v) => +v.toFixed(12))).toEqual([-1, 0, 0]);
    expect(ay.map((v) => +v.toFixed(12))).toEqual([0, 1, 0]);
    const [bx] = ocsAxes([1, 0, 0]);
    expect(bx.map((v) => +v.toFixed(12))).toEqual([0, 1, 0]);
  });
  it('bulge 1 is a counter-clockwise semicircle', () => {
    const pts = bulgePoints([0, 0, 0], [2, 0, 0], 1);
    const mid = pts[Math.floor(pts.length / 2) - 1];
    expect(Math.hypot(mid[0] - 1, mid[1])).toBeCloseTo(1, 6);
    expect(mid[1]).toBeLessThan(0); // CCW from (0,0) to (2,0) passes below the chord
  });
  it('ACI table landmarks', () => {
    expect(ACI_RGB[1]).toBe(0xff0000);
    expect(ACI_RGB[10]).toBe(0xff0000);
    expect(ACI_RGB[11]).toBe(0xff7f7f);
    expect(ACI_RGB[20]).toBe(0xff3f00);
    expect(ACI_RGB[250]).toBe(0x333333);
  });
});

/** Flatten a primitive to comparable world points. */
function primPoints(p: Prim): number[] {
  switch (p.k) {
    case 'line': return p.pts;
    case 'fill': case 'pattern': return p.rings.flat();
    case 'text': return [p.m[4], p.m[5], p.m[4] + p.m[0] * p.w, p.m[5] + p.m[1] * p.w];
    case 'point': return [p.x, p.y];
    case 'xline': return [p.x, p.y];
    case 'face': return p.pts;
  }
}

describe('transforms agree with the renderer', () => {
  const t = similarity({ dx: 13.5, dy: -7.25, angle: 0.6, scale: 1.7, base: [5, 5] });
  const files = readdirSync(root).filter((f) => f.endsWith('.dxf') && !f.startsWith('stress'));
  for (const f of files) {
    it(f, () => {
      const doc = load(f);
      const scene = new Scene(doc);
      const before = new Map(scene.items.map((g) => [g.rec, g.prims.map(primPoints)]));
      const editor = new Editor(doc, scene);
      const recs = scene.items.map((g) => g.rec).filter(canTransform);
      const { skipped } = editor.transform('t', recs, t);
      expect(skipped).toEqual([]);
      let checked = 0;
      for (const g of scene.items) {
        const b = before.get(g.rec)!;
        expect(g.prims.length, `${g.rec.type} ${g.rec.handle} prim count`).toBe(b.length);
        g.prims.forEach((p, i) => {
          // a thick circle's wall faces follow its tessellation, which restarts at angle 0 after rotation
          if (p.k === 'face' && g.rec.type === 'CIRCLE') return;
          const after = primPoints(p);
          const exp = b[i];
          // text width depends on measured glyphs; compare just the anchor for text
          // text width depends on glyph metrics, and LEADER arrow size comes from DIMASZ, not geometry
          const n = p.k === 'text' || (g.rec.type === 'LEADER' && p.k === 'fill') ? 2 : exp.length;
          expect(after.length, `${g.rec.type} ${g.rec.handle}`).toBe(exp.length);
          if (p.k === 'line' && p.closed) {
            // closed curves may legitimately start elsewhere (new OCS axes): compare centroid + extent
            const c = (a: number[]) => { let x = 0, y = 0; for (let k = 0; k < a.length; k += 2) { x += a[k]; y += a[k + 1]; } return [x / (a.length / 2), y / (a.length / 2)]; };
            const [ex, ey] = c(exp), [ax, ay] = c(after);
            const q = apply(t.m, [ex, ey, 0]);
            expect(ax).toBeCloseTo(q[0], 4);
            expect(ay).toBeCloseTo(q[1], 4);
            checked++;
            return;
          }
          for (let k = 0; k < n; k += 2) {
            const q = apply(t.m, [exp[k], exp[k + 1], 0]);
            expect(after[k], `${g.rec.type} ${g.rec.handle} x[${k}]`).toBeCloseTo(q[0], 5);
            expect(after[k + 1], `${g.rec.type} ${g.rec.handle} y[${k}]`).toBeCloseTo(q[1], 5);
          }
          checked++;
        });
      }
      expect(checked).toBeGreaterThan(0);
      // undo restores exact text
      const original = writeDxf(load(f));
      editor.undo();
      expect(writeDxf(doc)).toBe(original);
    });
  }
});

describe('editing round-trip', () => {
  for (const f of ['basic_entities.dxf', 'r12_legacy.dxf', 'blocks_inserts.dxf', 'dimensions_leaders.dxf']) {
    it(`draw, copy, erase on ${f}`, () => {
      const doc = load(f);
      const scene = new Scene(doc);
      const ed = new Editor(doc, scene);
      const n0 = scene.items.length;
      const props = { layer: 'NEWLAYER', color: 3 };
      ed.add([
        newLine(doc, [0, 0], [10, 10], props),
        newCircle(doc, [5, 5], 3, props),
        newPolyline(doc, [[0, 0], [5, 0], [5, 5]], true, props),
        newText(doc, [0, 20], 2.5, 'Hello Ä', 0, props),
      ]);
      expect(scene.items.length).toBe(n0 + 4);
      const copies = ed.copy(scene.items.slice(0, 5).map((g) => g.rec), 100, 0);
      expect(copies.length).toBeGreaterThan(0);
      expect(scene.items.length).toBe(n0 + 4 + copies.length);
      ed.setGroup([copies[0]], 8, 'NEWLAYER');
      expect(doc.layer('NEWLAYER')).toBeTruthy();
      ed.erase([scene.items[0].rec]);
      expect(scene.items.length).toBe(n0 + 3 + copies.length);
      // handles unique
      const hs = [...doc.allRecords()].map((r) => r.handle).filter(Boolean);
      expect(new Set(hs).size).toBe(hs.length);
      // output re-parses identically
      const out = writeDxf(doc);
      expect(writeDxf(parseDxf(out))).toBe(out);
      // full undo
      while (ed.undo());
      expect(scene.items.length).toBe(n0);
    });
  }
});

describe('write edited files for external validation', () => {
  it('writes test-output/*.dxf', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const outDir = join(__dirname, '..', 'test-output');
    mkdirSync(outDir, { recursive: true });
    for (const f of [...readdirSync(root).filter((x) => x.endsWith('.dxf') && !x.startsWith('stress')), 'public/example_2000.dxf']) {
      const doc = load(f);
      const scene = new Scene(doc);
      const ed = new Editor(doc, scene);
      const recs = scene.items.map((g) => g.rec);
      ed.copy(recs.filter(canTransform), 0, -500);
      ed.rotate(recs.slice(0, Math.ceil(recs.length / 2)), [0, 0], 0.3);
      ed.scale(recs.slice(Math.ceil(recs.length / 2)), [10, 10], 1.25);
      ed.add([newLine(doc, [0, 0], [1, 1], { layer: 'EDITED', color: 1 }), newPolyline(doc, [[0, 0], [3, 0], [3, 3]], false, { layer: 'EDITED' })]);
      ed.erase([recs[0]]);
      writeFileSync(join(outDir, 'edited_' + f.replace(/.*[\/]/, '')), writeDxf(doc));
    }
  });
});
