import type { DxfRecord } from '../dxf/record';
import type { Scene } from './scene';
import type { EntityGeom, PatternLine, Prim } from './prims';
import type { Color, Style } from './style';
import { rgbToCss } from '../model/aci';
import { CAP_HEIGHT, measure, SHX_FALLBACK } from './text';
import { ROMANS_FONT, romansGlyph } from './romans';

export interface View {
  cx: number; // world point at the canvas centre
  cy: number;
  s: number; // pixels per drawing unit
  w: number; // canvas size in CSS pixels
  h: number;
}

export type VisualStyle = 'wireframe' | 'hidden' | 'shaded' | 'shadedEdges';

export interface RenderOptions {
  dark: boolean;
  lineweights: boolean;
  selection: Set<DxfRecord>;
  hover: DxfRecord | null;
  /** How 3D faces are drawn; non-wireframe styles draw everything back to front. */
  visualStyle?: VisualStyle;
}

export function worldToScreen(v: View, x: number, y: number): [number, number] {
  return [(x - v.cx) * v.s + v.w / 2, v.h / 2 - (y - v.cy) * v.s];
}
export function screenToWorld(v: View, px: number, py: number): [number, number] {
  return [(px - v.w / 2) / v.s + v.cx, (v.h / 2 - py) / v.s + v.cy];
}
export function viewBox(v: View): [number, number, number, number] {
  const [x0, y1] = screenToWorld(v, 0, 0);
  const [x1, y0] = screenToWorld(v, v.w, v.h);
  return [x0, y0, x1, y1];
}

/** Fit the view to a world box with a margin. */
export function fitView(v: View, b: [number, number, number, number] | null): View {
  if (!b) return { ...v, cx: 0, cy: 0, s: 1 };
  const bw = Math.max(b[2] - b[0], 1e-9), bh = Math.max(b[3] - b[1], 1e-9);
  const s = Math.min(v.w / bw, v.h / bh) * 0.92;
  return { ...v, cx: (b[0] + b[2]) / 2, cy: (b[1] + b[3]) / 2, s: Number.isFinite(s) && s > 0 ? s : 1 };
}

const MM_TO_PX = 96 / 25.4;

/** Convert a DXF linetype pattern to a canvas dash array + offset (in pixels). */
export function dashArray(pattern: number[], unitPx: number): { dash: number[]; offset: number } | null {
  const segs: [boolean, number][] = [];
  for (const v of pattern) {
    const on = v >= 0;
    const len = v === 0 ? 1 : Math.abs(v) * unitPx; // dots render as 1px dashes
    if (segs.length && segs[segs.length - 1][0] === on) segs[segs.length - 1][1] += len;
    else segs.push([on, len]);
  }
  if (!segs.some((s) => s[0])) return null;
  // `offset` = position inside the cyclic dash array where the line starts.
  let offset = 0;
  if (segs.length > 1 && segs[0][0] === segs[segs.length - 1][0]) {
    // the pattern's tail and head are the same kind: merge them (cyclically adjacent)
    const last = segs.pop()!;
    segs[0][1] += last[1];
    offset = last[1];
  }
  if (!segs[0][0]) {
    // canvas arrays must start with a dash: rotate the leading gap to the end
    const gap = segs.shift()!;
    offset += segs.reduce((a, s) => a + s[1], 0);
    segs.push(gap);
  }
  return validate(segs.map((s) => s[1]), offset);
}

function validate(arr: number[], offset: number) {
  const total = arr.reduce((a, b) => a + b, 0);
  if (arr.length < 2 || total < 3) return null; // too dense to show: draw continuous
  if (arr.length % 2) arr.push(0);
  return { dash: arr, offset: offset % total };
}

export class Renderer {
  readonly ctx: CanvasRenderingContext2D;
  constructor(public canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  private fg = '#ffffff';
  private bg = '#212830';
  private get dark(): boolean {
    return this.bg !== '#ffffff';
  }

  /**
   * Roman Simplex text as line strokes. `t` maps glyph space (x right, y up, units) to screen;
   * characters the stroke font lacks fall back to a system font at the same size.
   */
  private strokeText(text: string, h: number, t: number[], k: number, color: string) {
    const ctx = this.ctx;
    const [ta, tb, tc, td, te, tf] = t;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.min(3, Math.max(1, (h * k) / 25));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([]);
    ctx.beginPath();
    let x = 0;
    const fallback: [string, number][] = [];
    for (const ch of text) {
      const g = romansGlyph(ch);
      if (!g) {
        fallback.push([ch, x]);
        x += measure(ch, ROMANS_FONT) * h;
        continue;
      }
      for (const st of g.s) {
        for (let i = 0; i < st.length; i += 2) {
          const gx = x + st[i] * h, gy = st[i + 1] * h;
          const sx = ta * gx + tc * gy + te, sy = tb * gx + td * gy + tf;
          if (i === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        }
      }
      x += g.a * h;
    }
    ctx.stroke();
    if (fallback.length) {
      ctx.transform(ta / k, tb / k, -tc / k, -td / k, te, tf);
      ctx.font = `${(h * k) / CAP_HEIGHT}px ${SHX_FALLBACK}`;
      ctx.textBaseline = 'alphabetic';
      for (const [ch, cx] of fallback) ctx.fillText(ch, cx * k, 0);
    }
    ctx.restore();
  }

  /** XYZ axis triad in the lower-left corner, showing the current view orientation. */
  drawTriad(rot: number[], v: View): void {
    const ctx = this.ctx;
    const cx = 44, cy = v.h - 44, len = 26;
    const axes: [string, string, number][] = [['X', '#e5484d', 0], ['Y', '#46a758', 1], ['Z', '#3e8ef7', 2]];
    // draw the axis pointing away from the viewer first
    axes.sort((a, b) => rot[8 + a[2]] - rot[8 + b[2]]);
    ctx.save();
    ctx.setLineDash([]);
    ctx.lineWidth = 2;
    ctx.font = 'bold 11px system-ui, sans-serif';
    for (const [label, color, i] of axes) {
      const x = rot[i], y = rot[4 + i];
      if (Math.hypot(x, y) < 0.05) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(cx, cy, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillText(label, cx + 6, cy - 6);
        continue;
      }
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + x * len, cy - y * len);
      ctx.stroke();
      ctx.fillText(label, cx + x * (len + 8) - 4, cy - y * (len + 8) + 4);
    }
    ctx.restore();
  }

  css(c: Color): string {
    return c === 'fg' ? this.fg : rgbToCss(c);
  }

  draw(scene: Scene, v: View, o: RenderOptions): void {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    this.bg = o.dark ? '#212830' : '#ffffff';
    this.fg = o.dark ? '#ffffff' : '#000000';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = this.bg;
    ctx.fillRect(0, 0, v.w, v.h);
    const vb = viewBox(v);
    const pad = 2 / v.s;
    const visible = (b: [number, number, number, number] | null, n: number) =>
      (!b && n > 0) || (!!b && !(b[2] < vb[0] - pad || b[0] > vb[2] + pad || b[3] < vb[1] - pad || b[1] > vb[3] + pad));
    if ((o.visualStyle ?? 'wireframe') === 'wireframe') {
      for (const g of scene.items) if (visible(g.bbox, g.prims.length)) this.drawGeom(g, v, o, dpr, null);
    } else {
      // painter's algorithm: every primitive, farthest first
      for (const { g, p } of scene.depthOrder()) if (visible(g.bbox, g.prims.length)) this.drawPrim(p, v, o, dpr, null);
    }
    for (const g of scene.items) {
      if (o.selection.has(g.rec)) this.drawGeom(g, v, o, dpr, 'select');
      else if (o.hover === g.rec) this.drawGeom(g, v, o, dpr, 'hover');
    }
  }

  /** Draw transient primitives (command previews) in the given colour mode. */
  drawPrims(prims: Prim[], v: View, o: RenderOptions, mode: 'select' | 'hover' | null = null): void {
    const dpr = window.devicePixelRatio || 1;
    for (const p of prims) this.drawPrim(p, v, o, dpr, mode);
  }

  drawGeom(g: EntityGeom, v: View, o: RenderOptions, dpr: number, mode: 'select' | 'hover' | null): void {
    for (const p of g.prims) this.drawPrim(p, v, o, dpr, mode);
  }

  private setStroke(st: Style, v: View, o: RenderOptions, mode: 'select' | 'hover' | null, worldWidth?: number, along = 0) {
    const ctx = this.ctx;
    let lw = 1;
    if (worldWidth !== undefined) lw = Math.max(1, worldWidth * v.s);
    else if (o.lineweights) lw = Math.max(1, st.lineweight * MM_TO_PX);
    if (mode === 'hover') lw += 2;
    ctx.lineWidth = lw;
    ctx.strokeStyle = mode === 'select' ? '#3d9eff' : this.css(st.color);
    ctx.lineCap = worldWidth ? 'butt' : 'round';
    ctx.lineJoin = 'round';
    if (mode === 'select') {
      ctx.setLineDash([6, 4]);
      ctx.lineDashOffset = 0;
      return;
    }
    if (st.linetype) {
      const d = dashArray(st.linetype.pattern, st.ltScale * v.s);
      if (d) {
        ctx.setLineDash(d.dash);
        ctx.lineDashOffset = d.offset + along;
        return;
      }
    }
    ctx.setLineDash([]);
  }

  private drawPrim(p: Prim, v: View, o: RenderOptions, _dpr: number, mode: 'select' | 'hover' | null): void {
    const ctx = this.ctx;
    const s = v.s, ox = v.w / 2 - v.cx * s, oy = v.h / 2 + v.cy * s;
    switch (p.k) {
      case 'line': {
        this.setStroke(p.style, v, o, mode, p.width);
        ctx.beginPath();
        const pts = p.pts;
        ctx.moveTo(pts[0] * s + ox, oy - pts[1] * s);
        for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i] * s + ox, oy - pts[i + 1] * s);
        if (p.closed) ctx.closePath();
        if (pts.length === 2) ctx.lineTo(pts[0] * s + ox + 0.01, oy - pts[1] * s);
        ctx.stroke();
        break;
      }
      case 'fill': {
        ctx.beginPath();
        for (const r of p.rings) {
          ctx.moveTo(r[0] * s + ox, oy - r[1] * s);
          for (let i = 2; i < r.length; i += 2) ctx.lineTo(r[i] * s + ox, oy - r[i + 1] * s);
          ctx.closePath();
        }
        if (mode) {
          this.setStroke(p.style, v, o, mode);
          ctx.stroke();
          break;
        }
        ctx.globalAlpha = p.alpha ?? 1;
        ctx.fillStyle = p.bg ? this.bg : this.css(p.style.color);
        if (p.gradient) {
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (const r of p.rings) for (let i = 0; i < r.length; i += 2) {
            x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]); y0 = Math.min(y0, r[i + 1]); y1 = Math.max(y1, r[i + 1]);
          }
          const cx = ((x0 + x1) / 2) * s + ox, cy = oy - ((y0 + y1) / 2) * s;
          const half = (Math.hypot(x1 - x0, y1 - y0) / 2) * s;
          const dx = Math.cos(p.gradient.angle) * half, dy = -Math.sin(p.gradient.angle) * half;
          const g = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
          g.addColorStop(0, rgbToCss(p.gradient.colors[0]));
          g.addColorStop(1, rgbToCss(p.gradient.colors[1]));
          ctx.fillStyle = g;
        }
        ctx.fill('evenodd');
        ctx.globalAlpha = 1;
        break;
      }
      case 'pattern':
        this.drawPattern(p.rings, p.lines, p.style, v, o, mode);
        break;
      case 'text': {
        const [a, b, c, d, e, f] = p.m;
        // T = view * m; glyph space is y-up, canvas is y-down
        const ta = a * s, tb = -b * s, tc = c * s, td = -d * s, te = e * s + ox, tf = oy - f * s;
        const k = Math.hypot(tc, td); // px per glyph unit (vertical)
        const px = p.h * k;
        if (px < 1.2) {
          // too small to read: draw its baseline like AutoCAD's text "greeking"
          ctx.strokeStyle = mode === 'select' ? '#3d9eff' : this.css(p.style.color);
          ctx.lineWidth = 1;
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(te, tf);
          ctx.lineTo(te + ta * p.w, tf + tb * p.w);
          ctx.stroke();
          break;
        }
        if (p.font === ROMANS_FONT) {
          this.strokeText(p.text, p.h, [ta, tb, tc, td, te, tf], k, mode === 'select' ? '#3d9eff' : this.css(p.style.color));
          break;
        }
        ctx.save();
        ctx.transform(ta / k, tb / k, -tc / k, -td / k, te, tf);
        ctx.font = `${p.italic ? 'italic ' : ''}${p.bold ? 'bold ' : ''}${px / CAP_HEIGHT}px ${p.font}`;
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';
        ctx.fillStyle = mode === 'select' ? '#3d9eff' : this.css(p.style.color);
        ctx.fillText(p.text, 0, 0);
        if (mode) {
          ctx.strokeStyle = '#3d9eff';
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.strokeRect(0, -px, p.w * k, px * 1.3);
        }
        ctx.restore();
        break;
      }
      case 'face': {
        const style = o.visualStyle ?? 'wireframe';
        const n = p.pts.length / 2;
        const sx = (i: number) => p.pts[i * 2] * s + ox, sy = (i: number) => oy - p.pts[i * 2 + 1] * s;
        if (!mode && style !== 'wireframe') {
          ctx.beginPath();
          ctx.moveTo(sx(0), sy(0));
          for (let i = 1; i < n; i++) ctx.lineTo(sx(i), sy(i));
          ctx.closePath();
          if (style === 'hidden') ctx.fillStyle = this.bg;
          else {
            const base = p.style.color === 'fg' ? (this.fg === '#ffffff' ? 0xd8d8d8 : 0x9a9a9a) : p.style.color;
            const k = 0.35 + 0.65 * p.shade;
            const ch = (c: number) => Math.round(Math.min(255, c * k));
            ctx.fillStyle = `rgb(${ch((base >> 16) & 255)},${ch((base >> 8) & 255)},${ch(base & 255)})`;
          }
          ctx.fill();
          // hairline in the fill colour hides anti-aliasing seams between neighbouring faces
          ctx.strokeStyle = ctx.fillStyle;
          ctx.lineWidth = 1;
          ctx.setLineDash([]);
          ctx.stroke();
          if (style === 'shaded') break;
        }
        // visible edges (wireframe, hidden, shaded with edges, highlight)
        this.setStroke(p.style, v, o, mode);
        if (style === 'shadedEdges' && !mode) ctx.strokeStyle = this.dark ? '#111' : '#222';
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          if (!(p.edges & (1 << i)) && !mode) continue;
          const j = (i + 1) % n;
          ctx.moveTo(sx(i), sy(i));
          ctx.lineTo(sx(j), sy(j));
        }
        ctx.stroke();
        break;
      }
      case 'point': {
        const x = p.x * s + ox, y = oy - p.y * s;
        ctx.fillStyle = mode === 'select' ? '#3d9eff' : this.css(p.style.color);
        const r = mode ? 3 : 1.5;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
        break;
      }
      case 'xline': {
        this.setStroke(p.style, v, o, mode);
        const x = p.x * s + ox, y = oy - p.y * s;
        const l = Math.hypot(p.dx, p.dy) || 1;
        const big = (v.w + v.h) * 4;
        const dx = (p.dx / l) * big, dy = (-p.dy / l) * big;
        ctx.beginPath();
        ctx.moveTo(p.ray ? x : x - dx, p.ray ? y : y - dy);
        ctx.lineTo(x + dx, y + dy);
        ctx.stroke();
        break;
      }
    }
  }

  private drawPattern(rings: number[][], lines: PatternLine[], st: Style, v: View, o: RenderOptions, mode: 'select' | 'hover' | null) {
    const ctx = this.ctx;
    const s = v.s, ox = v.w / 2 - v.cx * s, oy = v.h / 2 + v.cy * s;
    const path = new Path2D();
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const r of rings) {
      path.moveTo(r[0] * s + ox, oy - r[1] * s);
      for (let i = 0; i < r.length; i += 2) {
        if (i) path.lineTo(r[i] * s + ox, oy - r[i + 1] * s);
        minx = Math.min(minx, r[i]); maxx = Math.max(maxx, r[i]);
        miny = Math.min(miny, r[i + 1]); maxy = Math.max(maxy, r[i + 1]);
      }
      path.closePath();
    }
    if (mode) {
      this.setStroke(st, v, o, mode);
      ctx.stroke(path);
      return;
    }
    // clip to the visible part of the boundary
    const vb = viewBox(v);
    minx = Math.max(minx, vb[0]); miny = Math.max(miny, vb[1]);
    maxx = Math.min(maxx, vb[2]); maxy = Math.min(maxy, vb[3]);
    if (minx > maxx || miny > maxy) return;
    ctx.save();
    ctx.clip(path, 'evenodd');
    ctx.strokeStyle = this.css(st.color);
    ctx.lineWidth = o.lineweights ? Math.max(1, st.lineweight * MM_TO_PX) : 1;
    ctx.lineCap = 'butt';
    const corners = [[minx, miny], [maxx, miny], [maxx, maxy], [minx, maxy]];
    for (const L of lines) {
      const ul = Math.hypot(L.ux, L.uy);
      if (!ul) continue;
      const ux = L.ux / ul, uy = L.uy / ul, nx = -uy, ny = ux;
      const step = L.vx * nx + L.vy * ny; // perpendicular spacing per offset
      if (Math.abs(step) * s < 1.5) {
        // denser than the screen can show
        ctx.globalAlpha = 0.35;
        ctx.fillStyle = this.css(st.color);
        ctx.fill(path, 'evenodd');
        ctx.globalAlpha = 1;
        break;
      }
      const ds = corners.map(([x, y]) => (x - L.ox) * nx + (y - L.oy) * ny);
      let k0 = Math.floor(Math.min(...ds) / step), k1 = Math.ceil(Math.max(...ds) / step);
      if (k0 > k1) [k0, k1] = [k1, k0];
      if (k1 - k0 > 4000) continue;
      const patLen = L.dashes.reduce((a, d) => a + Math.abs(d), 0) * ul;
      const dash = L.dashes.length >= 2 ? dashArray(L.dashes, ul * s) : null;
      ctx.setLineDash(dash ? dash.dash : []);
      ctx.lineDashOffset = dash ? dash.offset : 0;
      ctx.beginPath();
      for (let k = k0; k <= k1; k++) {
        const px = L.ox + k * L.vx, py = L.oy + k * L.vy;
        const ts = corners.map(([x, y]) => (x - px) * ux + (y - py) * uy);
        let t0 = Math.min(...ts);
        const t1 = Math.max(...ts);
        if (dash && patLen > 0) t0 = Math.floor(t0 / patLen) * patLen; // keep the dash phase anchored
        ctx.moveTo((px + ux * t0) * s + ox, oy - (py + uy * t0) * s);
        ctx.lineTo((px + ux * t1) * s + ox, oy - (py + uy * t1) * s);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
}
