import type { DxfRecord } from '../dxf/record';
import type { DxfDocument } from '../model/database';
import { aciColor, type Color, type Style } from './style';
import { ROMANS_FONT, romansWidth } from './romans';
import type { Vec3 } from '../dxf/record';
import type { Affine2, Frame3, Prim3 } from './prims';

/** Fraction of the CSS font size occupied by capital letters (DXF text height = cap height). */
export const CAP_HEIGHT = 0.7;

export interface TextMeasurer {
  /** Advance width of `text` for a cap height of 1. */
  width(text: string, font: string, bold: boolean, italic: boolean): number;
}

/** Fallback used outside the browser (tests): average glyph ~0.6 em. */
let measurer: TextMeasurer = { width: (t) => (t.length * 0.6) / CAP_HEIGHT };
export function setTextMeasurer(m: TextMeasurer): void {
  measurer = m;
}
export function measure(text: string, font: string, bold = false, italic = false): number {
  if (font === ROMANS_FONT) return romansWidth(text, (ch) => measurer.width(ch, SHX_FALLBACK, false, false));
  return measurer.width(text, font, bold, italic);
}

/**
 * When on, every text style draws in Roman Simplex (romans.shx), whatever font the drawing names
 * (including MTEXT  font switches).
 */
let forceRomans = true;
export function setForceRomans(v: boolean): void {
  forceRomans = v;
}
export function romansForced(): boolean {
  return forceRomans;
}

// ---- affine helpers ----------------------------------------------------------
export function amul(p: Affine2, q: Affine2): Affine2 {
  // p after q
  return [
    p[0] * q[0] + p[2] * q[1], p[1] * q[0] + p[3] * q[1],
    p[0] * q[2] + p[2] * q[3], p[1] * q[2] + p[3] * q[3],
    p[0] * q[4] + p[2] * q[5] + p[4], p[1] * q[4] + p[3] * q[5] + p[5],
  ];
}
export const atrans = (x: number, y: number): Affine2 => [1, 0, 0, 1, x, y];
export const arot = (r: number): Affine2 => [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
export const ascale = (sx: number, sy: number): Affine2 => [sx, 0, 0, sy, 0, 0];
export const ashear = (oblique: number): Affine2 => [1, 0, Math.tan(oblique), 1, 0, 0];

/** World frame after a local 2D affine: glyph (x, y) -> frame(a2(x, y)). */
export function composeFrame(f: Frame3, a2: Affine2): Frame3 {
  const [a, b, c, d, e, g] = a2;
  const lin = (s: number, t: number): Vec3 => [f.u[0] * s + f.v[0] * t, f.u[1] * s + f.v[1] * t, f.u[2] * s + f.v[2] * t];
  const off = lin(e, g);
  return { o: [f.o[0] + off[0], f.o[1] + off[1], f.o[2] + off[2]], u: lin(a, b), v: lin(c, d) };
}

export function frameApply(f: Frame3, x: number, y: number): Vec3 {
  return [f.o[0] + f.u[0] * x + f.v[0] * y, f.o[1] + f.u[1] * x + f.v[1] * y, f.o[2] + f.u[2] * x + f.v[2] * y];
}

// ---- fonts -------------------------------------------------------------------
export interface TextStyleInfo {
  font: string;
  bold: boolean;
  italic: boolean;
  widthFactor: number;
  oblique: number; // radians
  fixedHeight: number;
}

const FONT_ALIASES: Record<string, string> = {
  arial: 'Arial', arialn: 'Arial Narrow', times: 'Times New Roman', cour: 'Courier New',
  calibri: 'Calibri', verdana: 'Verdana', tahoma: 'Tahoma', segoeui: 'Segoe UI',
  consola: 'Consolas', simsun: 'SimSun', msgothic: 'MS Gothic', isocpeur: 'ISOCPEUR',
  opensans: 'Open Sans', 'opensans-regular': 'Open Sans',
};
export const SHX_FALLBACK = "'Segoe UI', Arial, Helvetica, sans-serif";

export function cssFamily(family: string): string {
  return `'${family.replace(/'/g, '')}', ${SHX_FALLBACK}`;
}

export function familyFromFile(file: string): string | null {
  const m = /([^\\/]+?)(\.(ttf|ttc|otf|shx))?$/i.exec(file.trim());
  if (!m || !m[1]) return null;
  const base = m[1].toLowerCase();
  if (FONT_ALIASES[base]) return FONT_ALIASES[base];
  if (m[3] && m[3].toLowerCase() !== 'shx') return m[1];
  return null; // SHX font: approximated
}

export class FontResolver {
  private cache = new Map<string, TextStyleInfo>();
  constructor(private doc: DxfDocument) {}
  reset() {
    this.cache.clear();
  }
  style(name: string): TextStyleInfo {
    const key = (name || 'STANDARD').toUpperCase();
    let s = this.cache.get(key);
    if (s) return s;
    const r = this.doc.tableEntry('STYLE', name || 'Standard');
    s = { font: SHX_FALLBACK, bold: false, italic: false, widthFactor: 1, oblique: 0, fixedHeight: 0 };
    if (r) {
      const xi = r.indexOf(1001);
      let family: string | null = null;
      if (xi >= 0) {
        const fi = r.indexOf(1000, xi);
        if (fi >= 0) family = r.groups[fi].value.trim() || null;
        const flags = Number(r.groups[r.indexOf(1071, xi)]?.value ?? 0);
        s.bold = (flags & 0x2000000) !== 0;
        s.italic = (flags & 0x1000000) !== 0;
      }
      family = family ?? familyFromFile(r.str(3));
      if (family) s.font = cssFamily(family);
      // romans.shx (and its relatives) are the stroke font we draw natively
      if (/^romans?(\.shx)?$/i.test(r.str(3))) s.font = ROMANS_FONT;
      s.widthFactor = r.num(41, 1) || 1;
      s.oblique = (r.num(50, 0) * Math.PI) / 180;
      s.fixedHeight = r.num(40, 0);
    }
    if (forceRomans) {
      s.font = ROMANS_FONT;
      s.bold = false; // single-stroke font: no bold/italic faces (oblique angle still applies)
      s.italic = false;
    }
    this.cache.set(key, s);
    return s;
  }
}

// ---- special codes -----------------------------------------------------------
/** Decode %%-codes and \U+XXXX escapes used in TEXT/ATTRIB values. */
export function decodeTextCodes(s: string): string {
  return s
    .replace(/\\U\+([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/%%(\d{3})/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/%%([cdpuok%])/gi, (_, c: string) => {
      switch (c.toLowerCase()) {
        case 'c': return '⌀';
        case 'd': return '°';
        case 'p': return '±';
        case '%': return '%';
        default: return ''; // %%u %%o %%k underline/overline/strike toggles
      }
    });
}

// ---- TEXT / ATTRIB / ATTDEF --------------------------------------------------
/**
 * Single-line text. `toWorld` maps the entity's OCS plane (x, y) at its elevation to world space.
 * Returns primitives with `m` mapping glyph space (baseline-left origin, cap height h) to world.
 */
export function layoutText(rec: DxfRecord, fonts: FontResolver, toWorld: Frame3, style: Style, override?: string): Prim3[] {
  const raw = override ?? rec.get(1) ?? '';
  const text = decodeTextCodes(raw);
  if (!text.trim()) return [];
  const ts = fonts.style(rec.str(7, 'Standard'));
  let h = rec.num(40, ts.fixedHeight || 1);
  if (h <= 0) h = ts.fixedHeight || 1;
  let wf = rec.num(41, ts.widthFactor) || 1;
  const oblique = rec.has(51) ? (rec.num(51, 0) * Math.PI) / 180 : ts.oblique;
  let rot = (rec.num(50, 0) * Math.PI) / 180;
  const gen = rec.num(71, 0);
  const hj = rec.num(72, 0);
  const vj = rec.num(rec.type === 'TEXT' ? 73 : 74, 0);
  let w = measure(text, ts.font, ts.bold, ts.italic) * h; // before width factor
  const p1 = rec.point(10);
  let origin = p1;
  if (hj !== 0 || vj !== 0) origin = rec.hasPoint(11) ? rec.point(11) : p1;

  let dx = 0;
  let dy = 0;
  if (hj === 3 || hj === 5) {
    // aligned / fit: baseline runs from 10 to 11
    const p2 = rec.point(11);
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    origin = p1;
    if (len > 1e-12) {
      rot = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
      if (hj === 3) {
        h = (len / (w / h)) / wf;
        w = len / wf;
      } else {
        wf = len / w;
      }
    }
  } else {
    if (hj === 1 || hj === 4) dx = -w * wf / 2;
    else if (hj === 2) dx = -w * wf;
    if (hj === 4 && vj === 0) dy = -h / 2;
    else if (vj === 1) dy = 0.3 * h;
    else if (vj === 2) dy = -h / 2;
    else if (vj === 3) dy = -h;
  }

  const mx = gen & 2 ? -1 : 1;
  const my = gen & 4 ? -1 : 1;
  // glyph -> OCS: T(origin) R(rot) Mirror T(dx,dy) Shear Scale(wf)
  let m = amul(atrans(origin[0], origin[1]), arot(rot));
  m = amul(m, ascale(mx, my));
  m = amul(m, atrans(dx, dy));
  m = amul(m, ashear(oblique));
  m = amul(m, ascale(wf, 1));
  return [{ k: 'text', f: composeFrame(toWorld, m), text, font: ts.font, bold: ts.bold, italic: ts.italic, h, w, style }];
}

// ---- MTEXT -------------------------------------------------------------------
interface RunState {
  h: number;
  color: Color | null;
  font: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  overline: boolean;
  strike: boolean;
  wf: number;
  oblique: number;
  tracking: number;
}

interface Run {
  text: string;
  st: RunState;
  /** \S stacking: top over bottom with a bar (/), diagonal (#) or tolerance style without bar (^). */
  stack?: { top: string; bot: string; kind: '/' | '#' | '^' };
}

/** Split MTEXT inline codes into paragraphs of styled runs. */
export function parseMText(src: string, base: RunState): Run[][] {
  const paras: Run[][] = [[]];
  const stack: RunState[] = [];
  let st: RunState = { ...base };
  let buf = '';
  const flush = () => {
    if (buf) paras[paras.length - 1].push({ text: buf, st: { ...st } });
    buf = '';
  };
  const s = decodeTextCodes(src.replace(/\^I/g, '    ').replace(/\^J/g, '\\P'));
  const readArg = (i: number): [string, number] => {
    const end = s.indexOf(';', i);
    return end < 0 ? [s.slice(i), s.length] : [s.slice(i, end), end + 1];
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '{') {
      flush();
      stack.push({ ...st });
      i++;
      continue;
    }
    if (c === '}') {
      flush();
      st = stack.pop() ?? { ...base };
      i++;
      continue;
    }
    if (c !== '\\' || i + 1 >= s.length) {
      buf += c;
      i++;
      continue;
    }
    const code = s[i + 1];
    i += 2;
    switch (code) {
      case 'P':
      case 'X':
      case 'N':
        flush();
        paras.push([]);
        break;
      case '~': buf += ' '; break;
      case '\\': case '{': case '}': buf += code; break;
      case 'L': flush(); st.underline = true; break;
      case 'l': flush(); st.underline = false; break;
      case 'O': flush(); st.overline = true; break;
      case 'o': flush(); st.overline = false; break;
      case 'K': flush(); st.strike = true; break;
      case 'k': flush(); st.strike = false; break;
      case 'H': {
        const [a, n] = readArg(i);
        i = n;
        flush();
        const v = parseFloat(a);
        if (Number.isFinite(v) && v > 0) st.h = /x$/i.test(a.trim()) ? st.h * v : v;
        break;
      }
      case 'W': { const [a, n] = readArg(i); i = n; flush(); const v = parseFloat(a); if (v > 0) st.wf = /x$/i.test(a) ? st.wf * v : v; break; }
      case 'Q': { const [a, n] = readArg(i); i = n; flush(); st.oblique = (parseFloat(a) || 0) * Math.PI / 180; break; }
      case 'T': { const [a, n] = readArg(i); i = n; flush(); st.tracking = parseFloat(a) || 1; break; }
      case 'C': { const [a, n] = readArg(i); i = n; flush(); const v = parseInt(a, 10); st.color = v === 256 ? null : v === 0 ? null : aciColor(v); break; }
      case 'c': { const [a, n] = readArg(i); i = n; flush(); const v = parseInt(a, 10); st.color = Number.isFinite(v) ? (((v & 0xff) << 16) | (v & 0xff00) | ((v >> 16) & 0xff)) : null; break; }
      case 'f':
      case 'F': {
        const [a, n] = readArg(i);
        i = n;
        flush();
        const parts = a.split('|');
        const fam = code === 'f' ? parts[0] : familyFromFile(parts[0]);
        if (fam && !forceRomans) st.font = cssFamily(fam);
        for (const p of parts.slice(1)) {
          if (/^b1/i.test(p)) st.bold = true;
          else if (/^b0/i.test(p)) st.bold = false;
          else if (/^i1/i.test(p)) st.italic = true;
          else if (/^i0/i.test(p)) st.italic = false;
        }
        break;
      }
      case 'S': {
        // stacked text: a/b (bar), a#b (diagonal), a^b (tolerance, no bar)
        const [a, n] = readArg(i);
        i = n;
        const m = /^(.*?)([/#^])(.*)$/.exec(a.replace(/\\;/g, ';'));
        flush();
        if (m) paras[paras.length - 1].push({ text: '\u0001', st: { ...st }, stack: { top: m[1], bot: m[3], kind: m[2] as '/' | '#' | '^' } });
        else buf += a;
        break;
      }
      case 'A': case 'p': case 'q': {
        const [, n] = readArg(i); // alignment / paragraph properties: ignored
        i = n;
        break;
      }
      case 'U': {
        // \U+XXXX already decoded; keep literal otherwise
        buf += '\\U';
        break;
      }
      default:
        buf += code;
    }
  }
  flush();
  return paras;
}

/**
 * Lay out MTEXT: word wrap to the reference width (41), apply line spacing (44)
 * and the attachment point (71). `frame` maps the text's local frame (origin at the
 * insertion point, x along the text direction) to world space.
 */
export function layoutMText(rec: DxfRecord, fonts: FontResolver, frame: Frame3, style: Style): Prim3[] {
  const text = rec.all(3).join('') + (rec.get(1) ?? '');
  if (!text) return [];
  const ts = fonts.style(rec.str(7, 'Standard'));
  const h0 = rec.num(40, 0) || ts.fixedHeight || 1;
  const base: RunState = {
    h: h0, color: null, font: ts.font, bold: ts.bold, italic: ts.italic,
    underline: false, overline: false, strike: false, wf: ts.widthFactor, oblique: ts.oblique, tracking: 1,
  };
  const wrapW = rec.num(41, 0);
  const spacing = rec.num(44, 1) || 1;
  const attach = rec.num(71, 1);

  type Placed = { text: string; st: RunState; x: number; w: number; stack?: Run['stack'] };
  /** Stacked parts are 70 % of the run height. */
  const stackW = (r: Run) => {
    const k = r.stack!, sh = r.st.h * 0.7;
    const wt = measure(k.top, r.st.font) * sh, wb = measure(k.bot, r.st.font) * sh;
    return k.kind === '#' ? wt + 0.4 * r.st.h + wb : Math.max(wt, wb) + 0.1 * r.st.h;
  };
  type Line = { runs: Placed[]; width: number; h: number };
  const lines: Line[] = [];
  const runW = (t: string, st: RunState) => measure(t, st.font, st.bold, st.italic) * st.h * st.wf * st.tracking;

  for (const para of parseMText(text, base)) {
    let line: Line = { runs: [], width: 0, h: 0 };
    const newLine = () => {
      if (!line.h) line.h = para[0]?.st.h ?? h0;
      lines.push(line);
      line = { runs: [], width: 0, h: 0 };
    };
    for (const run of para) {
      if (run.stack) {
        const ww = stackW(run);
        if (wrapW > 0 && line.runs.length && line.width + ww > wrapW * 1.0001) newLine();
        line.runs.push({ text: '', st: run.st, x: line.width, w: ww, stack: run.stack });
        line.width += ww;
        line.h = Math.max(line.h, run.st.h);
        continue;
      }
      // split into words, keeping whitespace attached so widths are additive
      const words = run.text.match(/\S+\s*|\s+/g) ?? [];
      for (const word of words) {
        const ww = runW(word, run.st);
        const trimmedW = runW(word.trimEnd(), run.st);
        if (wrapW > 0 && line.runs.length && line.width + trimmedW > wrapW * 1.0001) newLine();
        const last = line.runs[line.runs.length - 1];
        if (last && last.st === run.st) {
          last.text += word;
          last.w += ww;
        } else line.runs.push({ text: word, st: run.st, x: line.width, w: ww });
        line.width += ww;
        line.h = Math.max(line.h, run.st.h);
      }
    }
    newLine();
  }

  // vertical metrics: AutoCAD's default line pitch is 5/3 of the text height
  const pitch = (l: Line) => l.h * (5 / 3) * spacing;
  let total = lines[0]?.h ?? h0;
  for (let i = 1; i < lines.length; i++) total += pitch(lines[i]);
  const col = (attach - 1) % 3; // 0 left, 1 center, 2 right
  const row = Math.floor((attach - 1) / 3); // 0 top, 1 middle, 2 bottom
  let y = row === 0 ? 0 : row === 1 ? total / 2 : total;

  const out: Prim3[] = [];
  // background mask (90: 1 = use colour 63, 2/3 = drawing background; 45 = border scale)
  const mask = rec.num(90, 0);
  if (mask & 3 && lines.length) {
    const W = Math.max(...lines.map((l) => l.width));
    const left = col === 0 ? 0 : col === 1 ? -W / 2 : -W;
    const top = row === 0 ? 0 : row === 1 ? total / 2 : total;
    const m = ((rec.num(45, 1.5) || 1.5) - 1) * h0 * 0.5 + h0 * 0.1;
    const corners = [[left - m, top + m], [left + W + m, top + m], [left + W + m, top - total - 0.3 * h0 - m], [left - m, top - total - 0.3 * h0 - m]];
    const ring = corners.flatMap(([x, yy]) => frameApply(frame, x, yy));
    const bg = (mask & 2) !== 0;
    out.push({ k: 'fill', rings: [ring], style: bg ? style : { ...style, color: aciColor(rec.num(63, 7)) }, bg });
  }
  lines.forEach((l, li) => {
    y -= li === 0 ? l.h : pitch(l);
    const lw = l.runs.length ? l.width - (runW(l.runs[l.runs.length - 1].text, l.runs[l.runs.length - 1].st) - runW(l.runs[l.runs.length - 1].text.trimEnd(), l.runs[l.runs.length - 1].st)) : 0;
    const x0 = col === 0 ? 0 : col === 1 ? -lw / 2 : -lw;
    for (const r of l.runs) {
      if (r.stack) {
        // stacked fraction / tolerance: two smaller parts above and below the middle
        const st: Style = r.st.color === null ? style : { ...style, color: r.st.color };
        const k = r.stack, sh = r.st.h * 0.7, hh = r.st.h;
        const x = x0 + r.x;
        const wt = measure(k.top, r.st.font) * sh, wb = measure(k.bot, r.st.font) * sh;
        const part = (txt: string, px: number, py: number, w: number) => {
          if (!txt) return;
          out.push({ k: 'text', f: composeFrame(frame, atrans(px, py)), text: txt, font: r.st.font, bold: r.st.bold, italic: r.st.italic, h: sh, w, style: st });
        };
        if (k.kind === '#') {
          part(k.top, x, y + 0.45 * hh, wt);
          out.push({ k: 'line', pts: [...frameApply(frame, x + wt + 0.05 * hh, y - 0.15 * hh), ...frameApply(frame, x + wt + 0.35 * hh, y + hh * 1.05)], closed: false, style: { ...st, linetype: null } });
          part(k.bot, x + wt + 0.4 * hh, y - 0.15 * hh, wb);
        } else {
          const W = Math.max(wt, wb);
          part(k.top, x + (W - wt) / 2 + 0.05 * hh, y + 0.55 * hh, wt);
          part(k.bot, x + (W - wb) / 2 + 0.05 * hh, y - 0.3 * hh, wb);
          if (k.kind === '/') out.push({ k: 'line', pts: [...frameApply(frame, x, y + 0.42 * hh), ...frameApply(frame, x + W + 0.1 * hh, y + 0.42 * hh)], closed: false, style: { ...st, linetype: null } });
        }
        continue;
      }
      const t = r.text.replace(/\s+$/, (m) => (r === l.runs[l.runs.length - 1] ? '' : m));
      if (!t) continue;
      const st: Style = r.st.color === null ? style : { ...style, color: r.st.color };
      const local = amul(atrans(x0 + r.x, y), amul(ashear(r.st.oblique), ascale(r.st.wf * r.st.tracking, 1)));
      const f = composeFrame(frame, local);
      const w = measure(t, r.st.font, r.st.bold, r.st.italic) * r.st.h;
      out.push({ k: 'text', f, text: t, font: r.st.font, bold: r.st.bold, italic: r.st.italic, h: r.st.h, w, style: st });
      const deco = (yy: number) => {
        out.push({ k: 'line', pts: [...frameApply(f, 0, yy), ...frameApply(f, w, yy)], closed: false, style: { ...st, linetype: null } });
      };
      if (r.st.underline) deco(-0.2 * r.st.h);
      if (r.st.overline) deco(1.2 * r.st.h);
      if (r.st.strike) deco(0.5 * r.st.h);
    }
  });
  return out;
}
