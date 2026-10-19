import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDxf } from '../src/dxf/parser';
import { dimStyle, withValues } from '../src/dims/style';
import { dimLabel, formatAngle, formatUnits } from '../src/dims/format';

const root = join(__dirname, '..', 'public', 'samples');
const doc = parseDxf(new Uint8Array(readFileSync(join(root, 'basic_entities.dxf'))));
doc.setHeader('$DIMSTYLE', 2, 'Standard');
// the sample's Standard style (ISO-25 from ezdxf) uses a decimal comma; the unit tests pin a period
const std = withValues(dimStyle(doc), { DIMDSEP: 46 });
const u = (o: Partial<Parameters<typeof formatUnits>[1]>) => ({ unit: 2, prec: 2, frac: 0, dsep: '.', rnd: 0, zin: 0, ...o });

describe('unit formats (Primary Units tab)', () => {
  it('decimal: precision, separator, rounding, zero suppression', () => {
    expect(formatUnits(12.5, u({}))).toBe('12.50');
    expect(formatUnits(12.5, u({ dsep: ',' }))).toBe('12,50');
    expect(formatUnits(12.3, u({ rnd: 0.5 }))).toBe('12.50');
    expect(formatUnits(12.5, u({ zin: 8 }))).toBe('12.5');
    expect(formatUnits(0.5, u({ zin: 4 }))).toBe('.50');
  });
  it('scientific', () => {
    expect(formatUnits(12.345, u({ unit: 1, prec: 4 }))).toBe('1.2345E+01');
    expect(formatUnits(0.00123, u({ unit: 1, prec: 2 }))).toBe('1.23E-03');
  });
  it('engineering and architectural (feet and inches)', () => {
    expect(formatUnits(18.5, u({ unit: 3, prec: 2 }))).toBe(`1'-6.50"`);
    expect(formatUnits(18.5, u({ unit: 4, prec: 1, frac: 2 }))).toBe(`1'-6 1/2"`);
    expect(formatUnits(18.5, u({ unit: 4, prec: 1, frac: 0 }))).toBe(`1'-6 \\S1/2;"`);
    expect(formatUnits(18.25, u({ unit: 4, prec: 2, frac: 1 }))).toBe(`1'-6 \\S1#4;"`);
    // DIMZIN: 0 suppresses 0 feet; 1 includes zero feet and zero inches
    expect(formatUnits(6.5, u({ unit: 4, prec: 1, frac: 2, zin: 0 }))).toBe(`6 1/2"`);
    expect(formatUnits(6.5, u({ unit: 4, prec: 1, frac: 2, zin: 1 }))).toBe(`0'-6 1/2"`);
    expect(formatUnits(24, u({ unit: 4, prec: 1, frac: 2, zin: 0 }))).toBe(`2'`);
    expect(formatUnits(24, u({ unit: 4, prec: 1, frac: 2, zin: 1 }))).toBe(`2'-0"`);
  });
  it('fractional', () => {
    expect(formatUnits(18.5, u({ unit: 5, prec: 1, frac: 2 }))).toBe('18 1/2');
    expect(formatUnits(0.375, u({ unit: 5, prec: 3, frac: 0 }))).toBe('\\S3/8;');
  });
});

describe('angular formats', () => {
  const a = (unit: number, adec: number, rad: number) => formatAngle(rad, withValues(std, { DIMAUNIT: unit, DIMADEC: adec, DIMAZIN: 0 }));
  it('decimal degrees, DMS, grads, radians', () => {
    expect(a(0, 1, (45.25 * Math.PI) / 180)).toBe('45.3%%d');
    expect(a(1, 4, (45.5 * Math.PI) / 180)).toBe(`45%%d30'0"`);
    expect(a(1, 2, (45.5 * Math.PI) / 180)).toBe(`45%%d30'`);
    expect(a(2, 2, Math.PI / 4)).toBe('50.00g');
    expect(a(3, 3, Math.PI / 4)).toBe('0.785r');
  });
});

describe('alternate units and tolerances', () => {
  it('alternate units after or below the primary value', () => {
    const st = withValues(std, { DIMALT: 1, DIMALTF: 1 / 25.4, DIMALTD: 2, DIMALTU: 2 });
    expect(dimLabel(50, 'linear', st, '')).toBe('50 [1.97]');
    expect(dimLabel(50, 'linear', withValues(st, { DIMAPOST: '\\X[] in' }), '')).toBe('50\\X1.97 in');
  });
  it('symmetrical, deviation and limits', () => {
    expect(dimLabel(50, 'linear', withValues(std, { DIMTOL: 1, DIMTP: 0.1, DIMTM: 0.1, DIMTDEC: 1 }), '')).toBe('50%%p0.1');
    const dev = dimLabel(50, 'linear', withValues(std, { DIMTOL: 1, DIMTP: 0.2, DIMTM: 0.1, DIMTDEC: 1, DIMTFAC: 0.7 }), '');
    expect(dev).toBe('50{\\H0.7x;\\A0;\\S+0.2^-0.1;}');
    const lim = dimLabel(50, 'linear', withValues(std, { DIMLIM: 1, DIMTP: 0.2, DIMTM: 0.1, DIMTFAC: 1 }), '');
    expect(lim).toBe('{\\H1x;\\S50.2^49.9;}');
  });
  it('prefix/suffix and overrides', () => {
    expect(dimLabel(50, 'linear', withValues(std, { DIMPOST: '<> mm' }), '')).toBe('50 mm');
    expect(dimLabel(50, 'linear', std, 'L = <>')).toBe('L = 50');
    expect(dimLabel(15, 'linear', std, '', 'R')).toBe('R15');
  });
});

// ---- builder: each setting changes the generated block ------------------------------------------
import { Scene } from '../src/render/scene';
import { Editor } from '../src/edit/editor';
import { Ucs } from '../src/model/ucs';
import { buildDimension } from '../src/dims/build';
import type { DxfRecord } from '../src/dxf/record';

describe('builder honours the style', () => {
  const setup = () => {
    const d = parseDxf(new Uint8Array(readFileSync(join(root, 'basic_entities.dxf'))));
    d.setHeader('$DIMSTYLE', 2, 'Standard');
    const ed = new Editor(d, new Scene(d));
    const lin = ed.addDimension({ kind: 'rotated', p1: [0, 0, 0], p2: [100, 0, 0], loc: [50, -20, 0], dir: [1, 0, 0] }, Ucs.WORLD, { layer: '0' });
    const rad = ed.addDimension({ kind: 'radius', center: [0, 100, 0], radius: 10, textPos: [40, 130, 0] }, Ucs.WORLD, { layer: '0' });
    return { d, lin, rad, base: dimStyle(d) };
  };
  const build = (d: ReturnType<typeof setup>['d'], r: DxfRecord, st: ReturnType<typeof dimStyle>) => buildDimension(d, r, st)!.entities;
  const count = (es: DxfRecord[], t: string) => es.filter((e) => e.type === t).length;
  const mtext = (es: DxfRecord[]) => es.find((e) => e.type === 'MTEXT')!;

  it('suppresses extension and dimension lines', () => {
    const { d, lin, base } = setup();
    const n0 = count(build(d, lin, base), 'LINE');
    expect(count(build(d, lin, withValues(base, { DIMSE1: 1 })), 'LINE')).toBe(n0 - 1);
    expect(count(build(d, lin, withValues(base, { DIMSE1: 1, DIMSE2: 1 })), 'LINE')).toBe(n0 - 2);
    // suppressing half the dimension line also drops its arrow
    expect(count(build(d, lin, withValues(base, { DIMSD1: 1 })), 'SOLID')).toBe(count(build(d, lin, base), 'SOLID') - 1);
  });

  it('colours, linetypes and lineweights land on the right parts', () => {
    const { d, lin, base } = setup();
    const es = build(d, lin, withValues(base, { DIMCLRD: 1, DIMCLRE: 3, DIMCLRT: 5, DIMLWD: 50, DIMLTEX1: 'DASHED' }));
    const colours = es.filter((e) => e.type === 'LINE').map((e) => e.num(62, -1)).sort();
    expect(colours).toContain(1);
    expect(colours).toContain(3);
    expect(mtext(es).num(62, -1)).toBe(5);
    expect(es.some((e) => e.type === 'LINE' && e.num(370, 0) === 50)).toBe(true);
    expect(es.some((e) => e.type === 'LINE' && e.str(6) === 'DASHED')).toBe(true);
  });

  it('arrow types and tick size change the arrow geometry', () => {
    const { d, lin, base } = setup();
    const filled = build(d, lin, base);
    expect(count(filled, 'SOLID')).toBe(2);
    const open = build(d, lin, withValues(base, { DIMBLK: '_OPEN' }));
    expect(count(open, 'SOLID')).toBe(0);
    expect(count(open, 'LINE')).toBe(count(filled, 'LINE') + 4);
    const dots = build(d, lin, withValues(base, { DIMBLK: '_DOTBLANK' }));
    expect(count(dots, 'CIRCLE')).toBe(2);
    const mixed = build(d, lin, withValues(base, { DIMSAH: 1, DIMBLK1: '_DOTBLANK', DIMBLK2: '_NONE' }));
    expect(count(mixed, 'CIRCLE')).toBe(1);
    const ticks = build(d, lin, withValues(base, { DIMTSZ: 1, DIMDLE: 1 }));
    expect(count(ticks, 'SOLID')).toBe(0);
  });

  it('text placement: vertical, horizontal, alignment, frame and fill', () => {
    const { d, lin, base } = setup();
    const y = (st: ReturnType<typeof dimStyle>) => mtext(build(d, lin, st)).point(10)[1];
    const x = (st: ReturnType<typeof dimStyle>) => mtext(build(d, lin, st)).point(10)[0];
    // the dimension line is at y = -20
    expect(y(withValues(base, { DIMTAD: 0 }))).toBeCloseTo(-20, 6);
    expect(y(withValues(base, { DIMTAD: 1 }))).toBeGreaterThan(-20);
    expect(y(withValues(base, { DIMTAD: 4 }))).toBeLessThan(-20);
    expect(x(withValues(base, { DIMJUST: 1 }))).toBeLessThan(x(withValues(base, { DIMJUST: 0 })));
    expect(x(withValues(base, { DIMJUST: 2 }))).toBeGreaterThan(x(withValues(base, { DIMJUST: 0 })));
    const framed = build(d, lin, withValues(base, { DIMGAP: -0.625 }));
    expect(count(framed, 'LINE')).toBe(count(build(d, lin, base), 'LINE') + 4);
    const filled = mtext(build(d, lin, withValues(base, { DIMTFILL: 2, DIMTFILLCLR: 2 })));
    expect(filled.num(90, 0)).toBe(1);
    expect(filled.num(63, 0)).toBe(2);
  });

  it('fit rules move arrows/text out of a short dimension', () => {
    const d = parseDxf(new Uint8Array(readFileSync(join(root, 'basic_entities.dxf'))));
    d.setHeader('$DIMSTYLE', 2, 'Standard');
    const ed = new Editor(d, new Scene(d));
    const short = ed.addDimension({ kind: 'rotated', p1: [0, 0, 0], p2: [3, 0, 0], loc: [1.5, -10, 0], dir: [1, 0, 0] }, Ucs.WORLD, { layer: '0' });
    const base = dimStyle(d);
    const tip = (es: DxfRecord[]) => es.filter((e) => e.type === 'SOLID').map((s) => s.point(11)[0]);
    // arrows outside: the arrow bodies point away from the 0..3 span
    const out = tip(build(d, short, withValues(base, { DIMATFIT: 0 })));
    expect(out.some((x0) => x0 < 0) && out.some((x0) => x0 > 3)).toBe(true);
    expect(count(build(d, short, withValues(base, { DIMATFIT: 0, DIMSOXD: 1 })), 'SOLID')).toBe(0);
    // text beside the dimension line (DIMTMOVE 0) sits past the second extension line
    expect(mtext(build(d, short, withValues(base, { DIMATFIT: 0, DIMTMOVE: 0 }))).point(10)[0]).toBeGreaterThan(3);
    // DIMTIX keeps the text between the extension lines
    const tix = mtext(build(d, short, withValues(base, { DIMATFIT: 0, DIMTIX: 1 }))).point(10)[0];
    expect(tix).toBeGreaterThan(0);
    expect(tix).toBeLessThan(3);
  });

  it('center marks on radius dimensions', () => {
    const { d, rad, base } = setup();
    const none = count(build(d, rad, withValues(base, { DIMCEN: 0 })), 'LINE');
    expect(count(build(d, rad, withValues(base, { DIMCEN: 2.5 })), 'LINE')).toBe(none + 2);
    expect(count(build(d, rad, withValues(base, { DIMCEN: -2.5 })), 'LINE')).toBe(none + 6);
  });

  it('units and tolerances show in the label', () => {
    const { d, lin, base } = setup();
    expect(mtext(build(d, lin, withValues(base, { DIMLUNIT: 4, DIMDEC: 1, DIMFRAC: 2, DIMZIN: 0 }))).get(1)).toBe(`8'-4"`);
    expect(mtext(build(d, lin, withValues(base, { DIMTOL: 1, DIMTP: 0.1, DIMTM: 0.1, DIMTDEC: 1, DIMDSEP: 46 }))).get(1)).toBe('100%%p0.1');
  });
});

import { writeDxf } from '../src/dxf/writer';
import { History } from '../src/edit/history';
import {
  compareStyles, createStyle, deleteStyle, listStyles, readStyle, regenStyle, renameStyle, setCurrent, stylesInUse, writeStyle,
} from '../src/dims/styles-table';

describe('style table operations (Dimension Style Manager)', () => {
  const load = (f = 'basic_entities.dxf') => {
    const d = parseDxf(new Uint8Array(readFileSync(join(root, f))));
    d.setHeader('$DIMSTYLE', 2, 'Standard');
    return d;
  };
  const strip = (s: string) => s.replace(/\$HANDSEED\r?\n\s*5\r?\n[0-9A-F]+/i, '');

  it('creates a style from a base and reads every value back after a save', () => {
    const d = load();
    const h = new History();
    h.run('new', (tx) => createStyle(d, 'Arch', 'Standard', tx, { DIMLUNIT: 4, DIMBLK: '_ARCHTICK', DIMCLRD: 1, DIMTAD: 1, DIMTXT: 3.5, DIMPOST: '<> mm', DIMTFILL: 2 }));
    expect(listStyles(d)).toContain('Arch');
    const d2 = parseDxf(new TextEncoder().encode(writeDxf(d)));
    const v = readStyle(d2, 'Arch');
    expect(v.DIMLUNIT).toBe(4);
    expect(v.DIMBLK).toBe('_ARCHTICK');
    expect(v.DIMCLRD).toBe(1);
    expect(v.DIMTXT).toBe(3.5);
    expect(v.DIMPOST).toBe('<> mm');
    expect(v.DIMTFILL).toBe(2);
    // the arrow block exists and the handle points at it
    expect(d2.tableEntry('BLOCK_RECORD', '_ArchTick')).toBeTruthy();
    expect(d2.block('_ArchTick')?.entities.length).toBeGreaterThan(0);
    // unchanged values come from the base
    const base = readStyle(d2, 'Standard');
    expect(v.DIMEXO).toBe(base.DIMEXO);
  });

  it('writes only codes the DXF version supports', () => {
    const d = load();
    d.setHeader('$ACADVER', 1, 'AC1015');
    const h = new History();
    const rec = h.run('new', (tx) => createStyle(d, 'Old', 'Standard', tx, { DIMFXLON: 1, DIMFXL: 5, DIMASZ: 4 }));
    expect(rec.has(290)).toBe(false); // DIMFXLON is R2007+
    expect(rec.has(49)).toBe(false);
    expect(rec.num(41, 0)).toBe(4);
    const codes = rec.groups.filter((g) => g.code > 2 && g.code < 1000 && g.code !== 70 && g.code !== 100 && g.code !== 105 && g.code !== 330).map((g) => g.code);
    expect(codes).toEqual([...codes].sort((a, b) => a - b));
  });

  it('renames a style and its dimensions; refuses deleting styles in use', () => {
    const d = load();
    const ed = new Editor(d, new Scene(d));
    ed.history.run('new', (tx) => { createStyle(d, 'Mine', 'Standard', tx); setCurrent(d, 'Mine', tx); });
    const dim = ed.addDimension({ kind: 'rotated', p1: [0, 0, 0], p2: [100, 0, 0], loc: [50, -20, 0], dir: [1, 0, 0] }, Ucs.WORLD, { layer: '0' });
    expect(dim.str(3)).toBe('Mine');
    expect(stylesInUse(d).has('MINE')).toBe(true);
    expect(() => ed.history.run('del', (tx) => deleteStyle(d, 'Mine', tx))).toThrow(/in use/);
    ed.history.run('ren', (tx) => renameStyle(d, 'Mine', 'Yours', tx));
    expect(dim.str(3)).toBe('Yours');
    expect(d.headerValue('$DIMSTYLE')).toBe('Yours');
    ed.history.run('new2', (tx) => createStyle(d, 'Spare', 'Standard', tx));
    ed.history.run('del', (tx) => deleteStyle(d, 'Spare', tx));
    expect(listStyles(d)).not.toContain('Spare');
  });

  it('regenerates dimensions after modify, compares styles, and undoes exactly', () => {
    const d = load();
    const ed = new Editor(d, new Scene(d));
    const dim = ed.addDimension({ kind: 'rotated', p1: [0, 0, 0], p2: [100, 0, 0], loc: [50, -20, 0], dir: [1, 0, 0] }, Ucs.WORLD, { layer: '0' });
    const before = strip(writeDxf(d));
    ed.history.run('modify', (tx) => {
      writeStyle(d, 'Standard', { ...readStyle(d, 'Standard'), DIMCLRD: 1, DIMSE1: 1, DIMBLK: '_DOT' }, tx);
      expect(regenStyle(d, 'Standard', tx)).toBeGreaterThan(0);
    });
    const blk = d.block(dim.str(2))!;
    expect(blk.entities.some((e) => e.type === 'LINE' && e.num(62, -1) === 1)).toBe(true);
    ed.history.run('new', (tx) => createStyle(d, 'B', 'Standard', tx, { DIMASZ: 9 }));
    expect(compareStyles(d, 'Standard', 'B').map((c) => c.name)).toEqual(['DIMASZ']);
    ed.history.undo();
    ed.history.undo();
    expect(strip(writeDxf(d))).toBe(before);
  });

  it('writes R12 arrow names as strings', () => {
    const d = load('r12_legacy.dxf');
    const h = new History();
    const rec = h.run('new', (tx) => createStyle(d, 'R12', 'Standard', tx, { DIMBLK: '_DOT', DIMSAH: 1, DIMBLK1: '_OPEN' }));
    expect(rec.str(5)).toBe('_DOT');
    expect(rec.str(6)).toBe('_OPEN');
    expect(rec.has(342)).toBe(false);
  });
});

describe('validation output', () => {
  it.runIf(!!process.env.DIMSTYLE_OUT)('writes a drawing with new/modified styles for ezdxf', async () => {
    const { writeFileSync } = await import('node:fs');
    for (const f of ['basic_entities.dxf', 'basic_entities_r2000.dxf', 'r12_legacy.dxf', 'dimensions_leaders.dxf']) {
      const d = parseDxf(new Uint8Array(readFileSync(join(root, f))));
      const ed = new Editor(d, new Scene(d));
      ed.history.run('styles', (tx) => {
        createStyle(d, 'Arch', 'Standard', tx, { DIMLUNIT: 4, DIMBLK: '_ARCHTICK', DIMCLRD: 1, DIMTFILL: 1, DIMALT: 1, DIMTOL: 1, DIMTP: 0.1, DIMTM: 0.2 });
        createStyle(d, 'Dots', 'Standard', tx, { DIMSAH: 1, DIMBLK1: '_DOT', DIMBLK2: '_OPEN30', DIMLDRBLK: '_ORIGIN2', DIMLTYPE: 'DASHED' });
        setCurrent(d, 'Arch', tx);
      });
      ed.addDimension({ kind: 'rotated', p1: [0, 0, 0], p2: [100, 0, 0], loc: [50, -20, 0], dir: [1, 0, 0] }, Ucs.WORLD, { layer: '0' });
      ed.history.run('modify', (tx) => {
        writeStyle(d, 'Standard', { ...readStyle(d, 'Standard'), DIMBLK: '_DOTBLANK', DIMCLRE: 3 }, tx);
        regenStyle(d, 'Standard', tx);
      });
      writeFileSync(join(process.env.DIMSTYLE_OUT!, f.replace('.dxf', '_styles.dxf')), writeDxf(d));
    }
  });
});
