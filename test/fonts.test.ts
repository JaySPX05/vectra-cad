import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDxf } from '../src/dxf/parser';
import { writeDxf } from '../src/dxf/writer';
import { Scene } from '../src/render/scene';
import { Editor } from '../src/edit/editor';
import { Ucs } from '../src/model/ucs';
import { convertToRomans } from '../src/model/fonts';
import { ROMANS_FONT, romansGlyph } from '../src/render/romans';
import { measure } from '../src/render/text';
import { DIMVAR, readDimOverrides } from '../src/dims/style';

const root = join(__dirname, '..', 'public', 'samples');
const fresh = (name: string) => {
  const doc = parseDxf(new Uint8Array(readFileSync(join(root, name))));
  const scene = new Scene(doc);
  return { doc, scene, ed: new Editor(doc, scene) };
};
const out = join(__dirname, '..', 'test-output');
mkdirSync(out, { recursive: true });

describe('Roman Simplex stroke font', () => {
  it('has cap height 1 and descenders below the baseline', () => {
    const ys = (ch: string) => romansGlyph(ch)!.s.flatMap((st) => st.filter((_, i) => i % 2 === 1));
    expect(Math.max(...ys('H'))).toBeCloseTo(1, 3);
    expect(Math.min(...ys('H'))).toBeCloseTo(0, 3);
    expect(Math.min(...ys('g'))).toBeLessThan(-0.2);
  });
  it('covers AutoCAD %% symbols and measures text by glyph advances', () => {
    for (const ch of ['°', '±', '⌀']) expect(romansGlyph(ch)).toBeTruthy();
    expect(measure('AB', ROMANS_FONT)).toBeCloseTo(romansGlyph('A')!.a + romansGlyph('B')!.a, 9);
  });
  it('every text in a drawing renders with it', () => {
    const { scene } = fresh('text_mtext.dxf');
    const texts = scene.items.flatMap((g) => g.prims).filter((p) => p.k === 'text');
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.every((p) => p.k === 'text' && p.font === ROMANS_FONT)).toBe(true);
  });
});

describe('switching a drawing to romans.shx', () => {
  it('changes text styles and strips MTEXT font switches, undoably', () => {
    const { doc, ed } = fresh('text_mtext.dxf');
    const before = writeDxf(doc);
    const r = ed.history.run('romans', (tx) => convertToRomans(doc, tx));
    expect(r.styles).toBeGreaterThan(0);
    expect(r.mtext).toBe(1); // the "{\fArial|b1;Bold title}" paragraph
    for (const st of doc.table('STYLE')!.entries) {
      if (st.num(70, 0) & 1) continue;
      expect(st.str(3)).toBe('romans.shx');
      expect(st.has(1001)).toBe(false); // TrueType family XDATA removed
    }
    const mt = doc.entities.filter((e) => e.type === 'MTEXT').map((e) => e.all(3).join('') + e.get(1));
    expect(mt.some((t) => /\\f/i.test(t))).toBe(false);
    expect(mt.some((t) => t.includes('Bold title'))).toBe(true);
    writeFileSync(join(out, 'romans_text_mtext.dxf'), writeDxf(doc));
    // running it again changes nothing
    expect(ed.history.run('again', (tx) => convertToRomans(doc, tx))).toEqual({ styles: 0, mtext: 0 });
    ed.undo();
    expect(writeDxf(doc)).toBe(before);
  });
});

describe('dimension size overrides (DIMSCALE in DSTYLE XDATA)', () => {
  it('scales label, arrows and gaps, and round-trips', () => {
    const { doc, ed } = fresh('basic_entities.dxf');
    doc.setHeader('$DIMSTYLE', 2, 'Standard');
    const spec = { kind: 'rotated' as const, p1: [0, 0, 0] as [number, number, number], p2: [50, 0, 0] as [number, number, number], loc: [25, -10, 0] as [number, number, number], dir: [1, 0, 0] as [number, number, number] };
    const a = ed.addDimension(spec, Ucs.WORLD, { layer: '0' });
    const b = ed.addDimension({ ...spec, scale: 2 }, Ucs.WORLD, { layer: '0' });
    const h = (r: typeof a) => doc.block(r.str(2))!.entities.find((e) => e.type === 'MTEXT')!.num(40, 0);
    expect(h(b)).toBeCloseTo(2 * h(a), 9);
    expect(readDimOverrides(b).get(DIMVAR.DIMSCALE)).toBe('2.0');
    // change it afterwards (Properties / DIMSCALE on a selection)
    ed.setDimOverride([b], DIMVAR.DIMSCALE, 3);
    expect(h(b)).toBeCloseTo(3 * h(a), 9);
    ed.setDimOverride([b], DIMVAR.DIMSCALE, null);
    expect(h(b)).toBeCloseTo(h(a), 9);
    expect(b.has(1001)).toBe(false);
    ed.setDimOverride([b], DIMVAR.DIMSCALE, 4);
    const text = writeDxf(doc);
    const back = parseDxf(text);
    const rb = back.byHandle(b.handle!)!;
    expect(readDimOverrides(rb).get(DIMVAR.DIMSCALE)).toBe('4.0');
    writeFileSync(join(out, 'dims_scaled.dxf'), text);
  });
});

describe('dimension label height (DIMTXT override)', () => {
  const spec = { kind: 'rotated' as const, p1: [0, 0, 0] as [number, number, number], p2: [50, 0, 0] as [number, number, number], loc: [25, -10, 0] as [number, number, number], dir: [1, 0, 0] as [number, number, number] };
  const arrowLen = (doc: ReturnType<typeof fresh>['doc'], r: { str(c: number): string }) => {
    const s = doc.block(r.str(2))!.entities.find((e) => e.type === 'SOLID')!;
    return Math.hypot(s.point(11)[0] - s.point(10)[0], s.point(11)[1] - s.point(10)[1]);
  };
  const height = (doc: ReturnType<typeof fresh>['doc'], r: { str(c: number): string }) =>
    doc.block(r.str(2))!.entities.find((e) => e.type === 'MTEXT')!.num(40, 0);

  it('sets the exact label height, keeps arrows, clears and undoes', () => {
    const { doc, ed } = fresh('basic_entities.dxf');
    doc.setHeader('$DIMSTYLE', 2, 'Standard');
    const r = ed.addDimension({ ...spec, scale: 2 }, Ucs.WORLD, { layer: '0' }); // DIMSCALE 2 as well
    const styleH = height(doc, r), arrows = arrowLen(doc, r);
    ed.setDimTextHeight([r], 7);
    expect(height(doc, r)).toBeCloseTo(7, 9); // exact, despite DIMSCALE 2
    expect(arrowLen(doc, r)).toBeCloseTo(arrows, 9);
    const back = parseDxf(writeDxf(doc)).byHandle(r.handle!)!;
    expect(Number(readDimOverrides(back).get(DIMVAR.DIMTXT))).toBeCloseTo(3.5, 9); // 7 / DIMSCALE 2
    ed.setDimTextHeight([r], null);
    expect(height(doc, r)).toBeCloseTo(styleH, 9);
    ed.undo();
    expect(height(doc, r)).toBeCloseTo(7, 9);
    writeFileSync(join(out, 'dims_textheight.dxf'), writeDxf(doc));
  });

  it('new dimensions can be created with a label height', () => {
    const { doc, ed } = fresh('basic_entities.dxf');
    doc.setHeader('$DIMSTYLE', 2, 'Standard');
    const r = ed.addDimension({ ...spec, textHeight: 4 }, Ucs.WORLD, { layer: '0' });
    expect(height(doc, r)).toBeCloseTo(4, 9);
  });
});
