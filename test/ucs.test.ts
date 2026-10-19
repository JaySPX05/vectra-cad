import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDxf } from '../src/dxf/parser';
import { writeDxf } from '../src/dxf/writer';
import { Scene } from '../src/render/scene';
import { Editor } from '../src/edit/editor';
import { Ucs, readUcs, writeUcs, saveNamedUcs, namedUcsList, deleteNamedUcs } from '../src/model/ucs';
import { newCircle, newLine, newPolyline, newText } from '../src/edit/create';
import type { Vec3 } from '../src/dxf/record';

const root = join(__dirname, '..', 'public', 'samples');
const fresh = (name = 'basic_entities.dxf') => {
  const doc = parseDxf(new Uint8Array(readFileSync(join(root, name))));
  const scene = new Scene(doc);
  return { doc, scene, ed: new Editor(doc, scene) };
};
const close = (a: number[], b: number[], d = 9) => b.forEach((v, i) => expect(a[i]).toBeCloseTo(v, d));
const props = { layer: '0' };

describe('UCS math', () => {
  const a = Math.PI / 6;
  const ucs = new Ucs([100, 50, 5], [Math.cos(a), Math.sin(a), 0], [-Math.sin(a), Math.cos(a), 0]);

  it('converts both ways', () => {
    const p: Vec3 = [3, -4, 2];
    close(ucs.fromWcs(ucs.toWcs(p)), p);
    close(ucs.toWcs([0, 0]), [100, 50, 5]);
    close(ucs.toWcs([10, 0]), [100 + 10 * Math.cos(a), 50 + 10 * Math.sin(a), 5]);
  });

  it('rotates about its own axes like AutoCAD (right-hand rule)', () => {
    const x90 = Ucs.WORLD.rotated('X', Math.PI / 2);
    close(x90.z, [0, -1, 0]);
    close(x90.y, [0, 0, 1]);
    const z90 = Ucs.WORLD.rotated('Z', Math.PI / 2);
    close(z90.x, [0, 1, 0]);
    const y90 = Ucs.WORLD.rotated('Y', Math.PI / 2);
    close(y90.x, [0, 0, -1]);
    close(y90.z, [1, 0, 0]);
  });

  it('3-point UCS', () => {
    const u = Ucs.threePoint([1, 1, 0], [2, 2, 0], [0, 2, 0])!;
    close(u.x, [Math.SQRT1_2, Math.SQRT1_2, 0]);
    close(u.z, [0, 0, 1]);
    expect(Ucs.threePoint([0, 0, 0], [1, 0, 0], [2, 0, 0])).toBeNull(); // collinear
  });
});

describe('UCS in the drawing', () => {
  it('is saved in the header and *Active viewport, survives save/reload, and undoes', () => {
    const { doc, ed } = fresh();
    expect(readUcs(doc).isWorld).toBe(true);
    const u = new Ucs([10, 20, 0], [0, 1, 0], [-1, 0, 0]);
    ed.history.run('UCS', (tx) => writeUcs(doc, u, tx));
    const back = readUcs(parseDxf(writeDxf(doc)));
    close(back.origin, [10, 20, 0]);
    close(back.x, [0, 1, 0]);
    const vp = parseDxf(writeDxf(doc)).tableEntry('VPORT', '*Active')!;
    close(vp.point(110), [10, 20, 0]);
    ed.undo();
    expect(readUcs(doc).isWorld).toBe(true);
  });

  it('named UCS save / list / delete', () => {
    const { doc, ed } = fresh();
    const u = new Ucs([5, 5, 0]);
    ed.history.run('save', (tx) => saveNamedUcs(doc, 'PART', u, tx));
    const reread = namedUcsList(parseDxf(writeDxf(doc)));
    expect(reread.map((x) => x.name)).toContain('PART');
    close(reread.find((x) => x.name === 'PART')!.origin, [5, 5, 0]);
    ed.history.run('del', (tx) => deleteNamedUcs(doc, 'PART', tx));
    expect(namedUcsList(doc).map((x) => x.name)).not.toContain('PART');
  });

  it('entities drawn in a moved + rotated UCS land at the right WCS place', () => {
    const { doc } = fresh();
    const u = new Ucs([100, 50, 0], [0, 1, 0], [-1, 0, 0]); // X along world +Y
    const line = newLine(doc, [10, 0], [10, 5], props, u);
    close(line.point(10), [100, 60, 0]);
    close(line.point(11), [95, 60, 0]);
    const t = newText(doc, [0, 0], 2.5, 'hi', 0, props, u);
    expect(t.num(50, 0)).toBeCloseTo(90, 9); // text runs along the UCS X axis
  });

  it('planar entities in a vertical UCS get an extrusion and OCS coordinates', () => {
    const { doc, scene, ed } = fresh();
    const u = Ucs.WORLD.rotated('X', Math.PI / 2).withOrigin([0, 7, 0]); // the XZ plane at y = 7
    const c = newCircle(doc, [10, 4], 3, props, u);
    const pl = newPolyline(doc, [[0, 0], [5, 0], [5, 5]], false, props, u);
    close(c.point(210), [0, -1, 0]);
    ed.add([c, pl]);
    for (const rec of [c, pl]) {
      const p3 = scene.geomOf(rec)!.prims3[0];
      if (p3.k !== 'line') throw new Error('expected a line prim');
      for (let i = 1; i < p3.pts.length; i += 3) expect(p3.pts[i]).toBeCloseTo(7, 9); // stays in the plane
    }
    // the circle's centre is UCS (10, 4) -> WCS (10, 7, 4)
    const p3 = scene.geomOf(c)!.prims3[0];
    if (p3.k !== 'line') throw new Error();
    const n = p3.pts.length / 3;
    const mean = [0, 1, 2].map((k) => p3.pts.filter((_, i) => i % 3 === k).reduce((s, v) => s + v, 0) / n);
    close(mean, [10, 7, 4], 6);
  });

  it('MOVE and ROTATE use UCS directions', () => {
    const { doc, ed } = fresh();
    const line = newLine(doc, [0, 0], [10, 0], props);
    ed.add([line]);
    const u = new Ucs([0, 0, 0], [0, 1, 0], [-1, 0, 0]);
    ed.move([line], 5, 0, u); // +5 along UCS X = world +Y
    close(line.point(10), [0, 5, 0]);
    ed.rotate([line], [0, 0], Math.PI / 2, u);
    close(line.point(11), [-5, 10, 0], 6);
  });

  it('ezdxf can read what we write', () => {
    const { doc, ed } = fresh();
    ed.history.run('UCS', (tx) => writeUcs(doc, new Ucs([10, 20, 0], [0, 1, 0], [-1, 0, 0], 'PART'), tx));
    ed.history.run('save', (tx) => saveNamedUcs(doc, 'PART', readUcs(doc), tx));
    const out = join(__dirname, '..', 'test-output');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'ucs_saved.dxf'), writeDxf(doc));
  });
});
