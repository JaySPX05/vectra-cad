import type { VarValue } from '../dims/style';
import type { DxfRecord, Vec3 } from '../dxf/record';
import { parseDxf } from '../dxf/parser';
import { writeDxf } from '../dxf/writer';
import { DxfDocument, ACAD_VERSIONS } from '../model/database';
import { Scene } from '../render/scene';
import { Renderer, fitView, screenToWorld, worldToScreen, type View, type RenderOptions, type VisualStyle } from '../render/canvas';
import { type Prim, type Prim3, projectPrim } from '../render/prims';
import { TOP, isTopView, orbitDir, project, rayToPlane, unproject, viewFromVport, viewRotation } from '../geom/view';
import { Ucs, readUcs, writeUcs } from '../model/ucs';
import { convertToRomans } from '../model/fonts';
import type { DynText } from '../dims/dynamic';
import { romansForced } from '../render/text';
import { Editor } from '../edit/editor';
import { gripsFor, applyGrip, type Grip } from '../edit/grips';
import { similarity, transformEntity } from '../edit/transform';
import { desktop } from '../desktop';
import { findSnap, type SnapPoint } from './snap';
import { h } from './dom';

export type P2 = [number, number];

export class CancelError extends Error {}

interface PromptBase {
  message: string;
  keywords?: string[];
}
export interface PointPrompt extends PromptBase {
  kind: 'point';
  base?: P2;
  /** World-space preview geometry for a candidate point. */
  preview?: (p: P2) => Prim3[];
  allowEmpty?: boolean;
  /** Typed plain numbers resolve as strings (angles, factors) instead of direct distances. */
  rawNumber?: boolean;
  resolve: (v: P2 | string | null) => void;
  reject: (e: Error) => void;
}
export interface TextPrompt extends PromptBase {
  kind: 'text';
  def?: string;
  resolve: (v: string | null) => void;
  reject: (e: Error) => void;
}
export interface SelectPrompt extends PromptBase {
  kind: 'select';
  resolve: (v: DxfRecord[]) => void;
  reject: (e: Error) => void;
}
/** Pick one entity (e.g. "Select arc or circle"); resolves with the entity and the UCS pick point. */
export interface EntityPrompt extends PromptBase {
  kind: 'entity';
  filter: (r: DxfRecord) => boolean;
  allowEmpty?: boolean;
  resolve: (v: { rec: DxfRecord; p: P2 } | null) => void;
  reject: (e: Error) => void;
}
export type Prompt = PointPrompt | TextPrompt | SelectPrompt | EntityPrompt;

const UNITS: Record<number, string> = { 0: 'unitless', 1: 'in', 2: 'ft', 3: 'mi', 4: 'mm', 5: 'cm', 6: 'm', 7: 'km', 14: 'dm' };

/**
 * Application controller: owns the document, scene, editor and view, and implements
 * the interactive viewport (pan/zoom, picking, selection, grips, snaps, prompts).
 */
export class App {
  doc!: DxfDocument;
  scene!: Scene;
  editor!: Editor;
  renderer: Renderer;
  view: View = { cx: 0, cy: 0, s: 1, w: 1, h: 1 };
  fileName = 'drawing.dxf';
  /** Full path of the opened file (desktop app only). */
  filePath: string | null = null;
  selection = new Set<DxfRecord>();
  hover: DxfRecord | null = null;
  dark = true;
  lineweights = true;
  snapOn = true;
  orthoOn = false;
  currentLayer = '0';
  prompt: Prompt | null = null;
  /** Cursor in world XY (on the plane Z = 0, or the hot grip's plane). */
  cursor: P2 = [0, 0];
  /** Cursor in camera space (= world XY in the top view). */
  cam: P2 = [0, 0];
  /** False when the view is edge-on to the drawing plane and a point can't be picked there. */
  cursorOk = true;
  /** Current view direction (target -> eye) and visual style. */
  viewDirection: Vec3 = TOP;
  visualStyle: VisualStyle = 'wireframe';
  /** Left-drag orbits instead of selecting. */
  orbitMode = false;
  /** Current user coordinate system (mirrors the drawing's $UCSORG/$UCSXDIR/$UCSYDIR). */
  ucs: Ucs = Ucs.WORLD;
  private ucsHistory: Ucs[] = [];
  /** DIMSCALE for new dimensions: a number, or 'auto' (sized from the drawing's extent). */
  dimScale: number | 'auto' = 'auto';
  /** DIMTXT: label height for new dimensions in drawing units, or 'auto' (follow DIMSCALE sizing). */
  dimTextHeight: number | 'auto' | { dynamic: DynText } = 'auto';
  /** Dimension Style Manager "Override": variable values new dimensions get as DSTYLE overrides. */
  dimOverrides: Record<string, VarValue> = {};
  /** UCSICON: shown, and placed at the origin when it is on screen. */
  ucsIconOn = true;
  ucsIconAtOrigin = true;
  onView: Array<() => void> = [];
  /** AutoCAD's LASTPOINT: origin for @-relative input when a prompt has no base point. */
  lastPoint: P2 | null = null;
  snap: SnapPoint | null = null;
  dirtyFile = false;

  // listeners
  onDocument: Array<() => void> = [];
  onSelection: Array<() => void> = [];
  onPrompt: Array<() => void> = [];
  onInspect: Array<() => void> = [];
  /** A non-selected record shown in the inspector (table entry, object, block...). */
  inspected: DxfRecord | null = null;
  log: (msg: string, cls?: string) => void = () => {};

  private needsDraw = false;
  private box: { x0: number; y0: number; x1: number; y1: number; dragged: boolean } | null = null;
  private pan: { x: number; y: number; cx: number; cy: number } | null = null;
  private hotGrip: { rec: DxfRecord; grip: Grip; startX: number; startY: number; moved: boolean } | null = null;
  private screen: P2 = [0, 0];
  private spaceDown = false;
  /** Keep the drawing fitted to the window until the user zooms or pans (e.g. window still sizing). */
  autoFit = true;
  private orbit: { x: number; y: number; dir: Vec3 } | null = null;

  constructor(public canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
    this.bindEvents();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement!);
    this.resize();
  }

  // ---- document lifecycle ------------------------------------------------------------
  /** Parse and show a drawing; `prepare` may adjust the parsed document first (e.g. DWG import fixes). */
  load(bytes: Uint8Array | string, name: string, prepare?: (doc: DxfDocument) => void): void {
    const t0 = performance.now();
    const doc = parseDxf(bytes);
    prepare?.(doc);
    const t1 = performance.now();
    this.setDocument(doc, name);
    const t2 = performance.now();
    this.applyRomans();
    const ver = ACAD_VERSIONS[doc.version] ?? doc.version;
    this.log(`Opened ${name} — ${ver} (${doc.version}), ${this.scene.items.length} model-space entities. Parse ${(t1 - t0).toFixed(0)} ms, regen ${(t2 - t1).toFixed(0)} ms.`);
    const unsup = [...this.scene.env.unsupported];
    if (unsup.length) this.log(`Not drawn: ${unsup.map(([k, v]) => `${k} ×${v}`).join(', ')}`, 'warn');
  }

  setDocument(doc: DxfDocument, name: string): void {
    this.doc = doc;
    this.fileName = name;
    this.filePath = null;
    this.scene = new Scene(doc);
    this.editor = new Editor(doc, this.scene);
    this.editor.onChanged = () => {
      this.dirtyFile = true;
      this.ucs = readUcs(this.doc);
      for (const r of [...this.selection]) if (!this.scene.geomOf(r)) this.selection.delete(r);
      this.emit(this.onDocument);
      this.emit(this.onSelection);
      this.redraw();
    };
    this.selection.clear();
    this.dimOverrides = {};
    this.inspected = null;
    this.hover = null;
    const clayer = doc.headerValue('$CLAYER');
    this.currentLayer = clayer && doc.layer(clayer) ? clayer : '0';
    this.dirtyFile = false;
    this.ucs = readUcs(doc);
    this.ucsHistory = [];
    // 3D drawings open in the view they were saved with (*Active VPORT)
    const saved = viewFromVport(doc);
    this.viewDirection = saved ? saved.dir : TOP;
    this.scene.setView(viewRotation(this.viewDirection, saved?.twist ?? 0));
    this.emit(this.onView);
    this.zoomExtents();
    this.emit(this.onDocument);
    this.emit(this.onSelection);
  }

  /**
   * Roman S mode: switch the drawing's text styles to romans.shx (one undoable step, saved with
   * the file). Display already draws every text in Roman Simplex while the mode is on.
   */
  applyRomans(): void {
    if (!romansForced() || !this.doc) return;
    const wasDirty = this.dirtyFile;
    const r = this.editor.history.run('Roman S fonts', (tx) => convertToRomans(this.doc, tx));
    // a display-equivalent change: saved with the next real edit, but opening a file alone
    // shouldn't mark it modified (no "Save changes?" for just viewing)
    this.dirtyFile = wasDirty;
    this.emit(this.onDocument);
    if (r.styles || r.mtext) {
      this.log(`Fonts: ${r.styles} text style(s) set to romans.shx${r.mtext ? `, font switches removed from ${r.mtext} MTEXT` : ''} (Undo to revert).`);
    }
  }

  newDocument(): void {
    // A minimal R2018 template, parsed like any other file.
    this.load(EMPTY_DXF, 'untitled.dxf');
  }

  /**
   * Save. Desktop: write back to the opened .dxf (Save As for new drawings and DWG sources);
   * browser: download a .dxf. Resolves false if the user cancelled.
   */
  async save(saveAs = false): Promise<boolean> {
    const dxfName = this.fileName.replace(/\.(dxf|dwg)$/i, '') + '.dxf';
    if (desktop) {
      const data = new TextEncoder().encode(writeDxf(this.doc));
      const canOverwrite = !saveAs && this.filePath && /\.dxf$/i.test(this.filePath);
      try {
        const res = canOverwrite
          ? await desktop.saveFile(this.filePath!, data)
          : await desktop.saveFileAs(this.filePath ? this.filePath.replace(/\.(dxf|dwg)$/i, '') + '.dxf' : dxfName, data);
        if (!res) return false;
        this.filePath = res.path;
        this.fileName = res.name;
        this.dirtyFile = false;
        this.log(`Saved ${res.path} (${(data.length / 1024).toFixed(0)} KB, ${this.doc.version}).`);
        this.emit(this.onDocument);
        return true;
      } catch (e) {
        this.log(`Could not save: ${(e as Error).message}`, 'warn');
        return false;
      }
    }
    this.download();
    return true;
  }

  /** Browser save: download the drawing as DXF. */
  private download(): void {
    const text = writeDxf(this.doc);
    const blob = new Blob([text], { type: 'application/dxf' });
    const a = h('a', { href: URL.createObjectURL(blob), download: this.fileName.replace(/\.(dxf|dwg)$/i, '') + '.dxf' }) as HTMLAnchorElement;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    this.dirtyFile = false;
    this.log(`Saved ${a.download} (${(text.length / 1024).toFixed(0)} KB, ${this.doc.version}).`);
  }

  get unitsLabel(): string {
    return UNITS[this.doc?.headerNum('$INSUNITS', 0) ?? 0] ?? 'units';
  }

  // ---- view ---------------------------------------------------------------------------
  private resize() {
    const el = this.canvas.parentElement!;
    const dpr = window.devicePixelRatio || 1;
    const w = el.clientWidth, hgt = el.clientHeight;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(hgt * dpr));
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = hgt + 'px';
    this.view = { ...this.view, w, h: hgt };
    if (this.autoFit && this.scene) this.view = fitView(this.view, this.scene.computeExtents());
    this.redraw();
  }

  /**
   * Change the view direction. With `fit`, zoom to extents (preset views); otherwise keep
   * the world point at the screen centre fixed (orbiting).
   */
  setViewDir(dir: Vec3, fit = false): void {
    const oldRot = this.scene.rot;
    const wb = this.scene.worldBounds();
    const c3: Vec3 = wb ? [(wb[0][0] + wb[1][0]) / 2, (wb[0][1] + wb[1][1]) / 2, (wb[0][2] + wb[1][2]) / 2] : [0, 0, 0];
    const depth = project(oldRot, c3)[2];
    const pivot = unproject(oldRot, [this.view.cx, this.view.cy, depth]);
    this.viewDirection = dir;
    this.scene.setView(viewRotation(dir));
    const q = project(this.scene.rot, pivot);
    this.view = { ...this.view, cx: q[0], cy: q[1] };
    if (fit) this.zoomExtents();
    else this.autoFit = false;
    this.emit(this.onView);
    this.redraw();
  }

  /** Make `u` the current UCS (undoable, saved in the drawing). */
  setUcs(u: Ucs, remember = true): void {
    if (remember && !u.equals(this.ucs)) this.ucsHistory.push(this.ucs);
    if (this.ucsHistory.length > 10) this.ucsHistory.shift();
    this.editor.history.run('UCS', (tx) => writeUcs(this.doc, u, tx));
    this.ucs = u;
    this.emit(this.onView);
    this.redraw();
  }

  /** UCS Previous. */
  previousUcs(): boolean {
    const u = this.ucsHistory.pop();
    if (!u) return false;
    this.setUcs(u, false);
    return true;
  }

  get isTop(): boolean {
    return isTopView(this.scene.rot);
  }

  /** Screen position of a world point. */
  toScreen(p: Vec3): P2 {
    const q = project(this.scene.rot, p);
    return worldToScreen(this.view, q[0], q[1]);
  }

  zoomExtents(): void {
    if (!this.scene) return;
    this.autoFit = true;
    this.view = fitView(this.view, this.scene.computeExtents());
    this.redraw();
  }

  /** Fit the view to the selected entities. */
  zoomSelection(): void {
    this.autoFit = false;
    const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const r of this.selection) {
      const g = this.scene.geomOf(r)?.bbox;
      if (!g) continue;
      b[0] = Math.min(b[0], g[0]); b[1] = Math.min(b[1], g[1]); b[2] = Math.max(b[2], g[2]); b[3] = Math.max(b[3], g[3]);
    }
    if (b[0] > b[2]) return;
    const pad = Math.max(b[2] - b[0], b[3] - b[1]) * 0.15 || 1;
    this.view = fitView(this.view, [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad]);
    this.redraw();
  }

  zoomAt(px: number, py: number, factor: number): void {
    this.autoFit = false;
    const [wx, wy] = screenToWorld(this.view, px, py);
    const s = Math.min(1e12, Math.max(1e-12, this.view.s * factor));
    this.view = { ...this.view, s };
    const [nx, ny] = screenToWorld(this.view, px, py);
    this.view.cx += wx - nx;
    this.view.cy += wy - ny;
    this.redraw();
  }

  redraw(): void {
    if (this.needsDraw) return;
    this.needsDraw = true;
    requestAnimationFrame(() => {
      this.needsDraw = false;
      this.draw();
    });
  }

  get renderOptions(): RenderOptions {
    return { dark: this.dark, lineweights: this.lineweights, selection: this.selection, hover: this.hover, visualStyle: this.visualStyle };
  }

  private draw() {
    if (!this.scene) return;
    const o = this.renderOptions;
    this.renderer.draw(this.scene, this.view, o);
    const ctx = this.renderer.ctx;
    // command / grip preview
    const pv = this.previewPrims();
    if (pv.length) this.renderer.drawPrims(pv, this.view, o, null);
    const hg = this.hotGrip?.grip;
    const base: Vec3 | undefined = hg ? [hg.x, hg.y, hg.z] : this.prompt?.kind === 'point' && this.prompt.base ? this.ucs.toWcs(this.prompt.base) : undefined;
    if (base && this.cursorOk) {
      const [ax, ay] = this.toScreen(base);
      const [bx, by] = this.toScreen(this.cursor3());
      ctx.save();
      ctx.strokeStyle = this.dark ? '#9aa4b0' : '#555';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.restore();
    }
    this.drawGrips(ctx);
    if (this.box) {
      const { x0, y0, x1, y1 } = this.box;
      const crossing = x1 < x0;
      ctx.save();
      ctx.fillStyle = crossing ? 'rgba(80,200,120,0.12)' : 'rgba(80,140,255,0.12)';
      ctx.strokeStyle = crossing ? '#5c8' : '#58f';
      ctx.setLineDash(crossing ? [5, 4] : []);
      ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.restore();
    }
    if (this.snap) this.drawSnapMarker(ctx, this.snap);
    this.drawCrosshair(ctx);
    this.renderer.drawTriad(this.scene.rot, this.view);
    if (this.ucsIconOn) this.drawUcsIcon(ctx);
  }

  /**
   * The UCS icon: X/Y arrows of the current UCS, drawn at its origin when visible (UCSICON ORigin),
   * otherwise in the lower-left corner. "W" marks the World UCS; a cross marks the origin.
   */
  private drawUcsIcon(ctx: CanvasRenderingContext2D) {
    const u = this.ucs;
    let [ox, oy] = this.toScreen(u.origin);
    const margin = 30;
    const atOrigin = this.ucsIconAtOrigin && ox > margin && ox < this.view.w - 70 && oy > 70 && oy < this.view.h - margin;
    if (!atOrigin) [ox, oy] = [100, this.view.h - 44];
    const len = 34;
    const dirScreen = (d: Vec3): P2 => {
      const q = project(this.scene.rot, d);
      return [q[0], -q[1]];
    };
    const color = this.dark ? '#e8edf3' : '#1d2530';
    ctx.save();
    ctx.setLineDash([]);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.5;
    ctx.font = 'bold 11px system-ui, sans-serif';
    for (const [d, label] of [[u.x, 'X'], [u.y, 'Y']] as [Vec3, string][]) {
      const [dx, dy] = dirScreen(d);
      const l = Math.hypot(dx, dy);
      if (l < 0.05) continue; // axis points at the viewer
      const ex = ox + dx * len, ey = oy + dy * len;
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(ex, ey);
      // arrow head
      const ux = dx / l, uy = dy / l;
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - ux * 7 - uy * 3.5, ey - uy * 7 + ux * 3.5);
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - ux * 7 + uy * 3.5, ey - uy * 7 - ux * 3.5);
      ctx.stroke();
      ctx.fillText(label, ex + ux * 6 - 4, ey + uy * 6 + 4);
    }
    if (u.isWorld) ctx.fillText('W', ox + 6, oy - 6);
    else if (u.name) ctx.fillText(u.name, ox + 6, oy + 16);
    if (atOrigin) {
      // origin marker
      ctx.beginPath();
      ctx.moveTo(ox - 4, oy - 4); ctx.lineTo(ox + 4, oy + 4);
      ctx.moveTo(ox + 4, oy - 4); ctx.lineTo(ox - 4, oy + 4);
      ctx.stroke();
    } else {
      ctx.strokeRect(ox - 3, oy - 3, 6, 6);
    }
    ctx.restore();
  }

  private drawCrosshair(ctx: CanvasRenderingContext2D) {
    const [x, y] = this.screen;
    ctx.save();
    ctx.strokeStyle = this.dark ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    const r = this.prompt?.kind === 'point' || this.hotGrip ? 40 : 14;
    ctx.moveTo(x - r, y + 0.5); ctx.lineTo(x + r, y + 0.5);
    ctx.moveTo(x + 0.5, y - r); ctx.lineTo(x + 0.5, y + r);
    if (!(this.prompt?.kind === 'point')) ctx.strokeRect(x - 4.5, y - 4.5, 9, 9);
    ctx.stroke();
    ctx.restore();
  }

  private drawSnapMarker(ctx: CanvasRenderingContext2D, s: SnapPoint) {
    const [x, y] = this.toScreen([s.x, s.y, s.z]);
    const r = 6;
    ctx.save();
    ctx.strokeStyle = '#ffb000';
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.beginPath();
    switch (s.kind) {
      case 'endpoint': ctx.rect(x - r, y - r, 2 * r, 2 * r); break;
      case 'midpoint': ctx.moveTo(x, y - r); ctx.lineTo(x + r, y + r); ctx.lineTo(x - r, y + r); ctx.closePath(); break;
      case 'center': ctx.arc(x, y, r, 0, Math.PI * 2); break;
      case 'quadrant': ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); break;
      case 'intersection': ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); break;
      case 'insertion': ctx.rect(x - r, y - r, r, r); ctx.rect(x, y, r, r); break;
      case 'node': ctx.arc(x, y, r, 0, Math.PI * 2); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); break;
      default: ctx.rect(x - r, y - r, 2 * r, 2 * r);
    }
    ctx.stroke();
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = '#ffb000';
    ctx.fillText(s.kind, x + 10, y + 18);
    ctx.restore();
  }

  private gripList(): { rec: DxfRecord; grip: Grip }[] {
    if (this.prompt || this.selection.size === 0 || this.selection.size > 60) return [];
    const out: { rec: DxfRecord; grip: Grip }[] = [];
    for (const r of this.selection) for (const g of gripsFor(r)) out.push({ rec: r, grip: g });
    return out;
  }

  private drawGrips(ctx: CanvasRenderingContext2D) {
    ctx.save();
    ctx.setLineDash([]);
    for (const { rec, grip } of this.gripList()) {
      const [x, y] = this.toScreen([grip.x, grip.y, grip.z]);
      const hot = this.hotGrip && this.hotGrip.rec === rec && this.hotGrip.grip === grip;
      ctx.fillStyle = hot ? '#ff3b30' : '#2f7dff';
      ctx.strokeStyle = '#0b2a66';
      ctx.fillRect(x - 4, y - 4, 8, 8);
      ctx.strokeRect(x - 4.5, y - 4.5, 9, 9);
    }
    ctx.restore();
  }

  private previewPrims(): Prim[] {
    if (this.hotGrip) {
      const { rec, grip } = this.hotGrip;
      const c = rec.clone();
      const [x, y] = this.effectiveCursor();
      try {
        if (grip.move) transformEntity(c, similarity({ dx: x - grip.x, dy: y - grip.y }), this.doc);
        else applyGrip(c, grip, x, y);
      } catch {
        return [];
      }
      return this.scene.previewPrims([c]);
    }
    if (this.prompt?.kind === 'point' && this.prompt.preview && this.cursorOk) {
      try {
        return this.prompt.preview(this.effectiveCursor()).map((p) => projectPrim(p, this.scene.rot));
      } catch {
        return [];
      }
    }
    return [];
  }

  // ---- cursor & snapping ------------------------------------------------------------------
  /**
   * The point a click would enter, after object snap and ortho. While dragging a grip this is
   * WCS XY (grips live in WCS); otherwise it is in **UCS** coordinates, like AutoCAD's input.
   */
  effectiveCursor(): P2 {
    const hg = this.hotGrip?.grip;
    if (this.snap) {
      if (hg) return [this.snap.x, this.snap.y];
      const u = this.ucs.fromWcs([this.snap.x, this.snap.y, this.snap.z]);
      return [u[0], u[1]];
    }
    let [x, y] = this.cursor;
    const base = hg ? ([hg.x, hg.y] as P2) : this.prompt?.kind === 'point' ? this.prompt.base : undefined;
    if (this.orthoOn && base) {
      if (Math.abs(x - base[0]) > Math.abs(y - base[1])) y = base[1];
      else x = base[0];
    }
    return [x, y];
  }

  /** World position of the effective cursor (snap point, or on the working plane). */
  cursor3(): Vec3 {
    if (this.snap) return [this.snap.x, this.snap.y, this.snap.z];
    const [x, y] = this.effectiveCursor();
    return this.hotGrip ? [x, y, this.hotGrip.grip.z] : this.ucs.toWcs([x, y]);
  }

  /** Effective cursor in UCS coordinates (for the status bar). */
  cursorUcs(): Vec3 {
    return this.ucs.fromWcs(this.cursor3());
  }

  private updateCursor(px: number, py: number) {
    this.screen = [px, py];
    this.cam = screenToWorld(this.view, px, py);
    // the working plane: the UCS XY plane, or the dragged grip's own WCS Z plane
    const hg = this.hotGrip?.grip;
    const origin: Vec3 = hg ? [0, 0, hg.z] : this.ucs.origin;
    const normal: Vec3 = hg ? [0, 0, 1] : this.ucs.z;
    const w = rayToPlane(this.scene.rot, this.cam[0], this.cam[1], origin, normal);
    this.cursorOk = !!w;
    if (w) {
      if (hg) this.cursor = [w[0], w[1]];
      else {
        const u = this.ucs.fromWcs(w);
        this.cursor = [u[0], u[1]];
      }
    }
    const wantsPoint = this.prompt?.kind === 'point' || !!this.hotGrip;
    this.snap = null;
    if (wantsPoint && this.snapOn) this.snap = findSnap(this.scene, this.cam[0], this.cam[1], 10 / this.view.s);
    if (!wantsPoint && !this.box && !this.pan && !this.orbit) {
      const g = this.scene.pick(this.cam[0], this.cam[1], 5 / this.view.s);
      const nh = g ? g.rec : null;
      if (nh !== this.hover) this.hover = nh;
    } else this.hover = null;
    this.emit(this.onPrompt);
    this.redraw();
  }

  // ---- prompts ----------------------------------------------------------------------------
  getPoint(message: string, opts: Partial<Omit<PointPrompt, 'kind' | 'resolve' | 'reject' | 'message'>> = {}): Promise<P2 | string | null> {
    return new Promise((resolve, reject) => this.setPrompt({ kind: 'point', message, ...opts, resolve, reject }));
  }
  getText(message: string, def?: string): Promise<string | null> {
    return new Promise((resolve, reject) => this.setPrompt({ kind: 'text', message, def, resolve, reject }));
  }
  getEntity(message: string, filter: (r: DxfRecord) => boolean, allowEmpty = false): Promise<{ rec: DxfRecord; p: P2 } | null> {
    return new Promise((resolve, reject) => this.setPrompt({ kind: 'entity', message, filter, allowEmpty, resolve, reject }));
  }
  getSelection(message = 'Select objects'): Promise<DxfRecord[]> {
    if (this.selection.size) return Promise.resolve([...this.selection]);
    return new Promise((resolve, reject) => this.setPrompt({ kind: 'select', message, resolve, reject }));
  }
  private setPrompt(p: Prompt) {
    this.prompt = p;
    this.hotGrip = null;
    this.emit(this.onPrompt);
    this.redraw();
  }
  /** Settle the active prompt (called by the command line and the viewport). */
  answer(value: P2 | string | null | DxfRecord[] | { rec: DxfRecord; p: P2 }): void {
    const p = this.prompt;
    if (!p) return;
    this.prompt = null;
    this.snap = null;
    if (Array.isArray(value) && typeof value[0] === 'number') this.lastPoint = value as P2;
    (p.resolve as (v: unknown) => void)(value);
    this.emit(this.onPrompt);
    this.redraw();
  }
  cancelPrompt(): void {
    const p = this.prompt;
    if (!p) return;
    this.prompt = null;
    p.reject(new CancelError('*Cancel*'));
    this.emit(this.onPrompt);
    this.redraw();
  }

  // ---- selection ---------------------------------------------------------------------------
  select(recs: DxfRecord[], mode: 'add' | 'remove' | 'replace' = 'add') {
    this.inspected = null;
    if (mode === 'replace') this.selection.clear();
    for (const r of recs) mode === 'remove' ? this.selection.delete(r) : this.selection.add(r);
    this.emit(this.onSelection);
    this.redraw();
  }
  clearSelection() {
    if (!this.selection.size) return;
    this.selection.clear();
    this.emit(this.onSelection);
    this.redraw();
  }

  inspect(rec: DxfRecord | null) {
    this.inspected = rec;
    this.emit(this.onInspect);
  }

  emit(list: Array<() => void>) {
    for (const f of list) f();
  }

  // ---- events ------------------------------------------------------------------------------
  private bindEvents() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.pow(1.0015, -e.deltaY));
      this.updateCursor(e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    c.addEventListener('mousedown', (e) => this.mouseDown(e));
    window.addEventListener('mousemove', (e) => this.mouseMove(e));
    window.addEventListener('mouseup', (e) => this.mouseUp(e));
    c.addEventListener('auxclick', (e) => {
      if (e.button === 1 && e.detail === 2) this.zoomExtents();
    });
    c.addEventListener('mouseleave', () => {
      this.hover = null;
      this.snap = null;
      this.redraw();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === ' ' && document.activeElement === document.body) this.spaceDown = true;
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === ' ') this.spaceDown = false;
    });
  }

  private local(e: MouseEvent): P2 {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private mouseDown(e: MouseEvent) {
    const [px, py] = this.local(e);
    this.updateCursor(px, py);
    if ((e.button === 1 && e.shiftKey) || (e.button === 0 && this.orbitMode && !this.prompt && !this.hotGrip)) {
      // orbit: Shift + middle drag (AutoCAD), or left drag in orbit mode
      e.preventDefault();
      this.orbit = { x: px, y: py, dir: this.viewDirection };
      return;
    }
    if (e.button === 1 || e.button === 2 || (e.button === 0 && this.spaceDown)) {
      if (e.button === 2 && !this.pan) {
        // right click = Enter, like AutoCAD's default
        if (this.prompt) {
          if (this.prompt.kind === 'select') this.answer([...this.selection]);
          else this.answer(null);
        }
        return;
      }
      e.preventDefault();
      this.pan = { x: px, y: py, cx: this.view.cx, cy: this.view.cy };
      this.autoFit = false;
      return;
    }
    if (e.button !== 0) return;
    const p = this.prompt;
    if (p?.kind === 'entity') {
      const g = this.scene.pick(this.cam[0], this.cam[1], 5 / this.view.s);
      if (g && p.filter(g.rec)) this.answer({ rec: g.rec, p: this.effectiveCursor() });
      else this.log(g ? `${g.rec.type} can't be used here.` : 'Nothing found there.', 'warn');
      return;
    }
    if (p?.kind === 'point') {
      if (!this.cursorOk && !this.snap) {
        this.log('This view is edge-on to the XY plane: snap to an object or type coordinates.', 'warn');
        return;
      }
      this.answer(this.effectiveCursor());
      return;
    }
    if (this.hotGrip) {
      // click-click grip editing: second click places the grip
      this.finishGrip();
      return;
    }
    if (!p) {
      const tol = 6 / this.view.s;
      for (const g of this.gripList()) {
        const q = project(this.scene.rot, [g.grip.x, g.grip.y, g.grip.z]);
        if (Math.abs(q[0] - this.cam[0]) <= tol && Math.abs(q[1] - this.cam[1]) <= tol) {
          this.hotGrip = { rec: g.rec, grip: g.grip, startX: px, startY: py, moved: false };
          this.updateCursor(px, py);
          return;
        }
      }
    }
    if (this.box) {
      this.finishBox(e.shiftKey);
      return;
    }
    const hit = this.scene.pick(this.cam[0], this.cam[1], 5 / this.view.s);
    if (hit) {
      if (e.shiftKey) this.select([hit.rec], 'remove');
      else this.select([hit.rec], 'add');
      return;
    }
    this.box = { x0: px, y0: py, x1: px, y1: py, dragged: false };
  }

  private mouseMove(e: MouseEvent) {
    const [px, py] = this.local(e);
    if (this.orbit) {
      const k = 0.008;
      this.setViewDir(orbitDir(this.orbit.dir, -(px - this.orbit.x) * k, (py - this.orbit.y) * k));
    }
    if (this.pan) {
      this.view.cx = this.pan.cx - (px - this.pan.x) / this.view.s;
      this.view.cy = this.pan.cy + (py - this.pan.y) / this.view.s;
      this.redraw();
    }
    if (this.box) {
      this.box.x1 = px;
      this.box.y1 = py;
      if (Math.hypot(px - this.box.x0, py - this.box.y0) > 4) this.box.dragged = true;
    }
    if (this.hotGrip && Math.hypot(px - this.hotGrip.startX, py - this.hotGrip.startY) > 3) this.hotGrip.moved = true;
    if (e.target === this.canvas || this.pan || this.box || this.hotGrip) this.updateCursor(px, py);
  }

  private mouseUp(e: MouseEvent) {
    if (this.orbit) {
      this.orbit = null;
      return;
    }
    if (this.pan && (e.button === 1 || e.button === 2 || e.button === 0)) {
      this.pan = null;
      return;
    }
    if (this.box && this.box.dragged && e.button === 0) this.finishBox(e.shiftKey);
    if (this.hotGrip && this.hotGrip.moved && e.button === 0) this.finishGrip();
  }

  private finishGrip() {
    const hg = this.hotGrip!;
    this.hotGrip = null;
    if (!this.cursorOk && !this.snap) {
      this.log("This view is edge-on to the grip's plane: snap to an object instead.", 'warn');
      return this.redraw();
    }
    const [x, y] = this.effectiveCursor();
    this.snap = null;
    if (Math.hypot(x - hg.grip.x, y - hg.grip.y) < 1e-12) return this.redraw();
    const r = this.editor.grip(hg.rec, hg.grip, x, y);
    if (r.skipped.length) this.log(`${r.skipped.join(', ')} cannot be moved.`, 'warn');
  }

  private finishBox(shift: boolean) {
    const b = this.box!;
    this.box = null;
    const [ax, ay] = screenToWorld(this.view, b.x0, b.y0);
    const [bx, by] = screenToWorld(this.view, b.x1, b.y1);
    const crossing = b.x1 < b.x0;
    const found = this.scene.inRect([Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)], crossing);
    this.select(found.map((g) => g.rec), shift ? 'remove' : 'add');
    if (this.prompt?.kind === 'select') this.log(`${found.length} found`);
  }

  /** Press Escape: cancel grip/box/prompt/orbit mode, else clear selection. */
  escape() {
    if (this.orbitMode && !this.prompt) {
      this.orbitMode = false;
      this.emit(this.onView);
      this.log('Orbit mode off.');
      return;
    }
    if (this.hotGrip) {
      this.hotGrip = null;
      this.redraw();
      return;
    }
    if (this.box) {
      this.box = null;
      this.redraw();
      return;
    }
    if (this.prompt) {
      this.cancelPrompt();
      return;
    }
    this.clearSelection();
  }
}

/** A minimal AutoCAD 2018 drawing (layer 0, Standard styles, model/paper space). */
export const EMPTY_DXF = [
  '0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1032', '9', '$HANDSEED', '5', '100',
  '9', '$INSUNITS', '70', '4', '9', '$LTSCALE', '40', '1.0', '9', '$CLAYER', '8', '0', '0', 'ENDSEC',
  '0', 'SECTION', '2', 'TABLES',
  '0', 'TABLE', '2', 'VPORT', '5', '8', '330', '0', '100', 'AcDbSymbolTable', '70', '0', '0', 'ENDTAB',
  '0', 'TABLE', '2', 'LTYPE', '5', '5', '330', '0', '100', 'AcDbSymbolTable', '70', '3',
  '0', 'LTYPE', '5', '14', '330', '5', '100', 'AcDbSymbolTableRecord', '100', 'AcDbLinetypeTableRecord', '2', 'ByBlock', '70', '0', '3', '', '72', '65', '73', '0', '40', '0.0',
  '0', 'LTYPE', '5', '15', '330', '5', '100', 'AcDbSymbolTableRecord', '100', 'AcDbLinetypeTableRecord', '2', 'ByLayer', '70', '0', '3', '', '72', '65', '73', '0', '40', '0.0',
  '0', 'LTYPE', '5', '16', '330', '5', '100', 'AcDbSymbolTableRecord', '100', 'AcDbLinetypeTableRecord', '2', 'Continuous', '70', '0', '3', 'Solid line', '72', '65', '73', '0', '40', '0.0',
  '0', 'LTYPE', '5', '17', '330', '5', '100', 'AcDbSymbolTableRecord', '100', 'AcDbLinetypeTableRecord', '2', 'DASHED', '70', '0', '3', '__ __ __', '72', '65', '73', '2', '40', '0.75', '49', '0.5', '74', '0', '49', '-0.25', '74', '0',
  '0', 'ENDTAB',
  '0', 'TABLE', '2', 'LAYER', '5', '2', '330', '0', '100', 'AcDbSymbolTable', '70', '1',
  '0', 'LAYER', '5', '10', '330', '2', '100', 'AcDbSymbolTableRecord', '100', 'AcDbLayerTableRecord', '2', '0', '70', '0', '62', '7', '6', 'Continuous', '370', '-3', '390', 'F',
  '0', 'ENDTAB',
  '0', 'TABLE', '2', 'STYLE', '5', '3', '330', '0', '100', 'AcDbSymbolTable', '70', '1',
  '0', 'STYLE', '5', '11', '330', '3', '100', 'AcDbSymbolTableRecord', '100', 'AcDbTextStyleTableRecord', '2', 'Standard', '70', '0', '40', '0.0', '41', '1.0', '50', '0.0', '71', '0', '42', '2.5', '3', 'txt', '4', '',
  '0', 'ENDTAB',
  '0', 'TABLE', '2', 'VIEW', '5', '6', '330', '0', '100', 'AcDbSymbolTable', '70', '0', '0', 'ENDTAB',
  '0', 'TABLE', '2', 'UCS', '5', '7', '330', '0', '100', 'AcDbSymbolTable', '70', '0', '0', 'ENDTAB',
  '0', 'TABLE', '2', 'APPID', '5', '9', '330', '0', '100', 'AcDbSymbolTable', '70', '1',
  '0', 'APPID', '5', '12', '330', '9', '100', 'AcDbSymbolTableRecord', '100', 'AcDbRegAppTableRecord', '2', 'ACAD', '70', '0',
  '0', 'ENDTAB',
  '0', 'TABLE', '2', 'DIMSTYLE', '5', 'A', '330', '0', '100', 'AcDbSymbolTable', '70', '0', '100', 'AcDbDimStyleTable', '71', '0', '0', 'ENDTAB',
  '0', 'TABLE', '2', 'BLOCK_RECORD', '5', '1', '330', '0', '100', 'AcDbSymbolTable', '70', '2',
  '0', 'BLOCK_RECORD', '5', '1F', '330', '1', '100', 'AcDbSymbolTableRecord', '100', 'AcDbBlockTableRecord', '2', '*Model_Space', '340', '22',
  '0', 'BLOCK_RECORD', '5', '1B', '330', '1', '100', 'AcDbSymbolTableRecord', '100', 'AcDbBlockTableRecord', '2', '*Paper_Space', '340', '1E',
  '0', 'ENDTAB', '0', 'ENDSEC',
  '0', 'SECTION', '2', 'BLOCKS',
  '0', 'BLOCK', '5', '20', '330', '1F', '100', 'AcDbEntity', '8', '0', '100', 'AcDbBlockBegin', '2', '*Model_Space', '70', '0', '10', '0.0', '20', '0.0', '30', '0.0', '3', '*Model_Space', '1', '',
  '0', 'ENDBLK', '5', '21', '330', '1F', '100', 'AcDbEntity', '8', '0', '100', 'AcDbBlockEnd',
  '0', 'BLOCK', '5', '1C', '330', '1B', '100', 'AcDbEntity', '67', '1', '8', '0', '100', 'AcDbBlockBegin', '2', '*Paper_Space', '70', '0', '10', '0.0', '20', '0.0', '30', '0.0', '3', '*Paper_Space', '1', '',
  '0', 'ENDBLK', '5', '1D', '330', '1B', '100', 'AcDbEntity', '67', '1', '8', '0', '100', 'AcDbBlockEnd',
  '0', 'ENDSEC',
  '0', 'SECTION', '2', 'ENTITIES', '0', 'ENDSEC',
  '0', 'SECTION', '2', 'OBJECTS',
  '0', 'DICTIONARY', '5', 'C', '330', '0', '100', 'AcDbDictionary', '281', '1', '3', 'ACAD_GROUP', '350', 'D', '3', 'ACAD_LAYOUT', '350', '1A',
  '0', 'DICTIONARY', '5', 'D', '330', 'C', '100', 'AcDbDictionary', '281', '1',
  '0', 'DICTIONARY', '5', '1A', '330', 'C', '100', 'AcDbDictionary', '281', '1', '3', 'Model', '350', '22', '3', 'Layout1', '350', '1E',
  '0', 'LAYOUT', '5', '22', '330', '1A', '100', 'AcDbPlotSettings', '1', '', '4', '', '6', '', '40', '0.0', '41', '0.0', '42', '0.0', '43', '0.0', '44', '0.0', '45', '0.0', '46', '0.0', '47', '0.0', '48', '0.0', '49', '0.0', '140', '0.0', '141', '0.0', '142', '1.0', '143', '1.0', '70', '1712', '72', '0', '73', '0', '74', '0', '7', '', '75', '0', '147', '1.0', '148', '0.0', '149', '0.0', '100', 'AcDbLayout', '1', 'Model', '70', '1', '71', '0', '10', '0.0', '20', '0.0', '11', '420.0', '21', '297.0', '12', '0.0', '22', '0.0', '32', '0.0', '14', '0.0', '24', '0.0', '34', '0.0', '15', '0.0', '25', '0.0', '35', '0.0', '146', '0.0', '13', '0.0', '23', '0.0', '33', '0.0', '16', '1.0', '26', '0.0', '36', '0.0', '17', '0.0', '27', '1.0', '37', '0.0', '76', '0', '330', '1F',
  '0', 'LAYOUT', '5', '1E', '330', '1A', '100', 'AcDbPlotSettings', '1', '', '4', '', '6', '', '40', '0.0', '41', '0.0', '42', '0.0', '43', '0.0', '44', '0.0', '45', '0.0', '46', '0.0', '47', '0.0', '48', '0.0', '49', '0.0', '140', '0.0', '141', '0.0', '142', '1.0', '143', '1.0', '70', '688', '72', '0', '73', '0', '74', '0', '7', '', '75', '0', '147', '1.0', '148', '0.0', '149', '0.0', '100', 'AcDbLayout', '1', 'Layout1', '70', '1', '71', '1', '10', '0.0', '20', '0.0', '11', '420.0', '21', '297.0', '12', '0.0', '22', '0.0', '32', '0.0', '14', '0.0', '24', '0.0', '34', '0.0', '15', '0.0', '25', '0.0', '35', '0.0', '146', '0.0', '13', '0.0', '23', '0.0', '33', '0.0', '16', '1.0', '26', '0.0', '36', '0.0', '17', '0.0', '27', '1.0', '37', '0.0', '76', '0', '330', '1B',
  '0', 'ACDBPLACEHOLDER', '5', 'F', '330', 'C',
  '0', 'ENDSEC', '0', 'EOF',
].join('\n');
