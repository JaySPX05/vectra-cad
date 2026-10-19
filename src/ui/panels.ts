import { openDimStyleManager } from './dimstyle-dialog';
import type { DxfRecord } from '../dxf/record';
import { valueType } from '../dxf/groups';
import { aciSwatchCss, rgbToCss } from '../model/aci';
import { ACAD_VERSIONS, withChildren } from '../model/database';
import { vertices } from '../render/geometry';
import { decodeHatch } from '../render/hatch';
import { DIMVAR, dimStyleFor, readDimOverrides } from '../dims/style';
import { type DynText, readDynamic } from '../dims/dynamic';

/** Dynamic label defaults from the drawing extent (same rule as DIMDYN). */
function defaultDynamic(app: App): DynText {
  const ext = app.scene.computeExtents();
  const diag = ext ? Math.hypot(ext[2] - ext[0], ext[3] - ext[1]) : 100;
  const nice = (v: number) => +v.toPrecision(2);
  return { ratio: 0.08, min: nice(diag / 250), max: nice(diag / 25), round: true };
}
import type { App } from './app';
import { clear, h } from './dom';
import { groupMeaning, HANDLE_CODES } from './groupinfo';

const fmt = (v: number) => (Number.isFinite(v) ? (Math.abs(v) >= 1e7 || (Math.abs(v) < 1e-5 && v !== 0) ? v.toExponential(5) : String(+v.toFixed(6))) : '—');
const DEG = Math.PI / 180;

// ---- ACI colour picker --------------------------------------------------------------------------
let openPicker: HTMLElement | null = null;
function closePicker() {
  openPicker?.remove();
  openPicker = null;
}
document.addEventListener('mousedown', (e) => {
  if (openPicker && !openPicker.contains(e.target as Node)) closePicker();
});

/** AutoCAD-style index colour palette. `special` adds ByLayer / ByBlock buttons. */
export function pickAci(anchor: HTMLElement, special: boolean, onPick: (aci: number) => void) {
  closePicker();
  const cell = (i: number) => h('button.aci', { style: `background:${aciSwatchCss(i)}`, title: `ACI ${i}`, onclick: () => { closePicker(); onPick(i); } });
  const grid = h('div.aci-grid');
  // 24 hues x 10 shades, laid out like the AutoCAD dialog (shades in rows)
  for (let shade = 0; shade < 10; shade++) for (let hue = 0; hue < 24; hue++) grid.append(cell(10 + hue * 10 + shade));
  const pop = h('div.popover',
    h('div.aci-row', ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(cell)),
    grid,
    h('div.aci-row', ...[250, 251, 252, 253, 254, 255].map(cell)),
    special ? h('div.aci-row', h('button.btn.small', { onclick: () => { closePicker(); onPick(256); } }, 'ByLayer'), h('button.btn.small', { onclick: () => { closePicker(); onPick(0); } }, 'ByBlock')) : null,
  );
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.min(window.innerWidth - 330, r.left) + 'px';
  pop.style.top = Math.min(window.innerHeight - 260, r.bottom + 4) + 'px';
  document.body.append(pop);
  openPicker = pop;
}

function colorSwatch(_rec: DxfRecord | null, aci: number, trueColor?: number) {
  const css = trueColor !== undefined ? rgbToCss(trueColor) : aci === 0 || aci === 256 ? 'transparent' : aciSwatchCss(aci);
  return h('span.swatch', { style: `background:${css}` });
}

function colorLabel(aci: number, rgb?: number): string {
  if (rgb !== undefined) return `RGB ${(rgb >> 16) & 255},${(rgb >> 8) & 255},${rgb & 255}`;
  if (aci === 256) return 'ByLayer';
  if (aci === 0) return 'ByBlock';
  const names: Record<number, string> = { 1: 'Red', 2: 'Yellow', 3: 'Green', 4: 'Cyan', 5: 'Blue', 6: 'Magenta', 7: 'White' };
  return names[aci] ? `${aci} ${names[aci]}` : `ACI ${aci}`;
}

const LINEWEIGHTS = [-1, -2, -3, 0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];
const lwLabel = (v: number) => (v === -1 ? 'ByLayer' : v === -2 ? 'ByBlock' : v === -3 ? 'Default' : `${(v / 100).toFixed(2)} mm`);

// ---- Layers ------------------------------------------------------------------------------------------
export class LayersPanel {
  el = h('div.panel-body');
  constructor(private app: App) {
    app.onDocument.push(() => this.render());
  }
  render() {
    const app = this.app;
    clear(this.el);
    const table = app.doc.table('LAYER');
    if (!table) {
      this.el.append(h('div.empty', 'No LAYER table in this file.'));
      return;
    }
    const counts = new Map<string, number>();
    for (const g of app.scene.items) counts.set(g.rec.layer.toUpperCase(), (counts.get(g.rec.layer.toUpperCase()) ?? 0) + 1);
    const list = h('div.layer-list');
    for (const l of table.entries) {
      const name = l.str(2);
      const c = l.num(62, 7);
      const on = c >= 0;
      const frozen = (l.num(70, 0) & 1) !== 0;
      const current = name.toUpperCase() === app.currentLayer.toUpperCase();
      const sw = h('button.swatch-btn', { title: 'Layer colour', style: `background:${l.has(420) ? rgbToCss(l.num(420, 0)) : aciSwatchCss(Math.abs(c))}` });
      sw.addEventListener('click', () => pickAci(sw, false, (aci) => app.editor.setLayerState(name, { color: aci })));
      list.append(h('div.layer-row' + (current ? '.current' : ''),
        h('button.icon' + (current ? '.on' : ''), { title: 'Make current', onclick: () => { app.currentLayer = name; this.render(); } }, current ? '✔' : '·'),
        h('button.icon' + (on ? '.on' : '.off'), { title: on ? 'On (click to turn off)' : 'Off (click to turn on)', onclick: () => app.editor.setLayerState(name, { on: !on }) }, on ? '◉' : '○'),
        h('button.icon' + (frozen ? '.off' : '.on'), { title: frozen ? 'Frozen (click to thaw)' : 'Thawed (click to freeze)', onclick: () => app.editor.setLayerState(name, { frozen: !frozen }) }, frozen ? '❄' : '☀'),
        sw,
        h('span.layer-name', { title: `${name} — linetype ${l.str(6, 'Continuous')}, lineweight ${lwLabel(l.num(370, -3))}` }, name),
        h('span.layer-count', String(counts.get(name.toUpperCase()) ?? '')),
      ));
    }
    this.el.append(list);
  }
}

// ---- Explorer (drawing database) -------------------------------------------------------------------------
export class ExplorerPanel {
  el = h('div.panel-body');
  private filter = '';
  private tab: 'header' | 'tables' | 'blocks' | 'objects' | 'stats' = 'stats';
  constructor(private app: App) {
    app.onDocument.push(() => this.render());
  }
  render() {
    const app = this.app;
    clear(this.el);
    const tabs = h('div.tabs', ...(['stats', 'header', 'tables', 'blocks', 'objects'] as const).map((t) =>
      h('button.tab' + (this.tab === t ? '.active' : ''), { onclick: () => { this.tab = t; this.render(); } }, { stats: 'Entities', header: 'Header', tables: 'Tables', blocks: 'Blocks', objects: 'Objects' }[t])));
    const search = h('input.search', { placeholder: 'Filter…', value: this.filter }) as HTMLInputElement;
    search.addEventListener('input', () => {
      this.filter = search.value;
      this.renderList(list);
    });
    const list = h('div.tree');
    this.el.append(tabs, this.tab === 'stats' ? '' : search, list);
    this.renderList(list);
    void app;
  }
  private renderList(list: HTMLElement) {
    clear(list);
    const app = this.app;
    const f = this.filter.toUpperCase();
    const match = (s: string) => !f || s.toUpperCase().includes(f);
    const item = (label: string, detail: string, onClick?: () => void) =>
      h('div.tree-item' + (onClick ? '.link' : ''), { onclick: onClick ?? null }, h('span', label), h('span.dim', detail));
    if (this.tab === 'stats') {
      const counts = new Map<string, number>();
      for (const g of app.scene.items) counts.set(g.rec.type, (counts.get(g.rec.type) ?? 0) + 1);
      const ps = app.doc.entities.filter((e) => e.num(67, 0) === 1).length;
      list.append(h('div.section-title', 'Model space'));
      for (const [t, n] of [...counts].sort((a, b) => b[1] - a[1])) {
        list.append(item(t, String(n), () => app.select(app.scene.items.filter((g) => g.rec.type === t).map((g) => g.rec), 'replace')));
      }
      if (ps) list.append(h('div.dim.pad', `${ps} paper-space entities (layouts not shown)`));
      const unsup = [...app.scene.env.unsupported];
      if (unsup.length) {
        list.append(h('div.section-title', 'Not drawn'));
        for (const [t, n] of unsup) list.append(item(t, String(n)));
        list.append(h('div.dim.pad', 'These objects are kept and saved unchanged; they just are not rendered (e.g. ACIS solids, proxies).'));
      }
      return;
    }
    if (this.tab === 'header') {
      for (const v of app.doc.headerVars) {
        if (!match(v.name)) continue;
        list.append(item(v.name, v.groups.map((g) => g.value.trim()).join(', ')));
      }
      return;
    }
    if (this.tab === 'tables') {
      for (const t of app.doc.tables) {
        list.append(h('div.section-title', `${t.name} (${t.entries.length})`));
        for (const e of t.entries) if (match(e.str(2))) list.append(item(e.str(2) || e.type, e.handle ?? '', () => app.inspect(e)));
      }
      return;
    }
    if (this.tab === 'blocks') {
      const uses = new Map<string, number>();
      for (const g of app.scene.items) if (g.rec.type === 'INSERT') uses.set(g.rec.str(2).toUpperCase(), (uses.get(g.rec.str(2).toUpperCase()) ?? 0) + 1);
      for (const b of app.doc.blocks) {
        const name = b.begin.str(2);
        if (!match(name)) continue;
        const flags = b.begin.num(70, 0);
        const tags = [flags & 1 ? 'anonymous' : '', flags & 4 ? 'xref' : '', flags & 2 ? 'attributes' : ''].filter(Boolean).join(', ');
        list.append(item(name, `${b.entities.length} ent${uses.get(name.toUpperCase()) ? ` · ${uses.get(name.toUpperCase())} inserts` : ''}${tags ? ' · ' + tags : ''}`, () => {
          const refs = app.scene.items.filter((g) => g.rec.str(2).toUpperCase() === name.toUpperCase() && (g.rec.type === 'INSERT' || g.rec.type.endsWith('DIMENSION')));
          if (refs.length) app.select(refs.map((g) => g.rec), 'replace');
          app.inspect(b.begin);
        }));
      }
      return;
    }
    if (this.tab === 'objects') {
      for (const o of app.doc.objects.slice(0, 2000)) {
        const label = o.type + (o.get(3) ? ` ${o.str(3)}` : '');
        if (!match(label) && !match(o.handle ?? '')) continue;
        list.append(item(label, o.handle ?? '', () => app.inspect(o)));
      }
      if (app.doc.objects.length > 2000) list.append(h('div.dim.pad', `Showing 2000 of ${app.doc.objects.length}`));
    }
  }
}

// ---- Properties / inspector -------------------------------------------------------------------------------
export class PropertiesPanel {
  el = h('div.panel-body');
  constructor(private app: App) {
    app.onSelection.push(() => this.render());
    app.onInspect.push(() => this.render());
  }

  render() {
    const app = this.app;
    clear(this.el);
    if (!app.doc) return;
    const ins = app.inspected;
    if (ins) return this.renderRecord(ins, null, true);
    const sel = [...app.selection];
    if (!sel.length) return this.renderDrawingInfo();
    if (sel.length === 1) return this.renderRecord(sel[0], sel[0], false);
    this.renderMulti(sel);
  }

  private row(label: string, value: Node | string, title?: string) {
    return h('div.prop-row', h('span.prop-label', { title: title ?? label }, label), h('span.prop-value', value));
  }

  private renderDrawingInfo() {
    const app = this.app;
    const d = app.doc;
    const ext = app.scene.extents;
    this.el.append(
      h('div.section-title', 'Drawing'),
      this.row('File', app.fileName),
      this.row('Version', `${ACAD_VERSIONS[d.version] ?? '?'} (${d.version})`),
      this.row('Units', app.unitsLabel + ` ($INSUNITS ${d.headerNum('$INSUNITS', 0)})`),
      this.row('Entities', `${app.scene.items.length} model space`),
      this.row('Layers', String(d.table('LAYER')?.entries.length ?? 0)),
      this.row('Blocks', String(d.blocks.length)),
      this.row('Objects', String(d.objects.length)),
      this.row('Extents', ext ? `${fmt(ext[0])}, ${fmt(ext[1])} → ${fmt(ext[2])}, ${fmt(ext[3])}` : '—'),
      this.row('LTSCALE', fmt(d.headerNum('$LTSCALE', 1))),
      this.row('Current layer', app.currentLayer),
      h('div.hint', 'Click an object to inspect it. Drag left→right for window selection, right→left for crossing. Type a command (HELP lists them).'),
    );
  }

  private renderMulti(sel: DxfRecord[]) {
    const app = this.app;
    const types = new Map<string, number>();
    for (const r of sel) types.set(r.type, (types.get(r.type) ?? 0) + 1);
    this.el.append(h('div.section-title', `${sel.length} objects selected`));
    for (const [t, n] of types) this.el.append(this.row(t, String(n)));
    this.el.append(h('div.section-title', 'General'), ...this.generalRows(sel));
    const dims = sel.filter((r) => r.type === 'DIMENSION');
    if (dims.length === sel.length) {
      const heights = dims.map((r) => dimStyleFor(this.app.doc, r).txt);
      const same = heights.every((x) => Math.abs(x - heights[0]) < 1e-9);
      const inp = h('input.inp', { value: same ? fmt(heights[0]) : '', placeholder: '*VARIES*' }) as HTMLInputElement;
      inp.addEventListener('change', () => {
        const n = Number(inp.value);
        if (inp.value.trim() === '') this.app.editor.setDimTextHeight(dims, null);
        else if (n > 0) this.app.editor.setDimTextHeight(dims, n);
      });
      inp.addEventListener('keydown', (e) => e.stopPropagation());
      this.el.append(h('div.section-title', 'Dimensions'), this.dynamicRow(dims, dims.map(readDynamic).find(Boolean) ?? null), this.row('Text height', inp));
    }
    this.el.append(h('div.btn-row', h('button.btn', { onclick: () => app.zoomSelection() }, 'Zoom to selection'), ' ', h('button.btn', { onclick: () => app.clearSelection() }, 'Clear selection')));
  }

  /** Layer / colour / linetype / lineweight editors that work on one or many entities. */
  private generalRows(recs: DxfRecord[]): HTMLElement[] {
    const app = this.app;
    const same = <T>(f: (r: DxfRecord) => T): T | null => {
      const v = f(recs[0]);
      return recs.every((r) => f(r) === v) ? v : null;
    };
    // layer
    const layerSel = h('select.inp') as HTMLSelectElement;
    const layerName = same((r) => r.layer);
    if (layerName === null) layerSel.append(h('option', { value: '' }, '*VARIES*'));
    for (const l of app.doc.table('LAYER')?.entries ?? []) layerSel.append(h('option', { value: l.str(2), selected: l.str(2) === layerName }, l.str(2)));
    if (layerName !== null) layerSel.value = layerName;
    layerSel.addEventListener('change', () => layerSel.value && app.editor.setGroup(recs, 8, layerSel.value, 'Change layer'));
    // colour
    const aci = same((r) => r.num(62, 256));
    const rgb = same((r) => (r.has(420) ? r.num(420, 0) : -1));
    const colorBtn = h('button.inp.color-btn', aci === null ? '*VARIES*' : '') as HTMLButtonElement;
    if (aci !== null) colorBtn.append(colorSwatch(null, aci, rgb !== null && rgb >= 0 ? rgb : undefined), colorLabel(aci, rgb !== null && rgb >= 0 ? rgb : undefined));
    colorBtn.addEventListener('click', () => pickAci(colorBtn, true, (v) => app.editor.setGroup(recs, 62, v === 256 ? null : v, 'Change color')));
    // linetype
    const ltSel = h('select.inp') as HTMLSelectElement;
    const lt = same((r) => r.str(6, 'BYLAYER').toUpperCase());
    if (lt === null) ltSel.append(h('option', { value: '' }, '*VARIES*'));
    const ltNames = ['BYLAYER', 'BYBLOCK', ...(app.doc.table('LTYPE')?.entries.map((e) => e.str(2)).filter((n) => !/^by(layer|block)$/i.test(n)) ?? [])];
    for (const n of ltNames) ltSel.append(h('option', { value: n }, n === 'BYLAYER' ? 'ByLayer' : n === 'BYBLOCK' ? 'ByBlock' : n));
    if (lt !== null) ltSel.value = ltNames.find((n) => n.toUpperCase() === lt) ?? 'BYLAYER';
    ltSel.addEventListener('change', () => ltSel.value && app.editor.setGroup(recs, 6, ltSel.value === 'BYLAYER' ? null : ltSel.value, 'Change linetype'));
    // lineweight
    const lwSel = h('select.inp') as HTMLSelectElement;
    const lw = same((r) => r.num(370, -1));
    if (lw === null) lwSel.append(h('option', { value: '' }, '*VARIES*'));
    for (const v of LINEWEIGHTS) lwSel.append(h('option', { value: String(v) }, lwLabel(v)));
    if (lw !== null) lwSel.value = String(lw);
    const modern = app.doc.isModern;
    lwSel.disabled = !modern;
    lwSel.addEventListener('change', () => lwSel.value && app.editor.setGroup(recs, 370, Number(lwSel.value) === -1 ? null : Number(lwSel.value), 'Change lineweight'));
    // linetype scale
    const lts = same((r) => r.num(48, 1));
    const ltsIn = h('input.inp', { value: lts === null ? '' : String(lts), placeholder: '*VARIES*' }) as HTMLInputElement;
    ltsIn.addEventListener('change', () => {
      const v = Number(ltsIn.value);
      if (v > 0) app.editor.setGroup(recs, 48, v === 1 ? null : v, 'Linetype scale');
    });
    return [
      this.row('Layer', layerSel),
      this.row('Color', colorBtn),
      this.row('Linetype', ltSel),
      this.row('Lineweight', lwSel, modern ? 'Lineweight (370)' : 'Lineweights need R2000+'),
      this.row('Linetype scale', ltsIn),
    ];
  }

  /** Full view of a record: computed properties, then every DXF group (editable). */
  private renderRecord(rec: DxfRecord, entity: DxfRecord | null, inspecting: boolean) {
    const app = this.app;
    const head = h('div.section-title.with-actions', h('span', `${rec.type}${rec.handle ? '  #' + rec.handle : ''}`));
    if (inspecting) head.append(h('button.btn.small', { onclick: () => app.inspect(null) }, '← Back'));
    this.el.append(head);
    if (entity) {
      this.el.append(h('div.btn-row', h('button.btn.small', { onclick: () => app.zoomSelection() }, 'Zoom to object')));
      this.el.append(...this.generalRows([entity]));
      const geo = this.geometryRows(entity);
      if (geo.length) this.el.append(h('div.section-title', 'Geometry'), ...geo);
    }
    // owner chain
    const owner = rec.owner;
    if (owner && owner !== '0') {
      const o = app.doc.byHandle(owner);
      this.el.append(this.row('Owner', h('a.link', { onclick: () => o && app.inspect(o) }, `${o?.type ?? '?'} #${owner}${o?.get(2) ? ' ' + o.str(2) : ''}`)));
    }
    this.el.append(h('div.section-title', `DXF groups (${rec.groups.length + 1})`));
    this.el.append(this.groupTable(rec, entity ?? (inspecting ? this.topLevelOf(rec) : null)));
    for (const [i, c] of rec.children.entries()) {
      const det = h('details.child', h('summary', `${c.type} ${i + 1}${c.get(2) ? ' — ' + c.str(2) : ''}${c.type === 'ATTRIB' ? ' = ' + c.str(1) : ''}`), this.groupTable(c, entity ?? rec));
      this.el.append(det);
    }
  }

  private topLevelOf(rec: DxfRecord): DxfRecord | null {
    for (const g of this.app.scene.items) for (const r of withChildren(g.rec)) if (r === rec) return g.rec;
    return null;
  }

  private groupTable(rec: DxfRecord, owner: DxfRecord | null): HTMLElement {
    const app = this.app;
    const t = h('div.groups');
    t.append(h('div.grow.head', h('span.gcode', '0'), h('span.gmean', 'Type'), h('span.gval.ro', rec.type)));
    let inXdata = false;
    rec.groups.forEach((g, i) => {
      if (g.code === 1001) inXdata = true;
      const meaning = groupMeaning(rec.type, g.code);
      const vt = valueType(g.code);
      let val: HTMLElement;
      if (HANDLE_CODES(g.code) && g.code !== 5 && g.value.trim() !== '0') {
        const target = app.doc.byHandle(g.value);
        val = h('span.gval', h('a.link', { title: target ? `${target.type}` : 'not found', onclick: () => target && this.goto(target) }, g.value.trim()), target ? h('span.dim', ` ${target.type}${target.get(2) ? ' ' + target.str(2) : ''}`) : '');
      } else if (g.code === 5 || g.code === 100) {
        val = h('span.gval.ro', g.value);
      } else {
        const inp = h('input.gval', { value: g.value, spellcheck: 'false', 'data-type': vt }) as HTMLInputElement;
        inp.addEventListener('change', () => {
          if (vt === 'float' || vt === 'int') {
            if (!Number.isFinite(Number(inp.value))) {
              inp.classList.add('bad');
              return;
            }
          }
          app.editor.setRawGroup(rec, i, inp.value, owner);
        });
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') inp.blur();
          e.stopPropagation();
        });
        val = inp;
      }
      if (g.code === 62 && Number(g.value) > 0 && Number(g.value) < 256) val.prepend(colorSwatch(null, Number(g.value)));
      t.append(h('div.grow' + (inXdata ? '.xdata' : '') + (g.code === 100 ? '.subclass' : ''), h('span.gcode', String(g.code)), h('span.gmean', { title: meaning }, meaning), val));
    });
    return t;
  }

  private goto(target: DxfRecord) {
    const app = this.app;
    const g = app.scene.geomOf(target);
    if (g) {
      app.inspect(null);
      app.select([target], 'replace');
      return;
    }
    app.inspect(target);
  }

  private geometryRows(r: DxfRecord): HTMLElement[] {
    const rows: HTMLElement[] = [];
    const row = (k: string, v: string) => rows.push(this.row(k, v));
    const pt = (code: number) => {
      const p = r.point(code);
      return `${fmt(p[0])}, ${fmt(p[1])}${p[2] ? ', ' + fmt(p[2]) : ''}`;
    };
    const extr = r.point(210, [0, 0, 1]);
    if (r.has(210) && !(extr[0] === 0 && extr[1] === 0 && extr[2] === 1)) row('Extrusion (OCS)', pt(210));
    switch (r.type) {
      case 'LINE': {
        const a = r.point(10), b = r.point(11);
        row('Start', pt(10));
        row('End', pt(11));
        row('Length', fmt(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])));
        row('Angle', fmt(((Math.atan2(b[1] - a[1], b[0] - a[0]) / DEG) + 360) % 360) + '°');
        break;
      }
      case 'CIRCLE': {
        const rad = r.num(40, 0);
        row('Center', pt(10));
        rows.push(this.editableNum('Radius', rad, (v) => v > 0 && this.app.editor.setGroup([r], 40, v, 'Radius')));
        row('Diameter', fmt(2 * rad));
        row('Circumference', fmt(2 * Math.PI * rad));
        row('Area', fmt(Math.PI * rad * rad));
        break;
      }
      case 'ARC': {
        const rad = r.num(40, 0), a0 = r.num(50, 0), a1 = r.num(51, 0);
        const sweep = ((a1 - a0) % 360 + 360) % 360 || 360;
        row('Center', pt(10));
        rows.push(this.editableNum('Radius', rad, (v) => v > 0 && this.app.editor.setGroup([r], 40, v, 'Radius')));
        row('Start angle', fmt(a0) + '°');
        row('End angle', fmt(a1) + '°');
        row('Total angle', fmt(sweep) + '°');
        row('Arc length', fmt(rad * sweep * DEG));
        break;
      }
      case 'ELLIPSE': {
        const m = r.point(11);
        const major = Math.hypot(m[0], m[1], m[2]);
        row('Center', pt(10));
        row('Major radius', fmt(major));
        row('Minor radius', fmt(major * r.num(40, 1)));
        row('Start / end param', `${fmt(r.num(41, 0))} / ${fmt(r.num(42, Math.PI * 2))} rad`);
        break;
      }
      case 'LWPOLYLINE': {
        const v = vertices(r, 10);
        const closed = (r.num(70, 0) & 1) === 1;
        let len = 0, area = 0;
        for (let i = 0; i < v.length - (closed ? 0 : 1); i++) {
          const a = v[i], b = v[(i + 1) % v.length];
          len += Math.hypot(b[0] - a[0], b[1] - a[1]);
          area += a[0] * b[1] - b[0] * a[1];
        }
        row('Vertices', String(v.length));
        row('Closed', closed ? 'Yes' : 'No');
        row('Length (chords)', fmt(len));
        if (closed) row('Area (chords)', fmt(Math.abs(area) / 2));
        if (r.all(42).some((b) => Number(b) !== 0)) row('Arc segments', String(r.all(42).filter((b) => Number(b) !== 0).length));
        if (r.has(43)) row('Constant width', fmt(r.num(43, 0)));
        break;
      }
      case 'POLYLINE': {
        const f = r.num(70, 0);
        row('Kind', f & 64 ? 'Polyface mesh' : f & 16 ? 'Polygon mesh' : f & 8 ? '3D polyline' : '2D polyline');
        row('Vertices', String(r.children.filter((c) => c.type === 'VERTEX').length));
        row('Closed', f & 1 ? 'Yes' : 'No');
        break;
      }
      case 'TEXT':
      case 'ATTRIB':
      case 'ATTDEF': {
        rows.push(this.editableText('Contents', r.get(1) ?? '', (v) => this.app.editor.setGroup([r], 1, v, 'Edit text')));
        if (r.type !== 'TEXT') row('Tag', r.str(2));
        row('Position', pt(10));
        rows.push(this.editableNum('Height', r.num(40, 0), (v) => v > 0 && this.app.editor.setGroup([r], 40, v, 'Text height')));
        row('Rotation', fmt(r.num(50, 0)) + '°');
        row('Style', r.str(7, 'Standard'));
        row('Justify', `${['Left', 'Center', 'Right', 'Aligned', 'Middle', 'Fit'][r.num(72, 0)] ?? '?'} / ${['Baseline', 'Bottom', 'Middle', 'Top'][r.num(r.type === 'TEXT' ? 73 : 74, 0)] ?? '?'}`);
        break;
      }
      case 'MTEXT': {
        const full = r.all(3).join('') + (r.get(1) ?? '');
        if (!r.has(3)) rows.push(this.editableText('Contents', full, (v) => this.app.editor.setGroup([r], 1, v, 'Edit text')));
        else row('Contents', full.length > 120 ? full.slice(0, 120) + '…' : full);
        row('Insertion', pt(10));
        row('Height', fmt(r.num(40, 0)));
        row('Width', fmt(r.num(41, 0)));
        row('Attachment', ['', 'Top left', 'Top center', 'Top right', 'Middle left', 'Middle center', 'Middle right', 'Bottom left', 'Bottom center', 'Bottom right'][r.num(71, 1)] ?? '?');
        row('Style', r.str(7, 'Standard'));
        break;
      }
      case 'INSERT': {
        const blk = this.app.doc.block(r.str(2));
        row('Block', r.str(2));
        row('Insertion', pt(10));
        row('Scale', `${fmt(r.num(41, 1))}, ${fmt(r.num(42, 1))}, ${fmt(r.num(43, 1))}`);
        row('Rotation', fmt(r.num(50, 0)) + '°');
        if (r.num(70, 1) > 1 || r.num(71, 1) > 1) row('Array', `${r.num(70, 1)} × ${r.num(71, 1)} @ ${fmt(r.num(44, 0))}, ${fmt(r.num(45, 0))}`);
        row('Block entities', blk ? String(blk.entities.length) : 'missing block!');
        for (const a of r.children) {
          const vi = a.indexOf(1);
          if (a.type === 'ATTRIB' && vi >= 0) rows.push(this.editableText(`@${a.str(2)}`, a.groups[vi].value, (v) => this.app.editor.setRawGroup(a, vi, v, r)));
        }
        break;
      }
      case 'HATCH': {
        const d = decodeHatch(r);
        row('Pattern', d.solid ? 'SOLID' : d.pattern);
        row('Boundary loops', String(d.loops.length));
        row('Pattern lines', String(d.lines.length));
        row('Pattern angle / scale', `${fmt(r.num(52, 0))}° / ${fmt(r.num(41, 1))}`);
        row('Associative', r.num(71, 0) ? 'Yes' : 'No');
        break;
      }
      case 'DIMENSION': {
        const types = ['Rotated/linear', 'Aligned', 'Angular', 'Diameter', 'Radius', 'Angular 3-point', 'Ordinate'];
        row('Type', types[r.num(70, 0) & 7] ?? '?');
        row('Measurement', r.has(42) ? fmt(r.num(42, 0)) : '—');
        rows.push(this.editableText('Text override', r.get(1) ?? '', (v) => this.app.editor.setDimensionText(r, v)));
        {
          const st = dimStyleFor(this.app.doc, r);
          const dyn = readDynamic(r);
          rows.push(this.dynamicRow([r], dyn));
          if (dyn) {
            row('Text height', `${fmt(st.txt)} (dynamic)`);
            rows.push(this.editableText('Height ratio %', fmt(dyn.ratio * 100), (v) => {
              const n = Number(v);
              if (n > 0) this.app.editor.setDimDynamic([r], { ...dyn, ratio: n / 100 });
            }));
          } else {
            // label height in drawing units (empty = back to the style's height)
            rows.push(this.editableText('Text height', fmt(st.txt), (v) => {
              const n = Number(v);
              if (v.trim() === '') this.app.editor.setDimTextHeight([r], null);
              else if (n > 0) this.app.editor.setDimTextHeight([r], n);
            }));
          }
          // DIMSCALE override for this dimension (empty = the style's value)
          const ov = readDimOverrides(r).get(DIMVAR.DIMSCALE);
          rows.push(this.editableText('Dim scale', ov ?? '', (v) => {
            const n = Number(v);
            this.app.editor.setDimOverride([r], DIMVAR.DIMSCALE, v.trim() === '' ? null : n > 0 ? n : null);
          }));
        }
        rows.push(this.row('Style', h('span.ds-prop', r.str(3, 'Standard'), ' ',
          h('button.btn.small', { title: 'Open the Dimension Style Manager on this style', onclick: () => openDimStyleManager(this.app, r.str(3, 'Standard')) }, 'Edit style…'))));
        row('Geometry block', r.str(2));
        break;
      }
      case 'SPLINE':
        row('Degree', String(r.num(71, 3)));
        row('Control points', String(r.num(73, 0)));
        row('Fit points', String(r.num(74, 0)));
        row('Closed', r.num(70, 0) & 1 ? 'Yes' : 'No');
        break;
      case 'POINT':
        row('Location', pt(10));
        break;
    }
    return rows;
  }

  /** "Dynamic height" checkbox: labels follow the measured value (DIMDYN settings). */
  private dynamicRow(dims: DxfRecord[], current: DynText | null) {
    const cb = h('input', { type: 'checkbox', checked: dims.every((d) => readDynamic(d)) }) as HTMLInputElement;
    cb.addEventListener('change', () => {
      const app = this.app;
      const d = current ?? (typeof app.dimTextHeight === 'object' ? app.dimTextHeight.dynamic : null) ?? defaultDynamic(app);
      app.editor.setDimDynamic(dims, cb.checked ? d : null);
    });
    return this.row('Dynamic height', h('label.check', cb, ' follows measured value'));
  }

  private editableNum(label: string, v: number, set: (v: number) => unknown) {
    const inp = h('input.inp', { value: fmt(v) }) as HTMLInputElement;
    inp.addEventListener('change', () => {
      const n = Number(inp.value);
      if (Number.isFinite(n)) set(n);
    });
    inp.addEventListener('keydown', (e) => e.stopPropagation());
    return this.row(label, inp);
  }

  private editableText(label: string, v: string, set: (v: string) => unknown) {
    const inp = h('input.inp', { value: v }) as HTMLInputElement;
    inp.addEventListener('change', () => set(inp.value));
    inp.addEventListener('keydown', (e) => e.stopPropagation());
    return this.row(label, inp);
  }
}
