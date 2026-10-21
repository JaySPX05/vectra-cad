import { openDimStyleManager } from './dimstyle-dialog';
import type { DxfRecord } from '../dxf/record';
import { App, CancelError, type P2 } from './app';
import { h } from './dom';
import { newArc, newCircle, newLine, newPolyline, newText, ensureLayer } from '../edit/create';
import { type Similarity, similarityInUcs, transformEntity, canTransform } from '../edit/transform';
import { Ucs, deleteNamedUcs, namedUcsList, saveNamedUcs, setHeaderGroups } from '../model/ucs';
import { apply, cross, norm, ocsToWcs } from '../geom/ocs';
import { type DimSpec, previewDimension } from '../dims/create';
import { DIMVAR, dimStyle, dimStyleFor } from '../dims/style';
import { type DynText, readDynamic } from '../dims/dynamic';
import { romansForced, setForceRomans } from '../render/text';
import type { Vec3 } from '../dxf/record';
import { group } from '../dxf/groups';
import type { Prim3 } from '../render/prims';
import { arcPoints, circlePoints } from '../geom/tessellate';
import type { Style } from '../render/style';
import { fitView, type VisualStyle } from '../render/canvas';
import { PRESET_VIEWS, TOP, project } from '../geom/view';

const DEG = Math.PI / 180;

type CommandFn = (app: App, cl: CommandLine) => Promise<void>;

interface CommandDef {
  name: string;
  aliases: string[];
  help: string;
  run: CommandFn;
}

const fmt = (v: number) => (Math.abs(v) >= 1e6 || (Math.abs(v) < 1e-4 && v !== 0) ? v.toExponential(4) : +v.toFixed(4) + '');

// ---- preview helpers -----------------------------------------------------------------------
const previewStyle: Style = { color: 'fg', linetype: null, ltScale: 1, lineweight: 0 };
/** Preview polyline from UCS points. */
const pline = (ucs: Ucs, pts: P2[], closed = false): Prim3 => ({ k: 'line', pts: pts.flatMap((p) => ucs.toWcs(p)), closed, style: previewStyle });
const circlePrim = (ucs: Ucs, c: P2, r: number): Prim3 => pline(ucs, circlePoints([c[0], c[1], 0], r).map((p) => [p[0], p[1]] as P2), true);

/** Preview of selected entities transformed by `t` (capped for responsiveness). */
function transformedPreview(app: App, recs: DxfRecord[], t: Similarity): Prim3[] {
  const copies: DxfRecord[] = [];
  for (const r of recs.slice(0, 300)) {
    if (!canTransform(r)) continue;
    const c = r.clone();
    try {
      transformEntity(c, t, app.doc);
      copies.push(c);
    } catch {
      /* skip */
    }
  }
  return app.scene.previewPrims3(copies);
}

/** Circle through three points (null if collinear). */
function circle3(a: P2, b: P2, c: P2): { c: P2; r: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, c2 = c[0] ** 2 + c[1] ** 2;
  const ux = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
  const uy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  return { c: [ux, uy], r: Math.hypot(a[0] - ux, a[1] - uy) };
}

function arc3(a: P2, b: P2, c: P2): { c: P2; r: number; s: number; e: number } | null {
  const k = circle3(a, b, c);
  if (!k) return null;
  const ang = (p: P2) => Math.atan2(p[1] - k.c[1], p[0] - k.c[0]);
  const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  // counter-clockwise from a to c when the middle point is on the left
  return cross > 0 ? { ...k, s: ang(a), e: ang(c) } : { ...k, s: ang(c), e: ang(a) };
}

const isPoint = (v: unknown): v is P2 => Array.isArray(v);

async function needPoint(app: App, msg: string, opts: Parameters<App['getPoint']>[1] = {}): Promise<P2> {
  for (;;) {
    const v = await app.getPoint(msg, opts);
    if (isPoint(v)) return v;
    if (v === null) throw new CancelError('');
  }
}

function props(app: App) {
  return { layer: app.currentLayer };
}

// ---- commands -----------------------------------------------------------------------------------
const COMMANDS: CommandDef[] = [
  {
    name: 'LINE', aliases: ['L'], help: 'Draw line segments',
    async run(app) {
      const first = await needPoint(app, 'Specify first point');
      let last = first;
      const made: DxfRecord[] = [];
      for (;;) {
        const msg = made.length >= 2 ? 'Specify next point or [Close/Undo]' : made.length ? 'Specify next point or [Undo]' : 'Specify next point';
        const v = await app.getPoint(msg, {
          base: last, allowEmpty: true, keywords: ['Undo', 'Close'],
          preview: (p) => [pline(app.ucs, [last, p])],
        });
        if (v === null) return;
        if (v === 'Undo') {
          if (made.length) {
            app.editor.undo();
            made.pop();
            last = made.length ? (made[made.length - 1].point(11).slice(0, 2) as P2) : first;
          }
          continue;
        }
        if (v === 'Close') {
          if (made.length >= 2) app.editor.add([newLine(app.doc, last, first, props(app), app.ucs)], 'Line');
          return;
        }
        if (!isPoint(v)) continue;
        const rec = newLine(app.doc, last, v, props(app), app.ucs);
        app.editor.add([rec], 'Line');
        made.push(rec);
        last = v;
      }
    },
  },
  {
    name: 'PLINE', aliases: ['PL'], help: 'Draw a polyline (LWPOLYLINE)',
    async run(app) {
      const pts: P2[] = [await needPoint(app, 'Specify start point')];
      for (;;) {
        const v = await app.getPoint('Specify next point or [Close/Undo]', {
          base: pts[pts.length - 1], allowEmpty: true, keywords: ['Close', 'Undo'],
          preview: (p) => [pline(app.ucs, [...pts, p])],
        });
        if (v === 'Undo') {
          if (pts.length > 1) pts.pop();
          continue;
        }
        if (v === null || v === 'Close') {
          if (pts.length >= 2) app.editor.add([newPolyline(app.doc, pts, v === 'Close', props(app), app.ucs)], 'Polyline');
          return;
        }
        if (isPoint(v)) pts.push(v);
      }
    },
  },
  {
    name: 'RECTANG', aliases: ['REC', 'RECTANGLE'], help: 'Draw a rectangle',
    async run(app) {
      const a = await needPoint(app, 'Specify first corner point');
      const rect = (b: P2): P2[] => [a, [b[0], a[1]], b, [a[0], b[1]]];
      const b = await needPoint(app, 'Specify other corner point', { preview: (p) => [pline(app.ucs, rect(p), true)] });
      app.editor.add([newPolyline(app.doc, rect(b), true, props(app), app.ucs)], 'Rectangle');
    },
  },
  {
    name: 'CIRCLE', aliases: ['C'], help: 'Draw a circle (center, radius)',
    async run(app) {
      const c = await needPoint(app, 'Specify center point for circle');
      // a typed number is the radius itself (not a direct-distance point)
      const v = await app.getPoint('Specify radius of circle or [Diameter]', {
        base: c, keywords: ['Diameter'], rawNumber: true, preview: (p) => [circlePrim(app.ucs, c, Math.hypot(p[0] - c[0], p[1] - c[1]))],
      });
      let r: number;
      if (v === 'Diameter') {
        const d = await app.getPoint('Specify diameter of circle', { base: c, rawNumber: true, preview: (p) => [circlePrim(app.ucs, c, Math.hypot(p[0] - c[0], p[1] - c[1]) / 2)] });
        if (isPoint(d)) r = Math.hypot(d[0] - c[0], d[1] - c[1]) / 2;
        else if (typeof d === 'string' && Number(d) > 0) r = Number(d) / 2;
        else return;
      } else if (isPoint(v)) r = Math.hypot(v[0] - c[0], v[1] - c[1]);
      else if (typeof v === 'string' && Number(v) > 0) r = Number(v);
      else return;
      if (r > 0) app.editor.add([newCircle(app.doc, c, r, props(app), app.ucs)], 'Circle');
    },
  },
  {
    name: 'ARC', aliases: ['A'], help: 'Draw an arc through three points',
    async run(app) {
      const a = await needPoint(app, 'Specify start point of arc');
      const b = await needPoint(app, 'Specify second point of arc', { base: a, preview: (p) => [pline(app.ucs, [a, p])] });
      const prev = (p: P2): Prim3[] => {
        const k = arc3(a, b, p);
        return k ? [pline(app.ucs, arcPoints([k.c[0], k.c[1], 0], k.r, k.s, k.e).map((q) => [q[0], q[1]] as P2))] : [pline(app.ucs, [a, b, p])];
      };
      const c = await needPoint(app, 'Specify end point of arc', { base: b, preview: prev });
      const k = arc3(a, b, c);
      if (!k) return app.log('Points are collinear.', 'warn');
      app.editor.add([newArc(app.doc, k.c, k.r, ((k.s / DEG) + 360) % 360, ((k.e / DEG) + 360) % 360, props(app), app.ucs)], 'Arc');
    },
  },
  {
    name: 'TEXT', aliases: ['DT', 'DTEXT'], help: 'Single-line text',
    async run(app, cl) {
      const p = await needPoint(app, 'Specify start point of text');
      const hs = await app.getText(`Specify height <${cl.lastTextHeight}>`, String(cl.lastTextHeight));
      const height = Number(hs) > 0 ? Number(hs) : cl.lastTextHeight;
      cl.lastTextHeight = height;
      const rs = await app.getText('Specify rotation angle of text <0>', '0');
      const text = await app.getText('Enter text');
      if (!text) return;
      app.editor.add([newText(app.doc, p, height, text, Number(rs) || 0, props(app), app.ucs)], 'Text');
    },
  },
  {
    name: 'MOVE', aliases: ['M'], help: 'Move objects',
    async run(app) {
      const sel = await app.getSelection();
      if (!sel.length) return;
      const base = await needPoint(app, 'Specify base point');
      const to = await needPoint(app, 'Specify second point', {
        base, preview: (p) => transformedPreview(app, sel, similarityInUcs(app.ucs, { dx: p[0] - base[0], dy: p[1] - base[1] })),
      });
      report(app, app.editor.move(sel, to[0] - base[0], to[1] - base[1], app.ucs).skipped);
      app.clearSelection();
    },
  },
  {
    name: 'COPY', aliases: ['CO', 'CP'], help: 'Copy objects (repeats until Enter)',
    async run(app) {
      const sel = await app.getSelection();
      if (!sel.length) return;
      const base = await needPoint(app, 'Specify base point');
      for (;;) {
        const v = await app.getPoint('Specify second point or <exit>', {
          base, allowEmpty: true,
          preview: (p) => transformedPreview(app, sel, similarityInUcs(app.ucs, { dx: p[0] - base[0], dy: p[1] - base[1] })),
        });
        if (!isPoint(v)) break;
        app.editor.copy(sel, v[0] - base[0], v[1] - base[1], app.ucs);
      }
      app.clearSelection();
    },
  },
  {
    name: 'ROTATE', aliases: ['RO'], help: 'Rotate objects about a base point',
    async run(app) {
      const sel = await app.getSelection();
      if (!sel.length) return;
      const base = await needPoint(app, 'Specify base point');
      const angOf = (p: P2) => Math.atan2(p[1] - base[1], p[0] - base[0]);
      const v = await app.getPoint('Specify rotation angle (degrees) or pick a point', {
        base, rawNumber: true, preview: (p) => transformedPreview(app, sel, similarityInUcs(app.ucs, { base, angle: angOf(p) })),
      });
      const angle = isPoint(v) ? angOf(v) : typeof v === 'string' && Number.isFinite(Number(v)) ? Number(v) * DEG : null;
      if (angle === null) return;
      report(app, app.editor.rotate(sel, base, angle, app.ucs).skipped);
      app.clearSelection();
    },
  },
  {
    name: 'SCALE', aliases: ['SC'], help: 'Scale objects about a base point',
    async run(app) {
      const sel = await app.getSelection();
      if (!sel.length) return;
      const base = await needPoint(app, 'Specify base point');
      const f = (p: P2) => Math.hypot(p[0] - base[0], p[1] - base[1]);
      const v = await app.getPoint('Specify scale factor', {
        base, rawNumber: true, preview: (p) => (f(p) > 0 ? transformedPreview(app, sel, similarityInUcs(app.ucs, { base, scale: f(p) })) : []),
      });
      const k = isPoint(v) ? f(v) : Number(v);
      if (!(k > 0)) return app.log('Scale factor must be positive.', 'warn');
      report(app, app.editor.scale(sel, base, k, app.ucs).skipped);
      app.clearSelection();
    },
  },
  {
    name: 'ERASE', aliases: ['E', 'DEL'], help: 'Erase objects',
    async run(app) {
      const sel = await app.getSelection();
      if (!sel.length) return;
      app.editor.erase(sel);
      app.log(`${sel.length} erased.`);
      app.clearSelection();
    },
  },
  {
    name: 'UNDO', aliases: ['U'], help: 'Undo the last operation',
    async run(app) {
      const tx = app.editor.undo();
      app.log(tx ? `Undo ${tx.label}` : 'Nothing to undo.');
    },
  },
  {
    name: 'REDO', aliases: [], help: 'Redo',
    async run(app) {
      const tx = app.editor.redo();
      app.log(tx ? `Redo ${tx.label}` : 'Nothing to redo.');
    },
  },
  {
    name: 'ZOOM', aliases: ['Z', 'ZE'], help: 'Zoom: Extents or Window',
    async run(app, cl) {
      if (cl.lastAlias === 'ZE') return app.zoomExtents();
      const v = await app.getPoint('Specify corner of window or [Extents]', { keywords: ['Extents'], allowEmpty: true });
      if (v === 'Extents' || v === null) return app.zoomExtents();
      if (!isPoint(v)) return;
      const b = await needPoint(app, 'Specify opposite corner', { preview: (p) => [pline(app.ucs, [v, [p[0], v[1]], p, [v[0], p[1]]], true)] });
      const cams = [v, b].map((p) => project(app.scene.rot, app.ucs.toWcs(p)));
      const box: [number, number, number, number] = [Math.min(cams[0][0], cams[1][0]), Math.min(cams[0][1], cams[1][1]), Math.max(cams[0][0], cams[1][0]), Math.max(cams[0][1], cams[1][1])];
      app.view = fitView(app.view, box);
      app.autoFit = false;
      app.redraw();
    },
  },
  {
    name: 'DIST', aliases: ['DI'], help: 'Measure distance between two points',
    async run(app) {
      const a = await needPoint(app, 'Specify first point');
      const b = await needPoint(app, 'Specify second point', { base: a, preview: (p) => [pline(app.ucs, [a, p])] });
      const dx = b[0] - a[0], dy = b[1] - a[1];
      app.log(`Distance = ${fmt(Math.hypot(dx, dy))} ${app.unitsLabel}, Angle in XY plane = ${fmt((Math.atan2(dy, dx) / DEG + 360) % 360)}°, Delta X = ${fmt(dx)}, Delta Y = ${fmt(dy)}`);
    },
  },
  {
    name: 'ID', aliases: [], help: 'Show coordinates of a point',
    async run(app) {
      const p = await needPoint(app, 'Specify point');
      app.log(`X = ${fmt(p[0])}  Y = ${fmt(p[1])}`);
    },
  },
  {
    name: 'LIST', aliases: ['LI'], help: 'List selected objects',
    async run(app) {
      const sel = await app.getSelection();
      for (const r of sel.slice(0, 50)) {
        app.log(`${r.type}  handle ${r.handle ?? '-'}  layer "${r.layer}"  ${r.groups.length} groups`);
      }
      if (sel.length > 50) app.log(`… ${sel.length - 50} more`);
    },
  },
  {
    name: 'PROPERTIES', aliases: ['PR', 'PROPS', 'CH'], help: 'Show the Properties panel (Ctrl+1)',
    async run(app) {
      app.showPanel('properties');
    },
  },
  {
    name: 'LAYER', aliases: ['LA', 'CLAYER'], help: 'Set the current layer (created if missing); shows the Layers panel',
    async run(app) {
      app.showPanel('layers');
      const name = await app.getText(`Enter layer name to make current <${app.currentLayer}>`, app.currentLayer);
      if (!name) return;
      if (!app.doc.layer(name)) {
        app.editor.history.run('New layer', (tx) => {
          ensureLayer(app.doc, name, tx);
        });
        app.scene.rebuildAll();
        app.emit(app.onDocument);
        app.log(`Layer "${name}" created.`);
      }
      app.currentLayer = app.doc.layer(name)?.str(2) ?? name;
      app.emit(app.onDocument);
    },
  },
  {
    name: 'REGEN', aliases: ['RE'], help: 'Regenerate the drawing',
    async run(app) {
      const t0 = performance.now();
      app.scene.rebuildAll();
      app.redraw();
      app.log(`Regenerated ${app.scene.items.length} entities in ${(performance.now() - t0).toFixed(0)} ms.`);
    },
  },
  {
    name: 'SELECTALL', aliases: ['AI_SELALL'], help: 'Select all visible entities',
    async run(app) {
      app.select(app.scene.items.filter((g) => g.prims.length).map((g) => g.rec), 'replace');
    },
  },
  {
    name: 'PLAN', aliases: [], help: 'Return to the top (plan) view and zoom to extents',
    async run(app) {
      app.setViewDir(TOP, true);
    },
  },
  {
    name: 'VIEW', aliases: ['-VIEW', 'V'], help: 'Preset views: Top, Bottom, Front, Back, Left, Right, SWiso, SEiso, NEiso, NWiso',
    async run(app) {
      const keys = ['Top', 'Bottom', 'Front', 'BAck', 'Left', 'Right', 'SWiso', 'SEiso', 'NEiso', 'NWiso'];
      const v = await app.getText(`Enter a view [${keys.join('/')}]`);
      if (!v) return;
      const u = v.trim().toUpperCase();
      const hit = PRESET_VIEWS.find((pv) => {
        const short = pv.name.replace(' Isometric', 'iso').toUpperCase();
        return short === u || pv.name.toUpperCase() === u || (u.length >= 2 && short.startsWith(u)) || (u.length === 1 && short[0] === u && u !== 'B');
      });
      if (!hit) return app.log(`Unknown view "${v}".`, 'warn');
      app.setViewDir(hit.dir, true);
      app.log(`View: ${hit.name}`);
    },
  },
  {
    name: '3DORBIT', aliases: ['3DO', 'ORBIT'], help: 'Toggle orbit mode (left-drag rotates the view; Shift+middle-drag always orbits)',
    async run(app) {
      app.orbitMode = !app.orbitMode;
      app.emit(app.onView);
      app.log(`Orbit mode ${app.orbitMode ? 'on — drag to rotate, Esc or 3DO to exit' : 'off'}.`);
    },
  },
  {
    name: 'VSCURRENT', aliases: ['VS', 'SHADEMODE'], help: 'Visual style: 2dWireframe, Hidden, Shaded, shaded with Edges',
    async run(app) {
      const v = await app.getText('Enter an option [2dwireframe/Hidden/Shaded/shaded with Edges]', 'Shaded');
      const u = (v ?? '').trim().toUpperCase();
      const map: Record<string, VisualStyle> = { '2': 'wireframe', W: 'wireframe', H: 'hidden', S: 'shaded', E: 'shadedEdges' };
      const style = map[u[0]] ?? (u.startsWith('SHADED WITH') || u.startsWith('SHADEDE') ? 'shadedEdges' : null);
      if (!style) return app.log(`Unknown visual style "${v}".`, 'warn');
      app.visualStyle = style;
      app.emit(app.onView);
      app.redraw();
    },
  },
  {
    name: 'DIMLINEAR', aliases: ['DLI', 'DIMLIN'], help: 'Linear dimension: horizontal/vertical (by cursor position) or rotated',
    async run(app) {
      const pts = await extensionOrigins(app);
      if (!pts) return;
      const [p1, p2] = pts;
      let mode: 'auto' | 'H' | 'V' | 'R' = 'auto';
      let rot = 0;
      let text: string | undefined;
      // AutoCAD: horizontal when the cursor is above/below the points, vertical when beside them
      const dirFor = (loc: P2): Vec3 => {
        let m = mode;
        if (m === 'auto') {
          const inX = loc[0] > Math.min(p1[0], p2[0]) && loc[0] < Math.max(p1[0], p2[0]);
          const inY = loc[1] > Math.min(p1[1], p2[1]) && loc[1] < Math.max(p1[1], p2[1]);
          const mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2;
          m = inX && !inY ? 'H' : inY && !inX ? 'V' : Math.abs(loc[1] - my) >= Math.abs(loc[0] - mx) ? 'H' : 'V';
        }
        const a = m === 'H' ? 0 : m === 'V' ? Math.PI / 2 : rot;
        return app.ucs.dirToWcs([Math.cos(a), Math.sin(a), 0]);
      };
      const spec = (loc: P2): DimSpec => ({ kind: 'rotated', p1: W(app, p1), p2: W(app, p2), loc: W(app, loc), dir: dirFor(loc), text });
      for (;;) {
        const v = await app.getPoint('Specify dimension line location or [Text/Horizontal/Vertical/Rotated]', {
          keywords: ['Text', 'Horizontal', 'Vertical', 'Rotated'], preview: (p) => dimPreview(app, spec(p)),
        });
        if (v === 'Text') text = (await app.getText('Enter dimension text (<> = measured value)', '<>')) ?? undefined;
        else if (v === 'Horizontal') mode = 'H';
        else if (v === 'Vertical') mode = 'V';
        else if (v === 'Rotated') {
          const a = Number(await app.getText('Specify angle of dimension line <0>', '0'));
          rot = (Number.isFinite(a) ? a : 0) * DEG;
          mode = 'R';
        } else if (isPoint(v)) return addDim(app, spec(v));
        else return;
      }
    },
  },
  {
    name: 'DIMALIGNED', aliases: ['DAL'], help: 'Aligned dimension: parallel to the two points',
    async run(app) {
      const pts = await extensionOrigins(app);
      if (!pts) return;
      const [p1, p2] = pts;
      let text: string | undefined;
      const spec = (loc: P2): DimSpec => ({ kind: 'aligned', p1: W(app, p1), p2: W(app, p2), loc: W(app, loc), text });
      for (;;) {
        const v = await app.getPoint('Specify dimension line location or [Text]', { keywords: ['Text'], preview: (p) => dimPreview(app, spec(p)) });
        if (v === 'Text') text = (await app.getText('Enter dimension text (<> = measured value)', '<>')) ?? undefined;
        else if (isPoint(v)) return addDim(app, spec(v));
        else return;
      }
    },
  },
  {
    name: 'DIMRADIUS', aliases: ['DRA'], help: 'Radius dimension of an arc or circle',
    async run(app) {
      await radialDim(app, 'radius');
    },
  },
  {
    name: 'DIMDIAMETER', aliases: ['DDI'], help: 'Diameter dimension of an arc or circle',
    async run(app) {
      await radialDim(app, 'diameter');
    },
  },
  {
    name: 'DIMANGULAR', aliases: ['DAN'], help: 'Angular dimension: select an arc, circle, two lines, or Enter to pick vertex + two points',
    async run(app) {
      const isLine = (r: DxfRecord) => r.type === 'LINE';
      const sel = await app.getEntity('Select arc, circle, line, or <specify vertex>', (r) => r.type === 'ARC' || r.type === 'CIRCLE' || isLine(r), true);
      let make: (loc: P2) => DimSpec;
      if (!sel) {
        const v = await needPoint(app, 'Specify angle vertex');
        const a = await needPoint(app, 'Specify first angle endpoint', { base: v, preview: (p) => [pline(app.ucs, [v, p])] });
        const b = await needPoint(app, 'Specify second angle endpoint', { base: v, preview: (p) => [pline(app.ucs, [a, v, p])] });
        make = (loc) => ({ kind: 'angular3', vertex: W(app, v), p1: W(app, a), p2: W(app, b), loc: W(app, loc) });
      } else if (sel.rec.type === 'ARC') {
        const { center, radius, normal } = curveOf(sel.rec);
        // the arc's centre (10) and angles are in its OCS
        const c = sel.rec.point(10);
        const end = (deg: number): Vec3 => apply(ocsToWcs(normal), [...polar(c, radius, deg), c[2]]);
        const p1 = end(sel.rec.num(50, 0)), p2 = end(sel.rec.num(51, 0));
        make = (loc) => ({ kind: 'angular3', vertex: center, p1, p2, loc: W(app, loc) });
      } else if (sel.rec.type === 'CIRCLE') {
        const { center } = curveOf(sel.rec);
        const p1 = W(app, sel.p);
        const c2 = app.ucs.fromWcs(center);
        const b = await needPoint(app, 'Specify second angle endpoint', { base: [c2[0], c2[1]], preview: (p) => [pline(app.ucs, [sel.p, [c2[0], c2[1]], p])] });
        make = (loc) => ({ kind: 'angular3', vertex: center, p1, p2: W(app, b), loc: W(app, loc) });
      } else {
        const sel2 = await app.getEntity('Select second line', isLine);
        if (!sel2) return;
        const l1 = sel.rec, l2 = sel2.rec;
        make = (loc) => ({ kind: 'angular2', l1a: l1.point(10), l1b: l1.point(11), l2a: l2.point(10), l2b: l2.point(11), loc: W(app, loc) });
      }
      let text: string | undefined;
      for (;;) {
        const v = await app.getPoint('Specify dimension arc line location or [Text]', { keywords: ['Text'], preview: (p) => dimPreview(app, { ...make(p), text }) });
        if (v === 'Text') text = (await app.getText('Enter dimension text (<> = measured value)', '<>')) ?? undefined;
        else if (isPoint(v)) return addDim(app, { ...make(v), text });
        else return;
      }
    },
  },
  {
    name: 'DIMORDINATE', aliases: ['DOR'], help: 'Ordinate dimension: X or Y distance of a feature from the UCS origin',
    async run(app) {
      const f = await needPoint(app, 'Specify feature location');
      let forced: boolean | null = null;
      let text: string | undefined;
      // leader mostly vertical -> X datum (AutoCAD's automatic choice), unless forced
      const xDatum = (p: P2) => forced ?? Math.abs(p[1] - f[1]) >= Math.abs(p[0] - f[0]);
      const spec = (p: P2): DimSpec => ({ kind: 'ordinate', feature: W(app, f), leaderEnd: W(app, p), xDatum: xDatum(p), text });
      for (;;) {
        const v = await app.getPoint('Specify leader endpoint or [Xdatum/Ydatum/Text]', {
          base: f, keywords: ['Xdatum', 'Ydatum', 'Text'], preview: (p) => dimPreview(app, spec(p)),
        });
        if (v === 'Xdatum') forced = true;
        else if (v === 'Ydatum') forced = false;
        else if (v === 'Text') text = (await app.getText('Enter dimension text (<> = measured value)', '<>')) ?? undefined;
        else if (isPoint(v)) return addDim(app, spec(v));
        else return;
      }
    },
  },
  {
    name: 'ROMANS', aliases: [], help: 'Roman S fonts: ON draws all text in Roman Simplex and sets every text style to romans.shx; OFF shows the original fonts',
    async run(app) {
      const cur = romansForced() ? 'ON' : 'OFF';
      const v = ((await app.getText(`Use Roman S for all fonts [ON/OFF] <${cur}>`, cur)) ?? '').trim().toUpperCase();
      if (v !== 'ON' && v !== 'OFF') return app.log('Enter ON or OFF.', 'warn');
      setForceRomans(v === 'ON');
      try {
        localStorage.setItem('vectra.romans', v === 'ON' ? '1' : '0');
      } catch {
        /* storage unavailable: the setting lasts for this session */
      }
      if (v === 'ON') app.applyRomans();
      app.scene.rebuildAll();
      app.redraw();
      app.log(v === 'ON' ? 'All text uses Roman S.' : 'Text shows each style\'s own font (styles already changed stay changed until you Undo).');
    },
  },
  {
    name: 'DIMSCALE', aliases: ['DIMSC'], help: 'Size of dimension text/arrows: a factor or Auto; also applies to selected dimensions',
    async run(app) {
      const cur = app.dimScale === 'auto' ? 'Auto' : String(app.dimScale);
      const v = ((await app.getText(`Enter new value for DIMSCALE or [Auto] <${cur}>`, cur)) ?? '').trim();
      let next: number | 'auto';
      if (/^a/i.test(v)) next = 'auto';
      else if (Number(v) > 0) next = Number(v);
      else return app.log('DIMSCALE must be a positive number or Auto.', 'warn');
      app.dimScale = next;
      const dims = [...app.selection].filter((r) => r.type === 'DIMENSION');
      if (dims.length) {
        // selected dimensions: an explicit factor, or for Auto the factor new dimensions would get
        const value = next === 'auto' ? dimScaleFor(app) ?? null : next;
        app.editor.setDimOverride(dims, DIMVAR.DIMSCALE, value);
        app.log(`${dims.length} dimension(s) rescaled.`);
      }
      const s = dimScaleFor(app);
      app.log(`DIMSCALE ${next === 'auto' ? `Auto (now ${s ? fmt(s) : 'style default'})` : fmt(next)}; label height ${fmt(dimStyle(app.doc).txt / dimStyle(app.doc).scale * (s ?? dimStyle(app.doc).scale))}.`);
    },
  },
  {
    name: 'DIMEDIT', aliases: ['DED'], help: 'Change dimension label text (<> = measured value; empty = measured value only)',
    async run(app) {
      let dims = [...app.selection].filter((r) => r.type === 'DIMENSION');
      if (!dims.length) {
        const sel = await app.getEntity('Select dimension', (r) => r.type === 'DIMENSION');
        if (!sel) return;
        dims = [sel.rec];
      }
      const cur = dims[0].get(1) || '<>';
      const t = await app.getText(`Enter new dimension text (<> = measured value) <${cur}>`, cur);
      if (t === null) return;
      for (const d of dims) app.editor.setDimensionText(d, t === '<>' ? '' : t);
      app.log(`${dims.length} dimension label(s) changed.`);
    },
  },
  {
    name: 'DIMTXT', aliases: ['DIMTEXT', 'DTH'], help: 'Dimension label height (drawing units) for new and selected dimensions, or Auto',
    async run(app) {
      const dims = [...app.selection].filter((r) => r.type === 'DIMENSION');
      const t = app.dimTextHeight;
      const shown = dims.length ? fmt(dimStyleFor(app.doc, dims[0]).txt) : t === 'auto' ? 'Auto' : typeof t === 'number' ? fmt(t) : 'Dynamic';
      const v = ((await app.getText(`Enter new dimension text height or [Auto/Dynamic] <${shown}>`, shown)) ?? '').trim();
      if (/^d/i.test(v)) return dynamicTextHeight(app);
      if (/^a/i.test(v)) {
        app.dimTextHeight = 'auto';
        if (dims.length) app.editor.setDimTextHeight(dims, null);
        return app.log(`Dimension text height: Auto${dims.length ? ` (${dims.length} dimension(s) back to their style)` : ''}.`);
      }
      const h = Number(v);
      if (!(h > 0)) return app.log('Text height must be a positive number or Auto.', 'warn');
      app.dimTextHeight = h;
      if (dims.length) app.editor.setDimTextHeight(dims, h);
      app.log(`Dimension text height ${fmt(h)}${dims.length ? ` applied to ${dims.length} dimension(s) and` : ''} used for new dimensions.`);
    },
  },
  {
    name: 'DIMDYN', aliases: [], help: 'Dynamic label height: labels follow the measured value (ratio, limits, rounding)',
    async run(app) {
      await dynamicTextHeight(app);
    },
  },
  {
    name: 'DIMSTYLE', aliases: ['D', 'DST', 'DDIM'], help: 'Dimension Style Manager: create, modify, override, compare, rename, delete and set styles',
    async run(app) {
      openDimStyleManager(app);
    },
  },
  {
    name: '-DIMSTYLE', aliases: [], help: 'List dimension styles or set the current one (command line)',
    async run(app) {
      const styles = app.doc.table('DIMSTYLE')?.entries.map((e) => e.str(2)) ?? [];
      const cur = dimStyle(app.doc);
      for (const s of styles) {
        const st = dimStyle(app.doc, s);
        app.log(`${s === cur.name ? '* ' : '  '}${s}: text ${fmt(st.txt)}, arrows ${fmt(st.asz)}, ${st.dec} decimals${st.lfac !== 1 ? `, scale factor ${st.lfac}` : ''}, text ${st.tad ? 'above' : 'centred'}`);
      }
      const name = (await app.getText(`Set current dimension style <${cur.name}>`, cur.name))?.trim();
      if (!name || name === cur.name) return;
      const hit = styles.find((s) => s.toUpperCase() === name.toUpperCase());
      if (!hit) return app.log(`No dimension style "${name}".`, 'warn');
      app.editor.history.run('Dimension style', (tx) => setHeaderGroups(app.doc, '$DIMSTYLE', [group(2, hit)], tx));
      app.log(`Current dimension style: ${hit}`);
    },
  },
  {
    name: 'UCS', aliases: [], help: 'User coordinate system: pick a new origin (then optional X axis / XY plane points), or World/Previous/View/X/Y/Z/NAmed',
    async run(app) {
      const v = await app.getPoint('Specify origin of UCS or [NAmed/Previous/View/World/X/Y/Z] <World>', {
        keywords: ['NAmed', 'Previous', 'View', 'World', 'X', 'Y', 'Z'], allowEmpty: true,
      });
      const cur = app.ucs;
      if (v === null || v === 'World') {
        app.setUcs(Ucs.WORLD);
        return app.log('UCS: World');
      }
      if (v === 'Previous') {
        if (!app.previousUcs()) app.log('No previous UCS.', 'warn');
        return;
      }
      if (v === 'View') {
        // XY plane parallel to the screen, origin unchanged
        const r = app.scene.rot;
        app.setUcs(new Ucs(cur.origin, [r[0], r[1], r[2]], [r[4], r[5], r[6]]));
        return app.log('UCS aligned to the view.');
      }
      if (v === 'X' || v === 'Y' || v === 'Z') {
        const a = await app.getText(`Specify rotation angle about ${v} axis <90>`, '90');
        const deg = Number(a);
        if (!Number.isFinite(deg)) return app.log('Angle required.', 'warn');
        app.setUcs(cur.rotated(v, deg * DEG));
        return;
      }
      if (v === 'NAmed') return namedUcs(app);
      if (!isPoint(v)) return;
      // origin, then optionally a point on the new X axis and one in the new XY plane (3-point UCS)
      const o = cur.toWcs(v);
      const px = await app.getPoint('Specify point on X-axis or <Accept>', { base: v, allowEmpty: true, preview: (p) => [pline(app.ucs, [v, p])] });
      if (!isPoint(px)) {
        app.setUcs(cur.withOrigin(o));
        return app.log(`UCS origin set to ${fmtP(o)} (WCS).`);
      }
      const pxW = cur.toWcs(px);
      const py = await app.getPoint('Specify point on the XY plane or <Accept>', { base: v, allowEmpty: true, preview: (p) => [pline(app.ucs, [v, px, p])] });
      let next: Ucs | null;
      if (isPoint(py)) next = Ucs.threePoint(o, pxW, cur.toWcs(py));
      else {
        // keep the current Z axis: Y = Z x X
        const x = norm([pxW[0] - o[0], pxW[1] - o[1], pxW[2] - o[2]]);
        next = Math.hypot(...cross(cur.z, x)) > 1e-9 ? new Ucs(o, x, cross(cur.z, x)) : null;
      }
      if (!next) return app.log('Points must not be collinear.', 'warn');
      app.setUcs(next);
      app.log(`UCS origin ${fmtP(o)}, X axis ${fmtP(next.x)} (WCS).`);
    },
  },
  {
    name: 'UCSICON', aliases: [], help: 'UCS icon: ON, OFF, ORigin (at the UCS origin), Noorigin (lower-left corner)',
    async run(app) {
      const v = ((await app.getText('Enter an option [ON/OFF/ORigin/Noorigin]', 'ON')) ?? '').trim().toUpperCase();
      if (v === 'ON') app.ucsIconOn = true;
      else if (v === 'OFF') app.ucsIconOn = false;
      else if (v.startsWith('OR')) app.ucsIconAtOrigin = true;
      else if (v.startsWith('N')) app.ucsIconAtOrigin = false;
      else return app.log(`Unknown option "${v}".`, 'warn');
      app.redraw();
    },
  },
  {
    name: 'HELP', aliases: ['?'], help: 'List commands',
    async run(app) {
      for (const c of COMMANDS) app.log(`${c.name.padEnd(10)} ${c.aliases.length ? '(' + c.aliases.join(', ') + ') ' : ''}— ${c.help}`);
      app.log('Point input: click, x,y  @dx,dy  @dist<angle  or a distance along the cursor direction. F3 snap, F8 ortho, Esc cancel, Enter/Space/right-click repeat or finish.');
    },
  },
];

const fmtP = (p: number[]) => p.map((v) => fmt(v)).join(', ');

// ---- dimension helpers ------------------------------------------------------------------------
const W = (app: App, p: P2): Vec3 => app.ucs.toWcs(p);
const polar = (c: Vec3, r: number, deg: number): [number, number] => [c[0] + r * Math.cos(deg * DEG), c[1] + r * Math.sin(deg * DEG)];

/** Centre (WCS), radius and normal of an ARC or CIRCLE. */
function curveOf(r: DxfRecord): { center: Vec3; radius: number; normal: Vec3 } {
  const normal = norm(r.point(210, [0, 0, 1]));
  return { center: apply(ocsToWcs(normal), r.point(10)), radius: r.num(40, 0), normal };
}

/** Standard text heights (x 10^n) used when auto-sizing dimension labels. */
const NICE_HEIGHTS = [1, 1.5, 2, 2.5, 3.5, 5, 7];

/**
 * DIMSCALE for a new dimension. 'auto': labels at least 1/70 of the drawing's extent
 * (dimensions excluded), rounded up to a standard height; never smaller than the style's own.
 */
/** Diagonal of the drawing's extent, dimensions and infinite lines excluded (0 if empty). */
function drawingExtent(app: App): number {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const g of app.scene.items) {
    if (g.rec.type === 'DIMENSION' || !g.bbox || !g.prims.some((p) => p.k !== 'xline')) continue;
    b[0] = Math.min(b[0], g.bbox[0]); b[1] = Math.min(b[1], g.bbox[1]);
    b[2] = Math.max(b[2], g.bbox[2]); b[3] = Math.max(b[3], g.bbox[3]);
  }
  return b[0] <= b[2] ? Math.hypot(b[2] - b[0], b[3] - b[1]) : 0;
}

export function dimScaleFor(app: App): number | undefined {
  if (app.dimScale !== 'auto') return app.dimScale;
  const st = dimStyle(app.doc);
  const raw = st.txt / st.scale; // text height at DIMSCALE 1
  if (!(raw > 0)) return undefined;
  const diag = drawingExtent(app);
  if (!(diag > 0)) return undefined;
  const target = diag / 70;
  if (st.txt >= target * 0.999) return undefined; // the style is already big enough
  const e = Math.floor(Math.log10(target));
  const nice = NICE_HEIGHTS.map((v) => v * 10 ** e).find((v) => v >= target * 0.999) ?? 10 ** (e + 1);
  return +(nice / raw).toPrecision(6);
}

/** Size settings for a new dimension: a DIMTXT label height if one is set, else DIMSCALE (auto or fixed). */
function dimSizing(app: App): Pick<DimSpec, 'scale' | 'textHeight' | 'dynamic' | 'overrides'> {
  const t = app.dimTextHeight;
  const scale = app.dimScale === 'auto' && t !== 'auto' ? undefined : dimScaleFor(app);
  const overrides = Object.keys(app.dimOverrides).length ? app.dimOverrides : undefined;
  if (t === 'auto') return { scale, overrides };
  return typeof t === 'number' ? { scale, textHeight: t, overrides } : { scale, dynamic: t.dynamic, overrides };
}

/** Ask for dynamic label settings (ratio %, limits, rounding); defaults come from the drawing extent. */
async function askDynamic(app: App, prev?: DynText): Promise<DynText | null> {
  const ext = drawingExtent(app) || 100;
  const nice = (v: number) => +v.toPrecision(2);
  const d: DynText = prev ?? { ratio: 0.08, min: nice(ext / 250), max: nice(ext / 25), round: true };
  const r = Number(await app.getText(`Label height as % of the measured size <${fmt(d.ratio * 100)}>`, String(d.ratio * 100)));
  if (!(r > 0)) return app.log('The percentage must be positive.', 'warn'), null;
  const mn = Number(await app.getText(`Minimum label height <${fmt(d.min)}>`, String(d.min)));
  const mx = Number(await app.getText(`Maximum label height <${fmt(d.max)}>`, String(d.max)));
  if (!(mn > 0) || !(mx >= mn)) return app.log('Limits must be positive, with maximum ≥ minimum.', 'warn'), null;
  const rd = ((await app.getText(`Round to standard heights? [Yes/No] <${d.round ? 'Yes' : 'No'}>`, d.round ? 'Yes' : 'No')) ?? '').trim();
  return { ratio: r / 100, min: mn, max: mx, round: !/^n/i.test(rd) };
}

/** DIMTXT Dynamic / DIMDYN: new dimensions (and selected ones) follow their measured value. */
async function dynamicTextHeight(app: App) {
  const dims = [...app.selection].filter((r) => r.type === 'DIMENSION');
  const prev = typeof app.dimTextHeight === 'object' ? app.dimTextHeight.dynamic : dims.map(readDynamic).find(Boolean) ?? undefined;
  const d = await askDynamic(app, prev);
  if (!d) return;
  app.dimTextHeight = { dynamic: d };
  if (dims.length) app.editor.setDimDynamic(dims, d);
  app.log(`Dynamic label height: ${fmt(d.ratio * 100)}% of the measured size, ${fmt(d.min)}–${fmt(d.max)}${d.round ? ', rounded' : ''}${dims.length ? `; applied to ${dims.length} dimension(s)` : ''}.`);
}

function dimPreview(app: App, spec: DimSpec): Prim3[] {
  return app.scene.previewPrims3(previewDimension(app.doc, { ...spec, ...dimSizing(app) }, app.ucs));
}

function addDim(app: App, spec: DimSpec) {
  const rec = app.editor.addDimension({ ...spec, ...dimSizing(app) }, app.ucs, props(app));
  const blk = app.doc.block(rec.str(2));
  const label = blk?.entities.find((e) => e.type === 'MTEXT' || e.type === 'TEXT')?.get(1) ?? '';
  app.log(`Dimension added: ${label.replace(/%%c/gi, '⌀').replace(/%%d/gi, '°') || '(no text)'}`);
}

/** First/second extension line origins, or Enter to select a LINE (its endpoints). */
async function extensionOrigins(app: App): Promise<[P2, P2] | null> {
  const v = await app.getPoint('Specify first extension line origin or <select object>', { allowEmpty: true });
  if (v === null) {
    const sel = await app.getEntity('Select object to dimension', (r) => r.type === 'LINE');
    if (!sel) return null;
    const a = app.ucs.fromWcs(sel.rec.point(10)), b = app.ucs.fromWcs(sel.rec.point(11));
    return [[a[0], a[1]], [b[0], b[1]]];
  }
  if (!isPoint(v)) return null;
  const p2 = await needPoint(app, 'Specify second extension line origin', { base: v, preview: (p) => [pline(app.ucs, [v, p])] });
  return [v, p2];
}

/** DIMRADIUS / DIMDIAMETER: select an arc or circle, then place the label. */
async function radialDim(app: App, kind: 'radius' | 'diameter') {
  const sel = await app.getEntity('Select arc or circle', (r) => r.type === 'ARC' || r.type === 'CIRCLE');
  if (!sel) return;
  const { center, radius } = curveOf(sel.rec);
  let text: string | undefined;
  const spec = (p: P2): DimSpec => ({ kind, center, radius, textPos: W(app, p), text });
  for (;;) {
    const v = await app.getPoint('Specify dimension line location or [Text]', { keywords: ['Text'], preview: (p) => dimPreview(app, spec(p)) });
    if (v === 'Text') text = (await app.getText('Enter dimension text (<> = measured value)', '<>')) ?? undefined;
    else if (isPoint(v)) return addDim(app, spec(v));
    else return;
  }
}

/** Save the current UCS under a name the user types (toolbar "Save as…"). */
export async function saveCurrentUcs(app: App) {
  try {
    const name = (await app.getText('Enter name to save current UCS as'))?.trim();
    if (!name) return;
    const ok = app.editor.history.run('Save UCS', (tx) => saveNamedUcs(app.doc, name, app.ucs, tx));
    if (!ok) return app.log('This file has no UCS table.', 'warn');
    app.setUcs(new Ucs(app.ucs.origin, app.ucs.x, app.ucs.y, name), false);
    app.log(`UCS "${name}" saved.`);
  } catch (e) {
    if (!(e instanceof CancelError)) throw e;
  }
}

/** UCS NAmed: Save / Restore / Delete / ? (entries of the UCS table). */
async function namedUcs(app: App) {
  const v = ((await app.getText('Enter an option [Restore/Save/Delete/?]', 'Restore')) ?? '').trim().toUpperCase();
  const list = namedUcsList(app.doc);
  if (v === '?') {
    if (!list.length) return app.log('No named UCSs.');
    for (const u of list) app.log(`${u.name}: origin ${fmtP(u.origin)}, X ${fmtP(u.x)}, Y ${fmtP(u.y)}`);
    return;
  }
  const name = (await app.getText(`Enter name of UCS${list.length ? ` (${list.map((u) => u.name).join(', ')})` : ''}`))?.trim();
  if (!name) return;
  if (v.startsWith('S')) {
    const ok = app.editor.history.run('Save UCS', (tx) => saveNamedUcs(app.doc, name, app.ucs, tx));
    if (!ok) return app.log('This file has no UCS table.', 'warn');
    app.setUcs(new Ucs(app.ucs.origin, app.ucs.x, app.ucs.y, name), false);
    app.log(`UCS "${name}" saved.`);
  } else if (v.startsWith('D')) {
    const ok = app.editor.history.run('Delete UCS', (tx) => deleteNamedUcs(app.doc, name, tx));
    app.log(ok ? `UCS "${name}" deleted.` : `No UCS named "${name}".`, ok ? undefined : 'warn');
  } else {
    const u = list.find((x) => x.name.toUpperCase() === name.toUpperCase());
    if (!u) return app.log(`No UCS named "${name}".`, 'warn');
    app.setUcs(u);
    app.log(`UCS "${u.name}" restored.`);
  }
}

function report(app: App, skipped: string[]) {
  if (skipped.length) app.log(`Skipped (not transformable): ${[...new Set(skipped)].join(', ')}`, 'warn');
}

const LOOKUP = new Map<string, CommandDef>();
for (const c of COMMANDS) {
  LOOKUP.set(c.name, c);
  for (const a of c.aliases) LOOKUP.set(a, c);
}

/**
 * The command line: shows the prompt, parses typed input (commands, coordinates,
 * keywords) and keeps a scrolling history log, like AutoCAD's.
 */
export class CommandLine {
  el: HTMLElement;
  private logEl: HTMLElement;
  private promptEl: HTMLElement;
  input: HTMLInputElement;
  private history: string[] = [];
  private hIndex = -1;
  private lastCommand: CommandDef | null = null;
  lastAlias = '';
  lastTextHeight = 2.5;
  busy = false;

  constructor(private app: App) {
    this.logEl = h('div.cmd-log');
    this.promptEl = h('span.cmd-prompt', 'Command:');
    this.input = h('input.cmd-input', { spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Command line' }) as HTMLInputElement;
    this.el = h('div.cmdline', this.logEl, h('div.cmd-row', this.promptEl, this.input));
    app.log = (msg, cls) => this.print(msg, cls);
    app.onPrompt.push(() => this.updatePrompt());
    this.input.addEventListener('keydown', (e) => this.key(e));
  }

  print(msg: string, cls?: string) {
    const line = h('div.cmd-line' + (cls ? '.' + cls : ''), msg);
    this.logEl.append(line);
    while (this.logEl.childElementCount > 200) this.logEl.firstElementChild!.remove();
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  private updatePrompt() {
    const p = this.app.prompt;
    let text = 'Command:';
    if (p) {
      text = p.message + (p.kind === 'select' ? ` (${this.app.selection.size} selected, Enter to finish)` : '') + ':';
      if (p.kind === 'text' && p.def !== undefined && !p.message.includes('<')) text = `${p.message} <${p.def}>:`;
    }
    if (this.promptEl.textContent !== text) this.promptEl.textContent = text;
  }

  private key(e: KeyboardEvent) {
    const p = this.app.prompt;
    if (e.key === 'Escape') {
      e.preventDefault();
      this.input.value = '';
      this.app.escape();
      this.input.blur();
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (!this.history.length) return;
      e.preventDefault();
      this.hIndex = Math.max(0, Math.min(this.history.length - 1, this.hIndex + (e.key === 'ArrowUp' ? 1 : -1)));
      this.input.value = this.history[this.history.length - 1 - this.hIndex];
      return;
    }
    const isSpaceSubmit = e.key === ' ' && !(p && p.kind === 'text');
    if (e.key === 'Enter' || isSpaceSubmit) {
      e.preventDefault();
      this.submit();
    }
  }

  /** Enter: run a command, answer the active prompt, or repeat the last command. */
  submit() {
    const raw = this.input.value;
    const text = raw.trim();
    this.input.value = '';
    this.hIndex = -1;
    if (text) this.history.push(text);
    const p = this.app.prompt;
    if (!p) {
      if (!text) {
        if (this.lastCommand) this.start(this.lastCommand, this.lastAlias);
        return;
      }
      // "-NAME" is the command-line form of a dialog command (e.g. -DIMSTYLE); otherwise "-", "_", "." prefixes are ignored
      const u = text.toUpperCase();
      const def = LOOKUP.get(u.replace(/^[_.]+/, '')) ?? LOOKUP.get(u.replace(/^[_.\-]+/, ''));
      if (!def) {
        this.print(`Unknown command "${text.toUpperCase()}". Type HELP for a list.`, 'warn');
        return;
      }
      this.start(def, text.toUpperCase());
      return;
    }
    this.print(`${p.message}: ${raw}`, 'echo');
    if (p.kind === 'entity') {
      if (!text && p.allowEmpty) this.app.answer(null);
      else this.print('Pick an object in the drawing.', 'warn');
      return;
    }
    if (p.kind === 'select') {
      this.app.answer([...this.app.selection]);
      return;
    }
    if (p.kind === 'text') {
      this.app.answer(raw.length ? raw : p.def ?? null);
      return;
    }
    // point prompt
    if (!text) {
      if (p.allowEmpty || p.keywords?.length) this.app.answer(null);
      return;
    }
    const kw = p.keywords?.find((k) => k.toUpperCase().startsWith(text.toUpperCase()) || k[0].toUpperCase() === text.toUpperCase());
    if (kw && !/^[-+\d.@]/.test(text)) {
      this.app.answer(kw);
      return;
    }
    if (p.rawNumber && /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) {
      this.app.answer(text);
      return;
    }
    const pt = this.parsePoint(text, p.base);
    if (!pt) {
      this.print('Point or option keyword required.', 'warn');
      return;
    }
    this.app.answer(pt);
  }

  /** x,y | @dx,dy | @d<a | d<a | distance (along the cursor direction from the base point). */
  parsePoint(text: string, base?: P2): P2 | null {
    const num = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[-+]?\\d+)?';
    const rel = text.startsWith('@');
    const t = rel ? text.slice(1) : text;
    const origin: P2 = rel ? base ?? this.app.lastPoint ?? [0, 0] : [0, 0];
    let m = new RegExp(`^(${num})\\s*,\\s*(${num})(?:\\s*,\\s*(${num}))?$`, 'i').exec(t);
    if (m) return [origin[0] + Number(m[1]), origin[1] + Number(m[2])];
    m = new RegExp(`^(${num})\\s*<\\s*(${num})$`, 'i').exec(t);
    if (m) {
      const d = Number(m[1]), a = Number(m[2]) * DEG;
      return [origin[0] + d * Math.cos(a), origin[1] + d * Math.sin(a)];
    }
    if (rel && !t) return origin;
    m = new RegExp(`^(${num})$`, 'i').exec(t);
    if (m && base) {
      // direct distance entry
      const [cx, cy] = this.app.effectiveCursor();
      const dx = cx - base[0], dy = cy - base[1];
      const l = Math.hypot(dx, dy);
      if (l < 1e-12) return null;
      const d = Number(m[1]);
      return [base[0] + (dx / l) * d, base[1] + (dy / l) * d];
    }
    return null;
  }

  async start(def: CommandDef, alias: string) {
    if (this.busy) this.app.cancelPrompt();
    this.lastCommand = def;
    this.lastAlias = alias;
    this.print(`Command: ${def.name}`, 'echo');
    this.busy = true;
    try {
      await def.run(this.app, this);
    } catch (e) {
      if (e instanceof CancelError) {
        if (e.message) this.print(e.message, 'dim');
      } else {
        console.error(e);
        this.print(`Error: ${(e as Error).message}`, 'warn');
      }
    } finally {
      this.busy = false;
      this.app.emit(this.app.onPrompt);
    }
  }

  run(name: string) {
    const def = LOOKUP.get(name.toUpperCase());
    if (def) this.start(def, name.toUpperCase());
  }
}

export const COMMAND_NAMES = COMMANDS.map((c) => c.name);
