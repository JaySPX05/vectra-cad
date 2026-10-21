import { App } from './ui/app';
import { CommandLine, saveCurrentUcs } from './ui/commands';
import { h } from './ui/dom';
import { ExplorerPanel, LayersPanel, PropertiesPanel } from './ui/panels';
import { setTextMeasurer, setForceRomans, CAP_HEIGHT } from './render/text';
import { DxfFormatError } from './dxf/tokenizer';
import { DWG_VERSIONS, DwgError, dwgVersion, repairLibreDwgDxf } from './dwg/libredwg';
import { dwgToDxf } from './dwg/convert';
import { desktop } from './desktop';
import { PRESET_VIEWS, sameDir } from './geom/view';
import type { VisualStyle } from './render/canvas';
import { Ucs, namedUcsList } from './model/ucs';

// Roman S mode (ROMANS command) is remembered per browser; on by default.
try {
  setForceRomans(localStorage.getItem('vectra.romans') !== '0');
} catch {
  setForceRomans(true);
}

// Real glyph metrics from the browser's fonts, for text layout and MTEXT wrapping.
{
  const ctx = document.createElement('canvas').getContext('2d')!;
  const cache = new Map<string, number>();
  setTextMeasurer({
    width(text, font, bold, italic) {
      const key = `${bold ? 'b' : ''}${italic ? 'i' : ''}|${font}|${text}`;
      let w = cache.get(key);
      if (w === undefined) {
        ctx.font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}100px ${font}`;
        w = ctx.measureText(text).width / 100 / CAP_HEIGHT;
        if (cache.size > 50000) cache.clear();
        cache.set(key, w);
      }
      return w;
    },
  });
}

const SAMPLES: [string, string][] = [
  ['basic_entities.dxf', 'Basic entities (R2018)'],
  ['text_mtext.dxf', 'TEXT & MTEXT'],
  ['blocks_inserts.dxf', 'Blocks, attributes, arrays'],
  ['hatches.dxf', 'Hatches (solid, patterns, gradient)'],
  ['dimensions_leaders.dxf', 'Dimensions & leaders'],
  ['ucs_dims.dxf', 'Plate with a UCS at its corner (dimensions)'],
  ['house_3d.dxf', '3D house (faces, meshes, thickness)'],
  ['meshes_3d.dxf', '3D meshes & faces'],
  ['r12_legacy.dxf', 'R12 legacy file'],
  ['basic_entities_r2000.dxf', 'Basic entities (R2000)'],
  ['stress_20k.dxf', 'Stress test: 20,000 entities'],
  ['public/example_2018.dwg', 'DWG: LibreDWG example (AutoCAD 2018)'],
  ['public/example_2004.dwg', 'DWG: LibreDWG example (AutoCAD 2004)'],
  ['public/example_2018.dxf', 'LibreDWG example (AutoCAD 2018)'],
  ['public/example_2000.dxf', 'LibreDWG example (AutoCAD 2000)'],
  ['public/example_r14.dxf', 'LibreDWG example (R14)'],
];

const canvas = h('canvas.viewport') as HTMLCanvasElement;
const viewportWrap = h('div.viewport-wrap', canvas, h('div.drop-hint', 'Drop a .dxf or .dwg file to open it'));
const app = new App(canvas);
(window as unknown as { __app: App }).__app = app; // handy for debugging from the console
const cmd = new CommandLine(app);
const layers = new LayersPanel(app);
const explorer = new ExplorerPanel(app);
const props = new PropertiesPanel(app);

// ---- toolbar -------------------------------------------------------------------------------------
const fileInput = h('input', { type: 'file', accept: '.dxf,.DXF,.dwg,.DWG', style: 'display:none' }) as HTMLInputElement;
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) openFile(f);
  fileInput.value = '';
});
const sampleSel = h('select.inp.toolbar-select', { title: 'Open a sample drawing' },
  h('option', { value: '' }, 'Samples…'),
  ...SAMPLES.map(([f, label]) => h('option', { value: f }, label))) as HTMLSelectElement;
sampleSel.addEventListener('change', () => {
  if (sampleSel.value) loadSample(sampleSel.value);
  sampleSel.value = '';
});

const toggle = (label: string, title: string, get: () => boolean, set: (v: boolean) => void) => {
  const b = h('button.tbtn.toggle', { title }, label);
  const sync = () => b.classList.toggle('on', get());
  b.addEventListener('click', () => {
    set(!get());
    sync();
    app.redraw();
  });
  sync();
  return { el: b, sync };
};
const snapT = toggle('OSNAP', 'Object snap (F3)', () => app.snapOn, (v) => (app.snapOn = v));
const orthoT = toggle('ORTHO', 'Ortho mode (F8)', () => app.orthoOn, (v) => (app.orthoOn = v));
const lwT = toggle('LWT', 'Show lineweights', () => app.lineweights, (v) => (app.lineweights = v));
// Side panels. Layers + Drawing database is a column that can be hidden (remembered);
// Properties floats over the drawing and opens when something is selected, or stays open when pinned.
const LEFT_KEY = 'vectra.leftPanel';
let leftOpen = true;
try {
  leftOpen = localStorage.getItem(LEFT_KEY) !== '0';
} catch { /* storage blocked: default */ }
let propsPinned = false;
let propsClosed = false; // closed with × until the selection changes
const setLeft = (v: boolean) => {
  leftOpen = v;
  try { localStorage.setItem(LEFT_KEY, v ? '1' : '0'); } catch { /* not remembered */ }
  syncPanels();
};
const setPinned = (v: boolean) => {
  propsPinned = v;
  propsClosed = false;
  syncPanels();
};
const leftT = toggle('Layers', 'Show or hide the Layers and Drawing database panel (Ctrl+2)', () => leftOpen, setLeft);
const propsT = toggle('Properties', 'Keep the Properties panel open (Ctrl+1). Otherwise it opens when something is selected.', () => propsPinned, setPinned);
const themeT = toggle('◐', 'Dark / light background', () => app.dark, (v) => {
  app.dark = v;
  document.documentElement.dataset.theme = v ? 'dark' : 'light';
});

const undoBtn = h('button.tbtn', { title: 'Undo (Ctrl+Z)', onclick: () => cmd.run('UNDO') }, '↶ Undo');
const redoBtn = h('button.tbtn', { title: 'Redo (Ctrl+Y)', onclick: () => cmd.run('REDO') }, '↷ Redo');
const tools: [string, string, string][] = [
  ['LINE', 'Line', 'L'], ['PLINE', 'Polyline', 'PL'], ['CIRCLE', 'Circle', 'C'], ['ARC', 'Arc (3 points)', 'A'],
  ['RECTANG', 'Rectangle', 'REC'], ['TEXT', 'Text', 'DT'], ['MOVE', 'Move', 'M'], ['COPY', 'Copy', 'CO'],
  ['ROTATE', 'Rotate', 'RO'], ['SCALE', 'Scale', 'SC'], ['ERASE', 'Erase', 'E'],
];
// view presets, visual styles and orbit
const viewSel = h('select.inp.toolbar-select', { title: 'View direction (VIEW)' },
  ...PRESET_VIEWS.map((v, i) => h('option', { value: String(i) }, v.name)),
  h('option', { value: 'custom', disabled: true }, 'Custom (orbit)')) as HTMLSelectElement;
viewSel.addEventListener('change', () => {
  const v = PRESET_VIEWS[Number(viewSel.value)];
  if (v) app.setViewDir(v.dir, true);
  viewSel.blur();
});
const styleSel = h('select.inp.toolbar-select', { title: 'Visual style (VSCURRENT)' },
  h('option', { value: 'wireframe' }, '2D Wireframe'),
  h('option', { value: 'hidden' }, 'Hidden'),
  h('option', { value: 'shaded' }, 'Shaded'),
  h('option', { value: 'shadedEdges' }, 'Shaded + edges')) as HTMLSelectElement;
styleSel.addEventListener('change', () => {
  app.visualStyle = styleSel.value as VisualStyle;
  app.redraw();
  styleSel.blur();
});
const ucsSel = h('select.inp.toolbar-select', { title: 'User coordinate system (UCS)' }) as HTMLSelectElement;
const fillUcs = () => {
  const named = namedUcsList(app.doc);
  ucsSel.replaceChildren(
    h('option', { value: 'current', disabled: true }, app.ucs.isWorld ? 'UCS: World' : `UCS: ${app.ucs.name || 'Unnamed'}`),
    h('option', { value: 'world' }, 'World'),
    h('option', { value: 'origin' }, 'Origin…'),
    h('option', { value: '3point' }, '3 Point…'),
    h('option', { value: 'previous' }, 'Previous'),
    h('option', { value: 'view' }, 'Align to view'),
    ...named.map((u) => h('option', { value: 'named:' + u.name }, `Named: ${u.name}`)),
    h('option', { value: 'save' }, 'Save as…'),
  );
  ucsSel.value = 'current';
};
ucsSel.addEventListener('change', () => {
  const v = ucsSel.value;
  ucsSel.blur();
  if (v === 'world') app.setUcs(Ucs.WORLD);
  else if (v === 'previous') app.previousUcs() || app.log('No previous UCS.', 'warn');
  else if (v === 'view') { const r = app.scene.rot; app.setUcs(new Ucs(app.ucs.origin, [r[0], r[1], r[2]], [r[4], r[5], r[6]])); }
  else if (v.startsWith('named:')) { const u = namedUcsList(app.doc).find((x) => x.name === v.slice(6)); if (u) app.setUcs(u); }
  else if (v === 'origin' || v === '3point') cmd.run('UCS'); // origin first; 3-point continues with X axis / plane points
  else if (v === 'save') saveCurrentUcs(app);
  fillUcs();
});
app.onView.push(fillUcs);
app.onDocument.push(fillUcs);

const orbitBtn = h('button.tbtn.toggle', { title: 'Orbit (3DO): drag to rotate the view. Shift+middle-drag also orbits.', onclick: () => cmd.run('3DORBIT') }, 'Orbit');
app.onView.push(() => {
  const i = PRESET_VIEWS.findIndex((v) => sameDir(v.dir, app.viewDirection));
  viewSel.value = i >= 0 ? String(i) : 'custom';
  styleSel.value = app.visualStyle;
  orbitBtn.classList.toggle('on', app.orbitMode);
});

// Measuring and dimensioning, grouped like AutoCAD's Annotate > Dimensions panel
const DIM_MENU: [string, [string, string][]][] = [
  ['Measure', [['DIST', 'Distance (DI)'], ['ID', 'Point coordinates (ID)']]],
  ['Create dimension', [
    ['DIMLINEAR', 'Linear (DLI)'], ['DIMALIGNED', 'Aligned (DAL)'], ['DIMRADIUS', 'Radius (DRA)'],
    ['DIMDIAMETER', 'Diameter (DDI)'], ['DIMANGULAR', 'Angular (DAN)'], ['DIMORDINATE', 'Ordinate (DOR)'],
  ]],
  ['Edit', [['DIMEDIT', 'Label text… (DIMEDIT)']]],
  ['Size & style', [['DIMTXT', 'Label height… (DIMTXT)'], ['DIMDYN', 'Dynamic label height… (DIMDYN)'], ['DIMSCALE', 'Scale… (DIMSCALE)'], ['DIMSTYLE', 'Style… (D)']]],
];
const dimSel = h('select.inp.toolbar-select', { title: 'Measure & dimension' },
  h('option', { value: '' }, 'Measure / Dimension'),
  ...DIM_MENU.map(([label, items]) => h('optgroup', { label }, ...items.map(([v, l]) => h('option', { value: v }, l))))) as HTMLSelectElement;
dimSel.addEventListener('change', () => {
  if (dimSel.value) cmd.run(dimSel.value);
  dimSel.value = '';
  dimSel.blur();
});

const toolbar = h('header.toolbar',
  h('span.brand', 'Vectra', h('b', 'CAD')),
  h('button.tbtn', { title: 'New drawing', onclick: () => app.newDocument() }, 'New'),
  h('button.tbtn', { title: 'Open a DXF or DWG drawing (Ctrl+O)', onclick: () => openDialog() }, 'Open'),
  h('button.tbtn.primary', { title: desktop ? 'Save (Ctrl+S)' : 'Save as DXF (Ctrl+S)', onclick: () => app.save() }, desktop ? 'Save' : 'Save DXF'),
  desktop ? h('button.tbtn', { title: 'Save As (Ctrl+Shift+S)', onclick: () => app.save(true) }, 'Save As…') : null,
  sampleSel,
  h('span.sep'), undoBtn, redoBtn,
  h('span.sep'),
  ...tools.map(([c, label, alias]) => h('button.tbtn.tool', { title: `${label} (${alias})`, onclick: () => cmd.run(c) }, label)),
  dimSel,
  h('span.grow'),
  ucsSel, viewSel, styleSel, orbitBtn,
  h('button.tbtn', { title: 'Zoom extents (double-click wheel)', onclick: () => app.zoomExtents() }, 'Extents'),
  h('span.sep'), leftT.el, propsT.el,
  fileInput,
);

// ---- side panels ---------------------------------------------------------------------------------------
const panel = (title: string, body: HTMLElement, cls = '', action?: HTMLElement) =>
  h('section.panel' + cls, h('h2.panel-title', h('span', title), action ?? null), body);
const left = h('aside.side.left',
  panel('Layers', layers.el, '.layers', h('button.icon.panel-x', { title: 'Hide panel (Ctrl+2)', onclick: () => setLeft(false) }, '«')),
  panel('Drawing database', explorer.el, '.explorer'));
const propsEl = panel('Properties', props.el, '.props.floating',
  h('button.icon.panel-x', { title: 'Close (opens again on the next selection)', onclick: () => { propsPinned = false; propsClosed = true; syncPanels(); } }, '×'));
viewportWrap.append(propsEl);
const workspace = h('main.workspace', left, h('div.center', viewportWrap, cmd.el));

function syncPanels() {
  workspace.classList.toggle('left-hidden', !leftOpen);
  propsEl.hidden = !(propsPinned || ((app.selection.size > 0 || !!app.inspected) && !propsClosed));
  leftT.sync();
  propsT.sync();
}
// a new selection reopens Properties after ×; edits that keep the same selection don't
let lastSel: unknown[] = [];
const selectionChanged = () => {
  const now = [app.inspected, ...app.selection];
  if (now.length !== lastSel.length || now.some((r, i) => r !== lastSel[i])) propsClosed = false;
  lastSel = now;
  syncPanels();
};
app.onSelection.push(selectionChanged);
app.onInspect.push(selectionChanged);
app.showPanel = (which) => (which === 'layers' ? setLeft(true) : setPinned(true));
syncPanels();

// ---- status bar -------------------------------------------------------------------------------------------
const coords = h('span.coords', '0, 0');
const statusInfo = h('span.status-info');
const status = h('footer.status', coords, snapT.el, orthoT.el, lwT.el, themeT.el, h('span.grow'), statusInfo);
app.onPrompt.push(() => {
  const [x, y, z] = app.cursorUcs();
  const d = Math.max(0, Math.min(6, Math.ceil(-Math.log10(1 / app.view.s)) + 1));
  coords.textContent = app.cursorOk || app.snap ? `${x.toFixed(d)}, ${y.toFixed(d)}, ${z.toFixed(d)}` : 'edge-on view: snap or type coordinates';
});
const updateStatus = () => {
  if (!app.doc) return;
  statusInfo.textContent = `${app.fileName}${app.dirtyFile ? ' •' : ''} · ${app.doc.version} · ${app.unitsLabel} · ${app.scene.items.length} entities · layer ${app.currentLayer} · UCS ${app.ucs.isWorld ? 'World' : app.ucs.name || 'Unnamed'}`;
  undoBtn.toggleAttribute('disabled', !app.editor.history.canUndo);
  redoBtn.toggleAttribute('disabled', !app.editor.history.canRedo);
  document.title = `${app.filePath ?? app.fileName}${app.dirtyFile ? ' •' : ''} — Vectra CAD`;
  desktop?.setDocState(app.dirtyFile, document.title);
};
app.onDocument.push(updateStatus);
app.onSelection.push(updateStatus);

document.getElementById('app')!.append(toolbar, workspace, status);

// ---- file loading -----------------------------------------------------------------------------------------
async function openFile(f: File) {
  try {
    await openBytes(new Uint8Array(await f.arrayBuffer()), f.name);
  } catch (e) {
    report(e, f.name);
  }
}

/**
 * Open DXF directly; DWG is first converted to DXF by LibreDWG (WebAssembly, in a worker),
 * then read by the same lossless DXF pipeline. Saving writes DXF.
 */
async function openBytes(bytes: Uint8Array, name: string, path: string | null = null) {
  const ver = dwgVersion(bytes);
  if (!ver) {
    app.load(bytes, name);
    app.filePath = path;
    app.emit(app.onDocument);
    return;
  }
  app.log(`Reading DWG (${DWG_VERSIONS[ver] ?? ver}) with LibreDWG…`);
  document.body.classList.add('busy');
  try {
    const t0 = performance.now();
    const dxf = await dwgToDxf(bytes);
    app.log(`Converted ${name} to DXF in ${(performance.now() - t0).toFixed(0)} ms.`);
    let fixes = { emptyTables: 0 };
    app.load(dxf, name, (doc) => (fixes = repairLibreDwgDxf(doc)));
    app.filePath = path; // a DWG path: Save asks for a .dxf name next to it
    if (fixes.emptyTables) app.log(`LibreDWG could not convert ${fixes.emptyTables} table(s) in this drawing; they are left out.`, 'warn');
    app.log(`Save writes ${name.replace(/\.dwg$/i, '.dxf')} (DXF, ${DWG_VERSIONS[ver] ?? ver}); DWG can't be written back.`, 'dim');
  } finally {
    document.body.classList.remove('busy');
  }
}
async function loadSample(path: string) {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}samples/${path}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await openBytes(new Uint8Array(await res.arrayBuffer()), path.split('/').pop()!);
  } catch (e) {
    report(e, path);
  }
}
function report(e: unknown, name: string) {
  if (!(e instanceof DxfFormatError || e instanceof DwgError)) console.error(e); // expected failures are just reported
  const msg = e instanceof DxfFormatError || e instanceof DwgError ? e.message : `Could not open ${name}: ${(e as Error).message}`;
  app.log(msg, 'warn');
}

viewportWrap.addEventListener('dragover', (e) => {
  e.preventDefault();
  viewportWrap.classList.add('dragging');
});
viewportWrap.addEventListener('dragleave', () => viewportWrap.classList.remove('dragging'));
viewportWrap.addEventListener('drop', (e) => {
  e.preventDefault();
  viewportWrap.classList.remove('dragging');
  const f = e.dataTransfer?.files[0];
  if (!f) return;
  // desktop: keep the real path so Save can write back to it
  const p = desktop?.pathForFile(f) || null;
  if (p) f.arrayBuffer().then((b) => openBytes(new Uint8Array(b), f.name, p)).catch((err) => report(err, f.name));
  else openFile(f);
});

// ---- keyboard -----------------------------------------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  const inField = t !== cmd.input && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
  if (inField) return;
  // an open dialog (Dimension Style Manager…) keeps the keyboard
  if (document.querySelector('.modal-back')) return;
  const k = e.key;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && k.toLowerCase() === 'z') { e.preventDefault(); cmd.run('UNDO'); return; }
  if (mod && (k.toLowerCase() === 'y' || (e.shiftKey && k.toLowerCase() === 'z'))) { e.preventDefault(); cmd.run('REDO'); return; }
  if (mod && k.toLowerCase() === 's') { e.preventDefault(); app.save(e.shiftKey); return; }
  if (mod && k.toLowerCase() === 'o') { e.preventDefault(); openDialog(); return; }
  if (mod && k.toLowerCase() === 'a') { e.preventDefault(); cmd.run('SELECTALL'); return; }
  if (mod && k === '1') { e.preventDefault(); propsT.el.click(); return; }
  if (mod && k === '2') { e.preventDefault(); leftT.el.click(); return; }
  if (k === 'F3') { e.preventDefault(); app.snapOn = !app.snapOn; snapT.sync(); app.log(`<Osnap ${app.snapOn ? 'on' : 'off'}>`); return; }
  if (k === 'F8') { e.preventDefault(); app.orthoOn = !app.orthoOn; orthoT.sync(); app.log(`<Ortho ${app.orthoOn ? 'on' : 'off'}>`); return; }
  if (t === cmd.input) return; // the command line handles its own keys
  if (k === 'Escape') { app.escape(); return; }
  if ((k === 'Delete' || k === 'Backspace') && app.selection.size && !app.prompt) { e.preventDefault(); cmd.run('ERASE'); return; }
  if (k === 'Enter' || (k === ' ' && !mod)) { e.preventDefault(); cmd.submit(); return; }
  if (k.length === 1 && !mod && !e.altKey) {
    // AutoCAD-style: typing anywhere goes to the command line
    e.preventDefault();
    cmd.input.focus();
    cmd.input.value += k;
  }
});

app.onDocument.push(() => {
  // keep toolbar toggles honest after loads
  snapT.sync(); orthoT.sync(); lwT.sync();
});

/** Open: the native dialog in the desktop app, the browser file picker otherwise. */
async function openDialog() {
  if (!desktop) return fileInput.click();
  try {
    const f = await desktop.openFile();
    if (f) await openBytes(f.data, f.name, f.path);
  } catch (e) {
    report(e, 'file');
  }
}

if (desktop) {
  desktop.onFileOpened((f) => openBytes(f.data, f.name, f.path).catch((e) => report(e, f.name)));
  desktop.onMenu(async (name) => {
    switch (name) {
      case 'open': return openDialog();
      case 'save': return void app.save();
      case 'saveAs': return void app.save(true);
      case 'saveThenClose': if (await app.save()) desktop!.closeConfirmed(); return;
      case 'undo': return cmd.run('UNDO');
      case 'redo': return cmd.run('REDO');
      case 'selectAll': return cmd.run('SELECTALL');
      case 'zoomExtents': return app.zoomExtents();
      case 'toggleTheme': return themeT.el.click();
      case 'toggleProperties': return propsT.el.click();
      case 'toggleLayers': return leftT.el.click();
      case 'help': return cmd.run('HELP');
    }
  });
}

app.newDocument();
app.log('Welcome. Open a DXF (Open, drag & drop, or Samples), or start drawing. Type HELP for commands.');
if (desktop) {
  desktop.initialFile().then((f) => f && openBytes(f.data, f.name, f.path)).catch((e) => report(e, 'file'));
} else {
  loadSample('basic_entities.dxf');
}
