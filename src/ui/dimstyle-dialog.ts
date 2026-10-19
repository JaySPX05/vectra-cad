import { DxfRecord, type Vec3 } from '../dxf/record';
import { group } from '../dxf/groups';
import { aciSwatchCss } from '../model/aci';
import { IDENTITY } from '../geom/ocs';
import { projectPrim, type Prim } from '../render/prims';
import { Renderer, type View } from '../render/canvas';
import { type DimSpec, previewWithStyle } from '../dims/create';
import { dimStyle, type DimStyle, type VarValue, withValues } from '../dims/style';
import { ARROWS, DIM_VARS, type DimVar, LINEWEIGHTS, type Tab, TABS, VAR_BY_NAME } from '../dims/vars';
import {
  compareStyles, createStyle, currentStyle, deleteStyle, listStyles, readStyle, regenStyle, renameStyle, setCurrent, stylesInUse, supported, writeStyle,
} from '../dims/styles-table';
import type { Tx } from '../edit/history';
import type { App } from './app';
import { clear, h } from './dom';
import { pickAci } from './panels';

/**
 * AutoCAD's Dimension Style Manager (DIMSTYLE): the style list with a preview, Set Current,
 * New, Modify, Override, Compare, Rename and Delete; and the New / Modify / Override dialog with
 * the Lines, Symbols and Arrows, Text, Fit, Primary Units, Alternate Units and Tolerances tabs.
 * Every field maps to a dimension variable (see dims/vars.ts) and the preview redraws on each change.
 */
type Vals = Record<string, VarValue>;

// ---- modal plumbing --------------------------------------------------------------------------
function modal(title: string, body: HTMLElement, buttons: HTMLElement[], cls = ''): { back: HTMLElement; close: () => void } {
  const back = h('div.modal-back');
  const box = h('div.modal' + cls, { role: 'dialog', 'aria-label': title },
    h('div.modal-title', title),
    body,
    h('div.modal-buttons', ...buttons));
  back.append(box);
  const close = () => {
    back.remove();
    window.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    // only the top-most dialog reacts
    const all = document.querySelectorAll('.modal-back');
    if (all[all.length - 1] !== back) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      (box.querySelector('[data-cancel]') as HTMLElement | null)?.click();
    }
  };
  window.addEventListener('keydown', onKey, true);
  document.body.append(back);
  return { back, close };
}

function btn(label: string, onclick: () => void, attrs: Record<string, string | boolean> = {}): HTMLButtonElement {
  return h('button.btn', { ...attrs, onclick: () => onclick() }, label) as HTMLButtonElement;
}

/** Small prompt dialog; resolves to the text, or null on Cancel. */
function askText(title: string, label: string, init: string, extra?: HTMLElement): Promise<string | null> {
  return new Promise((resolve) => {
    const inp = h('input.inp', { value: init, 'aria-label': label }) as HTMLInputElement;
    const ok = () => { m.close(); resolve(inp.value.trim()); };
    const m = modal(title, h('div.modal-body.ds-ask', h('label', label, inp), extra ?? null), [
      btn('Continue', ok, { 'data-ok': true }),
      btn('Cancel', () => { m.close(); resolve(null); }, { 'data-cancel': true }),
    ], '.small');
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
    inp.focus();
    inp.select();
  });
}

function confirmBox(title: string, text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const m = modal(title, h('div.modal-body', h('p', text)), [
      btn('Yes', () => { m.close(); resolve(true); }, { 'data-ok': true }),
      btn('No', () => { m.close(); resolve(false); }, { 'data-cancel': true }),
    ], '.small');
  });
}

function alertBox(title: string, text: string) {
  const m = modal(title, h('div.modal-body', h('p', text)), [btn('OK', () => m.close(), { 'data-cancel': true })], '.small');
}

// ---- preview ---------------------------------------------------------------------------------------
/** Sample part and dimensions sized to the style, like AutoCAD's preview tile. */
function samplePrims(app: App, st: DimStyle): Prim[] {
  const doc = app.doc;
  const L = Math.max(st.txt, st.asz, 1e-6) * 7;
  const line = (a: Vec3, b: Vec3) => new DxfRecord('LINE', [group(8, '0'), group(62, 7), group(10, a[0]), group(20, a[1]), group(30, 0), group(11, b[0]), group(21, b[1]), group(31, 0)]);
  const P = (x: number, y: number): Vec3 => [x * L, y * L, 0];
  const outline = [P(0, 0), P(2, 0), P(2, 1.2), P(0.6, 1.2), P(0, 0.6)];
  const recs: DxfRecord[] = outline.map((p, i) => line(p, outline[(i + 1) % outline.length]));
  const cen = P(1.3, 0.55), r = 0.28 * L;
  recs.push(new DxfRecord('CIRCLE', [group(8, '0'), group(62, 7), group(10, cen[0]), group(20, cen[1]), group(30, 0), group(40, r)]));
  const specs: DimSpec[] = [
    { kind: 'rotated', p1: P(0, 0), p2: P(2, 0), loc: P(1, -0.55), dir: [1, 0, 0] },
    { kind: 'rotated', p1: P(2, 0), p2: P(2, 1.2), loc: P(2.55, 0.6), dir: [0, 1, 0] },
    { kind: 'angular3', vertex: P(0, 0.6), p1: P(0, 0), p2: P(0.6, 1.2), loc: P(0.42, 0.42) },
    { kind: 'radius', center: cen, radius: r, textPos: [cen[0] + 0.55 * L, cen[1] + 0.95 * L, 0] },
  ];
  for (const s of specs) {
    try {
      recs.push(...previewWithStyle(doc, s, st));
    } catch {
      /* a bad value (e.g. 0 precision edge) must not break the dialog */
    }
  }
  return app.scene.previewPrims3(recs).map((p) => projectPrim(p, IDENTITY));
}

function primBox(prims: Prim[]): [number, number, number, number] | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  };
  for (const p of prims) {
    if (p.k === 'line') for (let i = 0; i + 1 < p.pts.length; i += 2) add(p.pts[i], p.pts[i + 1]);
    else if (p.k === 'fill') for (const r of p.rings) for (let i = 0; i + 1 < r.length; i += 2) add(r[i], r[i + 1]);
    else if (p.k === 'text') {
      const [a, b, c, d, e, f] = p.m;
      for (const [u, v] of [[0, 0], [p.w, 0], [0, p.h], [p.w, p.h]]) add(a * u + c * v + e, b * u + d * v + f);
    }
  }
  return x0 <= x1 ? [x0, y0, x1, y1] : null;
}

function drawPreview(canvas: HTMLCanvasElement, app: App, st: DimStyle) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 280, hh = canvas.clientHeight || 220;
  if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
  if (canvas.height !== Math.round(hh * dpr)) canvas.height = Math.round(hh * dpr);
  const r = new Renderer(canvas);
  const dark = app.renderOptions.dark;
  const ctx = r.ctx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = dark ? '#212830' : '#ffffff';
  ctx.fillRect(0, 0, w, hh);
  const prims = samplePrims(app, st);
  const b = primBox(prims);
  if (!b) return;
  const s = Math.min((w - 20) / Math.max(b[2] - b[0], 1e-9), (hh - 20) / Math.max(b[3] - b[1], 1e-9));
  const v: View = { cx: (b[0] + b[2]) / 2, cy: (b[1] + b[3]) / 2, s, w, h: hh };
  r.drawPrims(prims, v, { ...app.renderOptions, selection: new Set(), hover: null, visualStyle: 'wireframe' });
}

// ---- value helpers --------------------------------------------------------------------------------
const num = (v: VarValue | undefined) => Number(v) || 0;
const COLOR_NAMES: Record<number, string> = { 0: 'ByBlock', 256: 'ByLayer', 1: 'Red', 2: 'Yellow', 3: 'Green', 4: 'Cyan', 5: 'Blue', 6: 'Magenta', 7: 'White' };
const colorLabel = (aci: number) => COLOR_NAMES[aci] ?? `Color ${aci}`;
const lwLabel = (n: number) => (n === -1 ? 'ByLayer' : n === -2 ? 'ByBlock' : n === -3 ? 'Default' : `${(n / 100).toFixed(2)} mm`);
const arrowLabel = (name: string) => ARROWS.find(([n]) => n === name.toUpperCase())?.[1] ?? (name || 'Closed filled');

/** Arrow choices: AutoCAD's 20 plus any user blocks already used by the drawing's styles. */
function arrowOptions(app: App, vals: Vals): [string, string][] {
  const out = [...ARROWS];
  for (const k of ['DIMBLK', 'DIMBLK1', 'DIMBLK2', 'DIMLDRBLK']) {
    const n = String(vals[k] ?? '').toUpperCase();
    if (n && !out.some(([a]) => a === n)) out.push([n, `User: ${n}`]);
  }
  void app;
  return out;
}

function tableNames(app: App, table: string, skip: (r: DxfRecord) => boolean = () => false): string[] {
  return (app.doc.table(table)?.entries ?? []).filter((e) => !skip(e)).map((e) => e.str(2)).filter(Boolean);
}

function styleSummary(st: DimStyle): string {
  const v = st.v;
  const units = ['', 'Scientific', 'Decimal', 'Engineering', 'Architectural', 'Fractional', 'Windows'][num(v.DIMLUNIT)] ?? 'Decimal';
  const arrow = num(v.DIMSAH) ? `${arrowLabel(String(v.DIMBLK1))} / ${arrowLabel(String(v.DIMBLK2))}` : arrowLabel(String(v.DIMBLK));
  const tol = num(v.DIMLIM) ? ', limits' : num(v.DIMTOL) ? ', tolerances' : '';
  return `Text ${+st.txt.toFixed(4)} (${['centered', 'above', 'outside', 'JIS', 'below'][num(v.DIMTAD)] ?? 'centered'}), ` +
    `arrows ${arrow} ${+st.asz.toFixed(4)}, ${units} ${num(v.DIMDEC)} dp, overall scale ${st.scale}${num(v.DIMALT) ? ', alternate units' : ''}${tol}`;
}

// ---- Modify / New / Override dialog ----------------------------------------------------------------
interface Ctl { el: HTMLElement; load: () => void }

/**
 * Edit a full set of values. Resolves to the edited values (OK) or null (Cancel).
 * `name` is the style the values belong to (for the preview label).
 */
export function editStyleDialog(app: App, title: string, name: string, init: Vals, startTab: Tab = 'Lines'): Promise<Vals | null> {
  return new Promise((resolve) => {
    const doc = app.doc;
    const vals: Vals = { ...init };
    const ctls: Ctl[] = [];
    const base = dimStyle(doc, listStyles(doc).includes(name) ? name : currentStyle(doc));
    const style = () => ({ ...withValues(base, vals), name });

    const preview = h('canvas.ds-preview', { 'aria-label': 'Preview' }) as HTMLCanvasElement;
    const redraw = () => drawPreview(preview, app, style());
    const changed = () => {
      for (const c of ctls) c.load();
      redraw();
    };
    const set = (k: string, v: VarValue) => {
      vals[k] = v;
      changed();
    };
    const unsupported = (v: DimVar) => !supported(doc, v);
    const note = (v: DimVar) => (unsupported(v) ? `Not stored in this drawing's DXF version (needs ${v.since === 'AC1021' ? 'AutoCAD 2007' : 'AutoCAD 2000'} or later)` : v.name);

    // field widgets -----------------------------------------------------------------------------
    const row = (label: string, control: HTMLElement, title = '') => h('label.ds-row', { title }, h('span', label), control);
    const enableIf = (el: HTMLElement, v: DimVar | undefined, cond: () => boolean = () => true) => {
      const ok = () => !(v && unsupported(v)) && cond();
      const sync = () => {
        const on = ok();
        el.classList.toggle('disabled', !on);
        el.querySelectorAll('input,select,button').forEach((x) => ((x as HTMLInputElement).disabled = !on));
      };
      ctls.push({ el, load: sync });
    };
    const numberInput = (get: () => number, put: (n: number) => void, aria: string) => {
      const inp = h('input.inp.num', { type: 'number', step: 'any', 'aria-label': aria }) as HTMLInputElement;
      inp.addEventListener('input', () => {
        const n = Number(inp.value);
        if (inp.value.trim() !== '' && Number.isFinite(n)) put(n);
      });
      ctls.push({ el: inp, load: () => { if (document.activeElement !== inp) inp.value = String(+get().toFixed(8)); } });
      return inp;
    };
    const selectInput = (opts: [string | number, string][], get: () => string | number, put: (v: string) => void, aria: string) => {
      const sel = h('select.inp', { 'aria-label': aria }, ...opts.map(([v, l]) => h('option', { value: String(v) }, l))) as HTMLSelectElement;
      sel.addEventListener('change', () => put(sel.value));
      ctls.push({ el: sel, load: () => {
        const cur = String(get());
        if (![...sel.options].some((o) => o.value.toUpperCase() === cur.toUpperCase())) sel.append(h('option', { value: cur }, cur));
        sel.value = [...sel.options].find((o) => o.value.toUpperCase() === cur.toUpperCase())!.value;
      } });
      return sel;
    };
    const check = (get: () => boolean, put: (b: boolean) => void, label: string, title = '') => {
      const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
      cb.addEventListener('change', () => put(cb.checked));
      ctls.push({ el: cb, load: () => (cb.checked = get()) });
      return h('label.ds-check', { title }, cb, label);
    };
    const radios = (opts: [string, string][], get: () => string, put: (v: string) => void, nameKey: string) => {
      const wrap = h('div.ds-radios');
      const inputs = opts.map(([v, l]) => {
        const r = h('input', { type: 'radio', name: nameKey, value: v }) as HTMLInputElement;
        r.addEventListener('change', () => r.checked && put(v));
        wrap.append(h('label.ds-check', r, l));
        return r;
      });
      ctls.push({ el: wrap, load: () => inputs.forEach((r) => (r.checked = r.value === get())) });
      return wrap;
    };
    const colorInput = (k: string, aria: string) => {
      const sw = h('span.swatch');
      const lab = h('span');
      const b = h('button.btn.ds-color', { type: 'button', 'aria-label': aria }, sw, lab) as HTMLButtonElement;
      b.addEventListener('click', () => pickAci(b, true, (aci) => set(k, aci)));
      ctls.push({ el: b, load: () => {
        const a = num(vals[k]);
        sw.style.background = a === 0 || a === 256 ? 'transparent' : aciSwatchCss(a);
        lab.textContent = colorLabel(a);
      } });
      return b;
    };

    /** A generic control for one variable. */
    const field = (v: DimVar): HTMLElement => {
      const k = v.name;
      let c: HTMLElement;
      switch (v.kind) {
        case 'bool':
          c = check(() => !!num(vals[k]), (b) => set(k, b ? 1 : 0), v.label, note(v));
          enableIf(c, v, enabledRule(k));
          return c;
        case 'enum':
          c = selectInput(v.options!, () => num(vals[k]), (s) => set(k, Number(s)), v.label);
          break;
        case 'color':
          c = colorInput(k, v.label);
          break;
        case 'lweight':
          c = selectInput(LINEWEIGHTS.map((n) => [n, lwLabel(n)]), () => num(vals[k]), (s) => set(k, Number(s)), v.label);
          break;
        case 'string': {
          const inp = h('input.inp', { 'aria-label': v.label }) as HTMLInputElement;
          inp.addEventListener('input', () => set(k, inp.value));
          ctls.push({ el: inp, load: () => { if (document.activeElement !== inp) inp.value = String(vals[k] ?? ''); } });
          c = inp;
          break;
        }
        case 'style':
          c = selectInput(tableNames(app, 'STYLE', (r) => (r.num(70, 0) & 1) !== 0).map((n) => [n, n]), () => String(vals[k] || 'Standard'), (s) => set(k, s), v.label);
          break;
        case 'ltype':
          c = selectInput([['', 'ByBlock'], ['BYLAYER', 'ByLayer'], ...tableNames(app, 'LTYPE', (r) => /^by(block|layer)$/i.test(r.str(2))).map((n) => [n, n] as [string, string])],
            () => String(vals[k] ?? ''), (s) => set(k, s), v.label);
          break;
        case 'arrow':
          c = selectInput(arrowOptions(app, vals), () => String(vals[k] ?? '').toUpperCase(), (s) => set(k, s), v.label);
          break;
        default:
          c = numberInput(() => num(vals[k]), (n) => set(k, v.kind === 'int' ? Math.round(n) : n), v.label);
      }
      const r = row(v.label, c, note(v));
      enableIf(r, v, enabledRule(k));
      return r;
    };

    /** AutoCAD greys out fields that don't apply to the current settings. */
    const enabledRule = (k: string): (() => boolean) => {
      const alt = () => !!num(vals.DIMALT);
      const tolOn = () => !!num(vals.DIMTOL) || !!num(vals.DIMLIM);
      switch (k) {
        case 'DIMFXL': return () => !!num(vals.DIMFXLON);
        case 'DIMFRAC': return () => [4, 5].includes(num(vals.DIMLUNIT));
        case 'DIMDSEP': return () => ![4, 5].includes(num(vals.DIMLUNIT));
        case 'DIMTFILLCLR': return () => num(vals.DIMTFILL) === 2;
        case 'DIMALTU': case 'DIMALTD': case 'DIMALTF': case 'DIMALTRND': case 'DIMAPOST': case 'DIMALTZ': return alt;
        case 'DIMTDEC': case 'DIMTP': case 'DIMTOLJ': case 'DIMTZIN': return tolOn;
        case 'DIMTM': return () => tolOn() && tolMethod() !== 'sym';
        case 'DIMALTTD': case 'DIMALTTZ': return () => alt() && tolOn();
        case 'DIMSOXD': return () => !!num(vals.DIMTIX);
        default: return () => true;
      }
    };

    // composite controls (one AutoCAD control for several variables) ---------------------------
    const tolMethod = () => (num(vals.DIMLIM) ? 'lim' : num(vals.DIMTOL) ? (Math.abs(num(vals.DIMTP) - num(vals.DIMTM)) < 1e-12 ? 'sym' : 'dev') : num(vals.DIMGAP) < 0 ? 'basic' : 'none');
    const gapAbs = () => Math.abs(num(vals.DIMGAP));
    const zinBoxes = (k: string, feetInches: boolean) => {
      const bit = (b: number) => check(() => (num(vals[k]) & b) !== 0, (on) => set(k, on ? num(vals[k]) | b : num(vals[k]) & ~b), b === 4 || b === 1 && !feetInches ? 'Leading' : 'Trailing');
      const out = h('div.ds-radios');
      if (feetInches) {
        out.append(bit(4), bit(8));
        // low two bits: 0 = suppress 0 feet and 0 inches, 1 = keep both, 2 = keep 0 feet, 3 = keep 0 inches
        const feet = () => [0, 3].includes(num(vals[k]) & 3);
        const inches = () => [0, 2].includes(num(vals[k]) & 3);
        const put = (f: boolean, i: boolean) => set(k, (num(vals[k]) & ~3) | (f && i ? 0 : !f && !i ? 1 : f ? 3 : 2));
        out.append(check(feet, (b) => put(b, inches()), '0 feet'), check(inches, (b) => put(feet(), b), '0 inches'));
      } else out.append(bit(1), bit(2));
      return out;
    };
    const prefixSuffix = (k: string, token: string) => {
      const split = () => {
        const s = String(vals[k] ?? '').replace(/^\\X/, '');
        const i = s.indexOf(token);
        return i >= 0 ? [s.slice(0, i), s.slice(i + token.length)] : ['', s];
      };
      const put = (pre: string, suf: string) => {
        const below = String(vals[k] ?? '').startsWith('\\X') ? '\\X' : '';
        set(k, below + (pre ? pre + token + suf : suf));
      };
      const pre = h('input.inp', { 'aria-label': `${k} prefix` }) as HTMLInputElement;
      const suf = h('input.inp', { 'aria-label': `${k} suffix` }) as HTMLInputElement;
      pre.addEventListener('input', () => put(pre.value, suf.value));
      suf.addEventListener('input', () => put(pre.value, suf.value));
      ctls.push({ el: pre, load: () => { const [p, s] = split(); if (document.activeElement !== pre) pre.value = p; if (document.activeElement !== suf) suf.value = s; } });
      return [row('Prefix', pre), row('Suffix', suf)];
    };

    const COMPOSITES: Record<string, () => HTMLElement[]> = {
      DIMBLK1: () => {
        const first = () => String(num(vals.DIMSAH) ? vals.DIMBLK1 : vals.DIMBLK).toUpperCase();
        const second = () => String(num(vals.DIMSAH) ? vals.DIMBLK2 : vals.DIMBLK).toUpperCase();
        // like AutoCAD: picking First also sets Second; different arrows switch on DIMSAH
        const put = (a: string, b: string) => {
          if (a.toUpperCase() === b.toUpperCase()) Object.assign(vals, { DIMSAH: 0, DIMBLK: a, DIMBLK1: a, DIMBLK2: a });
          else Object.assign(vals, { DIMSAH: 1, DIMBLK1: a, DIMBLK2: b });
          changed();
        };
        const opts = arrowOptions(app, vals);
        const v1 = VAR_BY_NAME.get('DIMBLK1')!;
        const r1 = row('First', selectInput(opts, first, (s) => put(s, s), 'First arrowhead'), note(v1));
        const r2 = row('Second', selectInput(opts, second, (s) => put(first(), s), 'Second arrowhead'), note(v1));
        return [r1, r2];
      },
      DIMCEN: () => {
        const kind = () => (num(vals.DIMCEN) === 0 ? 'none' : num(vals.DIMCEN) > 0 ? 'mark' : 'line');
        let size = Math.abs(num(vals.DIMCEN)) || Math.abs(num(init.DIMCEN)) || st0().asz / st0().scale;
        const apply = (k: string) => set('DIMCEN', k === 'none' ? 0 : k === 'mark' ? size : -size);
        const sizeIn = numberInput(() => Math.abs(num(vals.DIMCEN)) || size, (n) => { size = Math.abs(n); if (kind() !== 'none') apply(kind()); }, 'Center mark size');
        const sr = row('Size', sizeIn);
        enableIf(sr, undefined, () => kind() !== 'none');
        return [radios([['none', 'None'], ['mark', 'Mark'], ['line', 'Line']], kind, apply, 'dscen'), sr];
      },
      DIMGAP: () => {
        const off = row('Offset from dim line', numberInput(gapAbs, (n) => set('DIMGAP', (num(vals.DIMGAP) < 0 ? -1 : 1) * Math.abs(n)), 'Offset from dim line'));
        // a frame is a negative DIMGAP, which is also how the Tolerances tab's "Basic" method is stored
        const fr = check(() => num(vals.DIMGAP) < 0, (b) => set('DIMGAP', (b ? -1 : 1) * gapAbs()), 'Draw frame around text');
        return [off, fr];
      },
      DIMTIH: () => {
        const mode = () => (num(vals.DIMTIH) && num(vals.DIMTOH) ? 'h' : !num(vals.DIMTIH) && num(vals.DIMTOH) ? 'iso' : 'aligned');
        const put = (m: string) => {
          Object.assign(vals, m === 'h' ? { DIMTIH: 1, DIMTOH: 1 } : m === 'iso' ? { DIMTIH: 0, DIMTOH: 1 } : { DIMTIH: 0, DIMTOH: 0 });
          changed();
        };
        return [radios([['h', 'Horizontal'], ['aligned', 'Aligned with dimension line'], ['iso', 'ISO standard']], mode, put, 'dsalign')];
      },
      DIMTOL: () => {
        const put = (m: string) => {
          const gap = gapAbs();
          // Basic draws its frame through a negative DIMGAP; other methods keep the user's frame setting
          const wasBasic = tolMethod() === 'basic';
          Object.assign(vals, {
            DIMTOL: m === 'sym' || m === 'dev' ? 1 : 0, DIMLIM: m === 'lim' ? 1 : 0,
            DIMGAP: m === 'basic' ? -gap : wasBasic ? gap : num(vals.DIMGAP),
          });
          if (m === 'sym') vals.DIMTM = vals.DIMTP;
          if (m === 'dev' && num(vals.DIMTM) === num(vals.DIMTP)) vals.DIMTM = 0;
          changed();
        };
        return [row('Method', selectInput([['none', 'None'], ['sym', 'Symmetrical'], ['dev', 'Deviation'], ['lim', 'Limits'], ['basic', 'Basic']], tolMethod, put, 'Tolerance method'))];
      },
      DIMTP: () => {
        const r = row('Upper value', numberInput(() => num(vals.DIMTP), (n) => { vals.DIMTP = n; if (tolMethod() === 'sym' || num(vals.DIMTOL) && num(vals.DIMTM) === n) vals.DIMTM = n; changed(); }, 'Upper value'));
        enableIf(r, VAR_BY_NAME.get('DIMTP'), enabledRule('DIMTP'));
        return [r];
      },
      DIMJOGANG: () => {
        // stored in radians, edited in degrees
        const v = VAR_BY_NAME.get('DIMJOGANG')!;
        const r = row(v.label, numberInput(() => (num(vals.DIMJOGANG) * 180) / Math.PI, (n) => set('DIMJOGANG', (n * Math.PI) / 180), v.label), note(v));
        enableIf(r, v);
        return [r];
      },
      DIMZIN: () => [row('Zero suppression', zinBoxes('DIMZIN', true))],
      DIMALTZ: () => { const r = row('Zero suppression', zinBoxes('DIMALTZ', true)); enableIf(r, VAR_BY_NAME.get('DIMALTZ'), enabledRule('DIMALTZ')); return [r]; },
      DIMTZIN: () => { const r = row('Zero suppression', zinBoxes('DIMTZIN', true)); enableIf(r, VAR_BY_NAME.get('DIMTZIN'), enabledRule('DIMTZIN')); return [r]; },
      DIMALTTZ: () => { const r = row('Zero suppression', zinBoxes('DIMALTTZ', true)); enableIf(r, VAR_BY_NAME.get('DIMALTTZ'), enabledRule('DIMALTTZ')); return [r]; },
      DIMAZIN: () => { const r = row('Zero suppression', zinBoxes('DIMAZIN', false)); enableIf(r, VAR_BY_NAME.get('DIMAZIN')); return [r]; },
      DIMPOST: () => prefixSuffix('DIMPOST', '<>'),
      DIMAPOST: () => {
        const rows = prefixSuffix('DIMAPOST', '[]');
        const place = () => (String(vals.DIMAPOST ?? '').startsWith('\\X') ? 'below' : 'after');
        const put = (p: string) => {
          const s = String(vals.DIMAPOST ?? '').replace(/^\\X/, '');
          set('DIMAPOST', (p === 'below' ? '\\X' : '') + s);
        };
        const wrap = h('div', ...rows, h('div.ds-sub', 'Placement'), radios([['after', 'After primary value'], ['below', 'Below primary value']], place, put, 'dsaltplace'));
        enableIf(wrap, VAR_BY_NAME.get('DIMAPOST'), enabledRule('DIMAPOST'));
        return [wrap];
      },
    };
    /** Variables shown by a composite control (not as their own field). */
    const HIDDEN = new Set(['DIMBLK2', 'DIMBLK', 'DIMSAH', 'DIMTOH', 'DIMLIM']);
    const st0 = () => style();

    // tabs ----------------------------------------------------------------------------------------
    const tabBar = h('div.ds-tabs', { role: 'tablist' });
    const pages = new Map<Tab, HTMLElement>();
    for (const t of TABS) {
      const page = h('div.ds-page', { role: 'tabpanel', 'data-tab': t });
      const groups = new Map<string, HTMLElement>();
      for (const v of DIM_VARS.filter((x) => x.tab === t)) {
        if (HIDDEN.has(v.name)) continue;
        let fs = groups.get(v.group);
        if (!fs) {
          fs = h('fieldset.ds-group', h('legend', v.group));
          groups.set(v.group, fs);
          page.append(fs);
        }
        const els = COMPOSITES[v.name] ? COMPOSITES[v.name]() : [field(v)];
        fs.append(...els);
      }
      pages.set(t, page);
      tabBar.append(h('button.ds-tab', { role: 'tab', type: 'button', 'data-tab': t, onclick: () => show(t) }, t));
    }
    const pageHost = h('div.ds-pages', ...pages.values());
    const show = (t: Tab) => {
      for (const [k, p] of pages) p.hidden = k !== t;
      tabBar.querySelectorAll('.ds-tab').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.tab === t));
    };

    const body = h('div.modal-body.ds-edit', tabBar, h('div.ds-edit-main', pageHost, h('div.ds-side', preview, h('div.ds-hint', 'Preview of ' + name))));
    const m = modal(title, body, [
      btn('OK', () => { m.close(); resolve(vals); }, { 'data-ok': true }),
      btn('Cancel', () => { m.close(); resolve(null); }, { 'data-cancel': true }),
    ], '.ds-edit-modal');
    show(startTab);
    changed();
    requestAnimationFrame(redraw);
  });
}

// ---- Dimension Style Manager ------------------------------------------------------------------------
const OVERRIDE_ITEM = '\u0000override';

/** Open the Dimension Style Manager. */
export function openDimStyleManager(app: App, select?: string): void {
  const doc = () => app.doc;
  let filter: 'all' | 'used' = 'all';
  let selected = listStyles(doc()).find((n) => n.toUpperCase() === select?.toUpperCase()) ?? currentStyle(doc());

  const curLabel = h('div.ds-current');
  const list = h('div.ds-list', { role: 'listbox', 'aria-label': 'Styles' });
  const preview = h('canvas.ds-preview', { 'aria-label': 'Style preview' }) as HTMLCanvasElement;
  const desc = h('div.ds-desc');
  const prevName = h('span.ds-prevname');
  const filterSel = h('select.inp', { 'aria-label': 'List' }, h('option', { value: 'all' }, 'All styles'), h('option', { value: 'used' }, 'Styles in use')) as HTMLSelectElement;
  filterSel.addEventListener('change', () => { filter = filterSel.value as 'all' | 'used'; refresh(); });

  const overrides = () => Object.keys(app.dimOverrides).length > 0;
  const selectedStyle = (): DimStyle => {
    const st = dimStyle(doc(), selected === OVERRIDE_ITEM ? currentStyle(doc()) : selected);
    return selected === OVERRIDE_ITEM ? withValues(st, app.dimOverrides) : st;
  };

  const run = <T>(label: string, fn: (tx: Tx) => T): T | undefined => {
    try {
      return app.editor.styleTx(label, fn);
    } catch (e) {
      alertBox('Dimension Style Manager', (e as Error).message);
      return undefined;
    }
  };

  const refresh = () => {
    const d = doc();
    const cur = currentStyle(d);
    curLabel.textContent = `Current dimension style: ${cur}`;
    const used = stylesInUse(d);
    const names = listStyles(d).filter((n) => filter === 'all' || used.has(n.toUpperCase()));
    if (selected !== OVERRIDE_ITEM && !listStyles(d).some((n) => n.toUpperCase() === selected.toUpperCase())) selected = cur;
    if (selected === OVERRIDE_ITEM && !overrides()) selected = cur;
    clear(list);
    for (const n of names) {
      const item = h('div.ds-item', { role: 'option', 'data-name': n, 'aria-selected': String(n === selected), title: used.has(n.toUpperCase()) ? 'In use' : '' },
        n.toUpperCase() === cur.toUpperCase() ? h('b', n) : n);
      item.classList.toggle('sel', n === selected);
      item.addEventListener('click', () => { selected = n; refresh(); });
      item.addEventListener('dblclick', () => { selected = n; doRename(); });
      list.append(item);
      if (n.toUpperCase() === cur.toUpperCase() && overrides()) {
        const ov = h('div.ds-item.ds-override', { role: 'option', 'data-name': '<style overrides>', 'aria-selected': String(selected === OVERRIDE_ITEM) }, '<style overrides>');
        ov.classList.toggle('sel', selected === OVERRIDE_ITEM);
        ov.addEventListener('click', () => { selected = OVERRIDE_ITEM; refresh(); });
        list.append(ov);
      }
    }
    const st = selectedStyle();
    if (selected === OVERRIDE_ITEM) {
      const parts = Object.entries(app.dimOverrides).map(([k, v]) => `${VAR_BY_NAME.get(k)?.label ?? k} = ${v === '' ? 'default' : v}`);
      desc.textContent = `${cur} + ${parts.join(', ')}`;
    } else desc.textContent = `${selected}: ${styleSummary(st)}`;
    prevName.textContent = selected === OVERRIDE_ITEM ? '<style overrides>' : selected;
    drawPreview(preview, app, st);
    const isOv = selected === OVERRIDE_ITEM;
    buttons.current.disabled = isOv || selected.toUpperCase() === cur.toUpperCase();
    buttons.rename.disabled = isOv || /^standard$/i.test(selected);
    buttons.del.disabled = isOv || /^standard$/i.test(selected) || used.has(selected.toUpperCase());
    buttons.del.title = buttons.del.disabled && !isOv ? 'Styles that are current or in use cannot be deleted' : '';
    buttons.saveOv.hidden = !overrides();
    buttons.clearOv.hidden = !overrides();
  };

  const doSetCurrent = async () => {
    if (overrides() && !(await confirmBox('Dimension Style - Set Current', 'Setting another style current discards the style overrides. Continue?'))) return;
    app.dimOverrides = {};
    run('Set current dimension style', (tx) => setCurrent(doc(), selected, tx));
    app.log(`Current dimension style: ${selected}`);
    refresh();
  };

  const doNew = async () => {
    const startSel = h('select.inp', { 'aria-label': 'Start With' }, ...listStyles(doc()).map((n) => h('option', { value: n }, n))) as HTMLSelectElement;
    startSel.value = selected === OVERRIDE_ITEM ? currentStyle(doc()) : selected;
    let n = 1;
    while (listStyles(doc()).some((s) => s.toUpperCase() === `COPY OF ${startSel.value}`.toUpperCase() + (n > 1 ? ` (${n})` : ''))) n++;
    const name = await askText('Create New Dimension Style', 'New Style Name', `Copy of ${startSel.value}${n > 1 ? ` (${n})` : ''}`, h('label', 'Start With', startSel));
    if (!name) return;
    if (listStyles(doc()).some((s) => s.toUpperCase() === name.toUpperCase())) return alertBox('Create New Dimension Style', `A dimension style named "${name}" already exists.`);
    if (/[<>/\\":;?*|=`]/.test(name)) return alertBox('Create New Dimension Style', `"${name}" contains characters that style names cannot use.`);
    const vals = await editStyleDialog(app, `New Dimension Style: ${name}`, name, readStyle(doc(), startSel.value));
    if (!vals) return;
    if (run('New dimension style', (tx) => createStyle(doc(), name, startSel.value, tx, vals))) {
      selected = name;
      app.log(`Dimension style "${name}" created.`);
    }
    refresh();
  };

  const doModify = async () => {
    if (selected === OVERRIDE_ITEM) return doOverride();
    const name = selected;
    const vals = await editStyleDialog(app, `Modify Dimension Style: ${name}`, name, readStyle(doc(), name));
    if (!vals) return;
    const n = run('Modify dimension style', (tx) => {
      writeStyle(doc(), name, vals, tx);
      return regenStyle(doc(), name, tx);
    });
    if (n !== undefined) app.log(`Dimension style "${name}" modified${n ? `; ${n} dimension(s) updated` : ''}.`);
    refresh();
  };

  const doOverride = async () => {
    const cur = currentStyle(doc());
    const baseVals = readStyle(doc(), cur);
    const vals = await editStyleDialog(app, `Override Current Style: ${cur}`, cur, { ...baseVals, ...app.dimOverrides });
    if (!vals) return;
    const diff: Vals = {};
    for (const v of DIM_VARS) {
      const a = vals[v.name], b = baseVals[v.name];
      if (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) > 1e-12 : String(a ?? '') !== String(b ?? '')) diff[v.name] = a;
    }
    app.dimOverrides = diff;
    selected = Object.keys(diff).length ? OVERRIDE_ITEM : cur;
    app.log(Object.keys(diff).length ? `Style overrides set (${Object.keys(diff).length} value(s)); new dimensions use them.` : 'No style overrides.');
    refresh();
  };

  const doSaveOverrides = () => {
    const cur = currentStyle(doc());
    const n = run('Save overrides to style', (tx) => {
      writeStyle(doc(), cur, { ...readStyle(doc(), cur), ...app.dimOverrides }, tx);
      return regenStyle(doc(), cur, tx);
    });
    if (n === undefined) return;
    app.dimOverrides = {};
    selected = cur;
    app.log(`Overrides saved to "${cur}"${n ? `; ${n} dimension(s) updated` : ''}.`);
    refresh();
  };

  const doRename = async () => {
    if (selected === OVERRIDE_ITEM || /^standard$/i.test(selected)) return;
    const from = selected;
    const to = await askText('Rename Dimension Style', 'New name', from);
    if (!to || to === from) return;
    if (run('Rename dimension style', (tx) => (renameStyle(doc(), from, to, tx), true))) {
      selected = to;
      app.log(`Dimension style "${from}" renamed to "${to}".`);
    }
    refresh();
  };

  const doDelete = async () => {
    const name = selected;
    if (!(await confirmBox('Dimension Style - Delete', `Delete style "${name}"?`))) return;
    if (run('Delete dimension style', (tx) => (deleteStyle(doc(), name, tx), true))) app.log(`Dimension style "${name}" deleted.`);
    refresh();
  };

  const doCompare = () => {
    const names = listStyles(doc());
    const a = h('select.inp', { 'aria-label': 'Compare' }, ...names.map((n) => h('option', { value: n }, n))) as HTMLSelectElement;
    const b = h('select.inp', { 'aria-label': 'With' }, h('option', { value: '' }, '<none>'), ...names.map((n) => h('option', { value: n }, n))) as HTMLSelectElement;
    a.value = selected === OVERRIDE_ITEM ? currentStyle(doc()) : selected;
    b.value = names.find((n) => n.toUpperCase() !== a.value.toUpperCase()) ?? '';
    const out = h('div.ds-compare');
    const show = (v: VarValue) => (typeof v === 'number' ? String(+v.toFixed(8)) : v === '' ? '(default)' : String(v));
    const fill = () => {
      clear(out);
      const rows = b.value
        ? compareStyles(doc(), a.value, b.value)
        : DIM_VARS.map((v) => ({ name: v.name, label: v.label, a: readStyle(doc(), a.value)[v.name], b: '' as VarValue }));
      if (!rows.length) {
        out.append(h('p', 'The two styles are identical.'));
        return;
      }
      out.append(h('p', b.value ? `${rows.length} difference(s) found:` : `All properties of ${a.value}:`));
      out.append(h('table', h('thead', h('tr', h('th', 'Description'), h('th', 'Variable'), h('th', a.value), b.value ? h('th', b.value) : null)),
        h('tbody', ...rows.map((r) => h('tr', h('td', `${VAR_BY_NAME.get(r.name)?.tab ?? ''}: ${r.label}`), h('td', r.name), h('td', show(r.a)), b.value ? h('td', show(r.b)) : null)))));
    };
    a.addEventListener('change', fill);
    b.addEventListener('change', fill);
    fill();
    const m = modal('Compare Dimension Styles', h('div.modal-body', h('div.ds-row2', h('label', 'Compare', a), h('label', 'With', b)), out), [
      btn('Close', () => m.close(), { 'data-cancel': true }),
    ], '.ds-compare-modal');
  };

  const buttons = {
    current: btn('Set Current', doSetCurrent),
    newB: btn('New…', doNew),
    modify: btn('Modify…', doModify),
    override: btn('Override…', doOverride),
    compare: btn('Compare…', doCompare),
    rename: btn('Rename…', doRename),
    del: btn('Delete', doDelete),
    saveOv: btn('Save overrides to style', doSaveOverrides),
    clearOv: btn('Clear overrides', () => { app.dimOverrides = {}; app.log('Style overrides cleared.'); refresh(); }),
  };

  const body = h('div.modal-body.ds-manager',
    curLabel,
    h('div.ds-manager-main',
      h('div.ds-col', h('div.ds-sub', 'Styles:'), list, h('label.ds-sub', 'List:', filterSel)),
      h('div.ds-col.grow', h('div.ds-sub', 'Preview of: ', prevName), preview, h('div.ds-sub', 'Description'), desc),
      h('div.ds-col.ds-actions', ...Object.values(buttons))));
  const m = modal('Dimension Style Manager', body, [btn('Close', () => m.close(), { 'data-cancel': true })], '.ds-manager-modal');
  refresh();
}
