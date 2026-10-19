import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDxf } from '../src/dxf/parser';
import { writeDxf } from '../src/dxf/writer';
import { Scene } from '../src/render/scene';
import { Editor } from '../src/edit/editor';
import { Ucs } from '../src/model/ucs';
import { gripsFor } from '../src/edit/grips';
import type { DimSpec } from '../src/dims/create';
import type { DxfRecord } from '../src/dxf/record';
import { formatLinear, formatAngle, dimStyle, withValues } from '../src/dims/style';

const root = join(__dirname, '..', 'public', 'samples');
const fresh = (name = 'basic_entities.dxf') => {
  const doc = parseDxf(new Uint8Array(readFileSync(join(root, name))));
  // the samples' current style is ezdxf's EZDXF (DIMLFAC 100: metres shown in cm); test with Standard
  doc.setHeader('$DIMSTYLE', 2, 'Standard');
  const scene = new Scene(doc);
  return { doc, scene, ed: new Editor(doc, scene) };
};
const props = { layer: '0' };
/** File text without the handle seed (handles used by an undone command are not reused, as in AutoCAD). */
const noSeed = (t: string) => t.replace(/\$HANDSEED\r\n {2}5\r\n[0-9A-F]+/, 'HANDSEED');

/** Label text found in a dimension's block. */
function label(doc: ReturnType<typeof fresh>['doc'], rec: DxfRecord): string {
  const blk = doc.block(rec.str(2))!;
  const t = blk.entities.find((e) => e.type === 'MTEXT' || e.type === 'TEXT');
  return t?.get(1) ?? '';
}

describe('dimension style formatting', () => {
  it('formats like AutoCAD decimal units', () => {
    const { doc } = fresh();
    const st = { ...withValues(dimStyle(doc), { DIMDSEP: 46, DIMAZIN: 0 }), dec: 2, zin: 8, lfac: 1, post: '' };
    expect(formatLinear(50, st)).toBe('50');
    expect(formatLinear(12.345, st)).toBe('12.35');
    expect(formatLinear(12.3, { ...st, zin: 0 })).toBe('12.30');
    expect(formatAngle(Math.PI / 4, { ...st, adec: 0 })).toBe('45%%d');
  });
});

describe('creating dimensions', () => {
  const cases: { name: string; spec: DimSpec; value: number; text: RegExp }[] = [
    { name: 'horizontal linear', spec: { kind: 'rotated', p1: [0, 0, 0], p2: [50, 20, 0], loc: [25, -15, 0], dir: [1, 0, 0] }, value: 50, text: /^50$/ },
    { name: 'vertical linear', spec: { kind: 'rotated', p1: [0, 0, 0], p2: [50, 20, 0], loc: [70, 10, 0], dir: [0, 1, 0] }, value: 20, text: /^20$/ },
    { name: 'aligned', spec: { kind: 'aligned', p1: [0, 0, 0], p2: [30, 40, 0], loc: [10, 30, 0] }, value: 50, text: /^50$/ },
    { name: 'radius', spec: { kind: 'radius', center: [100, 15, 0], radius: 15, textPos: [130, 40, 0] }, value: 15, text: /^R15$/ },
    { name: 'diameter', spec: { kind: 'diameter', center: [100, 15, 0], radius: 15, textPos: [105, 18, 0] }, value: 30, text: /^%%c30$/ },
    { name: 'angular 3-point', spec: { kind: 'angular3', vertex: [0, 0, 0], p1: [10, 0, 0], p2: [10, 10, 0], loc: [8, 3, 0] }, value: Math.PI / 4, text: /^45%%d$/ },
    { name: 'angular 2-line', spec: { kind: 'angular2', l1a: [0, 0, 0], l1b: [20, 0, 0], l2a: [0, 0, 0], l2b: [0, 20, 0], loc: [10, 10, 0] }, value: Math.PI / 2, text: /^90%%d$/ },
    { name: 'ordinate X', spec: { kind: 'ordinate', feature: [37.5, 10, 0], leaderEnd: [37.5, 30, 0], xDatum: true }, value: 37.5, text: /^37[.,]5$/ },
    { name: 'ordinate Y', spec: { kind: 'ordinate', feature: [37.5, 12, 0], leaderEnd: [60, 12, 0], xDatum: false }, value: 12, text: /^12$/ },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const { doc, scene, ed } = fresh();
      const before = writeDxf(doc);
      const rec = ed.addDimension(c.spec, Ucs.WORLD, props);
      expect(rec.num(42, 0)).toBeCloseTo(c.value, 9);
      expect(label(doc, rec)).toMatch(c.text);
      // rendered: block geometry shows up as primitives including the label text
      const g = scene.geomOf(rec)!;
      expect(g.prims.some((p) => p.k === 'text')).toBe(true);
      expect(g.prims.filter((p) => p.k === 'line').length).toBeGreaterThan(0);
      // round trip and undo
      const out = writeDxf(doc);
      expect(writeDxf(parseDxf(out))).toBe(out);
      ed.undo();
      expect(noSeed(writeDxf(doc))).toBe(noSeed(before));
    });
  }

  it('ordinate measures from the UCS origin', () => {
    const { doc, ed } = fresh();
    const ucs = new Ucs([100, 50, 0]);
    const rec = ed.addDimension({ kind: 'ordinate', feature: [130, 62, 0], leaderEnd: [130, 90, 0], xDatum: true }, ucs, props);
    expect(rec.num(42, 0)).toBeCloseTo(30, 9);
    expect(label(doc, rec)).toBe('30');
    const recY = ed.addDimension({ kind: 'ordinate', feature: [130, 62, 0], leaderEnd: [160, 62, 0], xDatum: false }, ucs, props);
    expect(recY.num(42, 0)).toBeCloseTo(12, 9);
  });

  it('ordinate in a rotated UCS uses the UCS axes', () => {
    const { ed } = fresh();
    const a = Math.PI / 6;
    const ucs = new Ucs([10, 10, 0], [Math.cos(a), Math.sin(a), 0], [-Math.sin(a), Math.cos(a), 0]);
    const feature = ucs.toWcs([20, 5]);
    const rec = ed.addDimension({ kind: 'ordinate', feature, leaderEnd: ucs.toWcs([20, 25]), xDatum: true }, ucs, props);
    expect(rec.num(42, 0)).toBeCloseTo(20, 9);
  });

  it('a grip drag regenerates the measurement and label', () => {
    const { doc, ed } = fresh();
    const rec = ed.addDimension({ kind: 'rotated', p1: [0, 0, 0], p2: [50, 0, 0], loc: [25, -10, 0], dir: [1, 0, 0] }, Ucs.WORLD, props);
    const g = gripsFor(rec).find((x) => x.id === 'd14')!;
    ed.grip(rec, g, 80, 0);
    expect(rec.num(42, 0)).toBeCloseTo(80, 9);
    expect(label(doc, rec)).toBe('80');
    ed.undo();
    expect(rec.num(42, 0)).toBeCloseTo(50, 9);
    expect(label(doc, rec)).toBe('50');
  });

  it('text override keeps <> as the measured value', () => {
    const { doc, ed } = fresh();
    const rec = ed.addDimension({ kind: 'rotated', p1: [0, 0, 0], p2: [50, 0, 0], loc: [25, -10, 0], dir: [1, 0, 0] }, Ucs.WORLD, props);
    ed.setDimensionText(rec, 'L = <> mm');
    expect(label(doc, rec)).toBe('L = 50 mm');
  });

  it('works in R12 files (TEXT labels, no subclass markers)', () => {
    const { doc, ed } = fresh('r12_legacy.dxf');
    const rec = ed.addDimension({ kind: 'aligned', p1: [0, 0, 0], p2: [30, 40, 0], loc: [10, 30, 0] }, Ucs.WORLD, props);
    expect(rec.has(100)).toBe(false);
    expect(doc.block(rec.str(2))!.entities.some((e) => e.type === 'TEXT')).toBe(true);
  });

  it('writes files for ezdxf validation', () => {
    const outDir = join(__dirname, '..', 'test-output');
    mkdirSync(outDir, { recursive: true });
    for (const f of ['basic_entities.dxf', 'basic_entities_r2000.dxf', 'r12_legacy.dxf']) {
      const { doc, ed } = fresh(f);
      for (const c of cases) ed.addDimension(c.spec, Ucs.WORLD, props);
      const ucs = new Ucs([100, 50, 0]);
      ed.addDimension({ kind: 'ordinate', feature: [130, 62, 0], leaderEnd: [130, 90, 0], xDatum: true }, ucs, props);
      writeFileSync(join(outDir, 'dims_' + f), writeDxf(doc));
    }
  });
});

describe('dynamic label height (follows the measured value)', () => {
  // ratio 8 %, limits 1..10, rounded to standard heights
  const dyn = { ratio: 0.08, min: 1, max: 10, round: true };
  const textH = (doc: ReturnType<typeof fresh>['doc'], r: DxfRecord) =>
    doc.block(r.str(2))!.entities.find((e) => e.type === 'MTEXT')!.num(40, 0);

  it('rounds to standard heights within limits', async () => {
    const { roundToStandard, dynamicHeight } = await import('../src/dims/dynamic');
    expect(roundToStandard(9.6)).toBe(10);
    expect(roundToStandard(3.2)).toBe(3.5);
    expect(roundToStandard(2.2)).toBe(2);
    expect(dynamicHeight(120, dyn)).toBe(10); // 9.6 -> 10
    expect(dynamicHeight(30, dyn)).toBe(2.5); // 2.4 -> 2.5
    expect(dynamicHeight(6, dyn)).toBe(1); // 0.48 -> clamped to min 1
    expect(dynamicHeight(5000, dyn)).toBe(10); // clamped to max
    expect(dynamicHeight(30, { ...dyn, round: false })).toBeCloseTo(2.4, 9);
  });

  it('each dimension type sizes its label from what it measures', () => {
    const { doc, ed } = fresh();
    const lin = ed.addDimension({ kind: 'rotated', p1: [0, 0, 0], p2: [120, 0, 0], loc: [60, -15, 0], dir: [1, 0, 0], dynamic: dyn }, Ucs.WORLD, props);
    const dia = ed.addDimension({ kind: 'diameter', center: [100, 15, 0], radius: 15, textPos: [105, 18, 0], dynamic: dyn }, Ucs.WORLD, props);
    const rad = ed.addDimension({ kind: 'radius', center: [100, 15, 0], radius: 6, textPos: [130, 40, 0], dynamic: dyn }, Ucs.WORLD, props);
    // 90 degrees on an arc of radius 40: arc length 62.8 -> 5.03 -> 5
    const ang = ed.addDimension({ kind: 'angular3', vertex: [0, 0, 0], p1: [50, 0, 0], p2: [0, 50, 0], loc: [28.28, 28.28, 0], dynamic: dyn }, Ucs.WORLD, props);
    expect(textH(doc, lin)).toBeCloseTo(10, 9);
    expect(textH(doc, dia)).toBeCloseTo(2.5, 9);
    expect(textH(doc, rad)).toBeCloseTo(1, 9);
    expect(textH(doc, ang)).toBeCloseTo(5, 9);
  });

  it('stays dynamic through grip edits, SCALE and save/reload; off keeps the height', async () => {
    const { readDynamic } = await import('../src/dims/dynamic');
    const { doc, ed } = fresh();
    const r = ed.addDimension({ kind: 'rotated', p1: [0, 0, 0], p2: [120, 0, 0], loc: [60, -15, 0], dir: [1, 0, 0], dynamic: dyn }, Ucs.WORLD, props);
    expect(textH(doc, r)).toBeCloseTo(10, 9);
    ed.grip(r, gripsFor(r).find((g) => g.id === 'd14')!, 40, 0); // 40 long: 3.2 -> 3.5
    expect(textH(doc, r)).toBeCloseTo(3.5, 9);
    ed.scale([r], [0, 0], 0.5); // 20 long: 1.6 -> 1.5
    expect(textH(doc, r)).toBeCloseTo(1.5, 9);
    ed.undo();
    expect(textH(doc, r)).toBeCloseTo(3.5, 9);
    const back = parseDxf(writeDxf(doc)).byHandle(r.handle!)!;
    expect(readDynamic(back)).toEqual(dyn);
    ed.setDimDynamic([r], null);
    expect(readDynamic(r)).toBeNull();
    expect(textH(doc, r)).toBeCloseTo(3.5, 9);
    ed.grip(r, gripsFor(r).find((g) => g.id === 'd14')!, 120, 0); // no longer dynamic: height stays
    expect(textH(doc, r)).toBeCloseTo(3.5, 9);
    ed.setDimDynamic([r], dyn);
    expect(textH(doc, r)).toBeCloseTo(10, 9);
    writeFileSync(join(__dirname, '..', 'test-output', 'dims_dynamic.dxf'), writeDxf(doc));
  });
});
