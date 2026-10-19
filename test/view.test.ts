import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDxf } from '../src/dxf/parser';
import { Scene } from '../src/render/scene';
import { Editor } from '../src/edit/editor';
import { similarity } from '../src/edit/transform';
import { writeDxf } from '../src/dxf/writer';
import { isTopView, orbitDir, PRESET_VIEWS, project, rayToPlaneZ, viewFromVport, viewRotation } from '../src/geom/view';
import { IDENTITY } from '../src/geom/ocs';
import type { Vec3 } from '../src/dxf/record';

const root = join(__dirname, '..', 'public', 'samples');
const load = (name: string) => parseDxf(new Uint8Array(readFileSync(join(root, name))));
const close = (a: number[], b: number[], d = 9) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], d));
const view = (name: string) => PRESET_VIEWS.find((v) => v.name === name)!.dir;

describe('view math', () => {
  it('top view is the identity, so plan output is unchanged', () => {
    expect(viewRotation([0, 0, 1])).toEqual(IDENTITY);
    expect(isTopView(viewRotation([0, 0, 1]))).toBe(true);
  });

  it('SW isometric: X goes right-up, Y left-up, Z straight up', () => {
    // looking from the south-west, east (+X) and north (+Y) both recede, so they rise on screen
    const r = viewRotation(view('SW Isometric'));
    const s2 = Math.SQRT1_2, s6 = 1 / Math.sqrt(6);
    close(project(r, [1, 0, 0]).slice(0, 2), [s2, s6]);
    close(project(r, [0, 1, 0]).slice(0, 2), [-s2, s6]);
    close(project(r, [0, 0, 1]).slice(0, 2), [0, Math.sqrt(2 / 3)]);
    // camera z points at the viewer: the eye is on the (-1,-1,1) side
    expect(project(r, [-1, -1, 1])[2]).toBeGreaterThan(0);
  });

  it('front view: X right, Z up', () => {
    const r = viewRotation(view('Front'));
    close(project(r, [1, 0, 0]).slice(0, 2), [1, 0]);
    close(project(r, [0, 0, 1]).slice(0, 2), [0, 1]);
  });

  it('a click maps back to the same point on the working plane', () => {
    const r = viewRotation(view('NE Isometric'));
    const p: Vec3 = [3.5, -7.25, 4];
    const c = project(r, p);
    close(rayToPlaneZ(r, c[0], c[1], 4)!, p);
    expect(rayToPlaneZ(viewRotation(view('Front')), 0, 0, 0)).toBeNull(); // edge-on
  });

  it('orbiting never flips over the poles', () => {
    let d: Vec3 = [0, 0, 1];
    for (let i = 0; i < 50; i++) d = orbitDir(d, 0.1, 0.2);
    expect(d[2]).toBeLessThan(1);
    expect(Math.hypot(...d)).toBeCloseTo(1, 12);
  });
});

describe('3D drawings', () => {
  it('house_3d opens in its saved SW isometric view and draws everything', () => {
    const doc = load('house_3d.dxf');
    const v = viewFromVport(doc)!;
    close(v.dir, [-1 / Math.sqrt(3), -1 / Math.sqrt(3), 1 / Math.sqrt(3)]);
    const scene = new Scene(doc);
    scene.setView(viewRotation(v.dir));
    expect([...scene.env.unsupported]).toEqual([]);
    const mesh = scene.items.find((g) => g.rec.type === 'MESH')!;
    expect(mesh.prims3.filter((p) => p.k === 'face')).toHaveLength(6);
    const roof = scene.items.find((g) => g.rec.type === 'POLYLINE')!;
    expect(roof.prims3.filter((p) => p.k === 'face')).toHaveLength(4);
    // thickness: each fence line gets a top copy, 2 verticals and a wall face
    const fence = scene.items.find((g) => g.rec.type === 'LINE')!;
    expect(fence.prims3.map((p) => p.k).sort()).toEqual(['face', 'line', 'line', 'line', 'line']);
    // the extents grow in Z: the projected box is taller than the top view's
    const isoH = scene.extents![3] - scene.extents![1];
    scene.setView(IDENTITY);
    const topH = scene.extents![3] - scene.extents![1];
    expect(isoH).not.toBeCloseTo(topH, 3);
  });

  it('text on a wall is edge-on from the top and readable from the front', () => {
    const scene = new Scene(load('house_3d.dxf'));
    const g = () => scene.items.find((x) => x.rec.type === 'TEXT' && x.rec.get(1) === 'No. 42')!.prims[0];
    const det = () => {
      const p = g();
      if (p.k !== 'text') throw new Error('not text');
      return p.m[0] * p.m[3] - p.m[1] * p.m[2];
    };
    expect(Math.abs(det())).toBeLessThan(1e-9);
    scene.setView(viewRotation(view('Front')));
    expect(det()).toBeGreaterThan(0.5); // upright, not mirrored
  });

  it('picks a 3D face by its edge in an isometric view', () => {
    const scene = new Scene(load('house_3d.dxf'));
    const rot = viewRotation(view('SW Isometric'));
    scene.setView(rot);
    // midpoint of the right wall's top edge (x = 40, y 0..30, z = 20) is not hidden by anything nearer in wireframe
    const target: Vec3 = [40, 15, 0];
    const c = project(rot, target);
    const hit = scene.pick(c[0], c[1], 0.2);
    expect(hit?.rec.type).toMatch(/3DFACE/);
    // window selection in camera space finds the chimney mesh
    const mesh = scene.items.find((x) => x.rec.type === 'MESH')!;
    const b = mesh.bbox!;
    const found = scene.inRect([b[0] - 0.1, b[1] - 0.1, b[2] + 0.1, b[3] + 0.1], false).map((x) => x.rec);
    expect(found).toContain(mesh.rec);
  });

  it('MESH and 3DFACE transforms agree with the renderer and survive save', () => {
    const doc = load('house_3d.dxf');
    const scene = new Scene(doc);
    const ed = new Editor(doc, scene);
    const mesh = scene.items.find((x) => x.rec.type === 'MESH')!;
    const before = mesh.prims3.map((p) => (p.k === 'face' ? p.pts.slice() : []));
    const t = similarity({ dx: 5, dy: -3, angle: 0.4, scale: 2, base: [1, 1] });
    ed.transform('t', [mesh.rec], t);
    const after = scene.geomOf(mesh.rec)!.prims3;
    after.forEach((p, i) => {
      if (p.k !== 'face') return;
      for (let k = 0; k < p.pts.length; k += 3) {
        const x = before[i][k], y = before[i][k + 1], z = before[i][k + 2];
        const e = [t.m[0] * x + t.m[1] * y + t.m[2] * z + t.m[3], t.m[4] * x + t.m[5] * y + t.m[6] * z + t.m[7], t.m[8] * x + t.m[9] * y + t.m[10] * z + t.m[11]];
        close(p.pts.slice(k, k + 3), e, 6);
      }
    });
    const out = writeDxf(doc);
    expect(writeDxf(parseDxf(out))).toBe(out);
  });
});
