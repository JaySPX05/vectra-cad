import { ROMANS_GLYPHS, type StrokeGlyph } from './romans-glyphs';

/**
 * Roman Simplex (AutoCAD's romans.shx): a single-stroke vector font. Text using this
 * "family" is drawn as line strokes instead of with a browser font.
 */
export const ROMANS_FONT = 'romans';

function circle(cx: number, cy: number, r: number, n = 16): number[] {
  const pts: number[] = [];
  for (let i = 0; i <= n; i++) pts.push(+(cx + r * Math.cos((i / n) * Math.PI * 2)).toFixed(4), +(cy + r * Math.sin((i / n) * Math.PI * 2)).toFixed(4));
  return pts;
}

/** Symbols AutoCAD's %%d / %%p / %%c produce, in the same stroke style. */
const EXTRA: Record<string, StrokeGlyph> = {
  '°': ROMANS_GLYPHS[95], // Hershey 718: degree sign
  '±': { a: 0.857, s: [[0.429, 0.857, 0.429, 0.286], [0.143, 0.571, 0.714, 0.571], [0.143, 0.095, 0.714, 0.095]] },
  '⌀': { a: 1.0, s: [circle(0.5, 0.476, 0.333), [0.143, 0.048, 0.857, 0.905]] },
};
EXTRA['Ø'] = EXTRA['⌀'];
EXTRA[' '] = ROMANS_GLYPHS[0];
EXTRA['\t'] = { a: ROMANS_GLYPHS[0].a * 4, s: [] };

export function romansGlyph(ch: string): StrokeGlyph | null {
  const c = ch.charCodeAt(0);
  if (ch.length === 1 && c >= 32 && c <= 126) return ROMANS_GLYPHS[c - 32];
  return EXTRA[ch] ?? null;
}

/**
 * Width of `text` at cap height 1. Characters the font lacks (e.g. accented or CJK letters)
 * are measured by `fallback`, and drawn with a system font by the renderer.
 */
export function romansWidth(text: string, fallback: (s: string) => number): number {
  let w = 0;
  for (const ch of text) {
    const g = romansGlyph(ch);
    w += g ? g.a : fallback(ch);
  }
  return w;
}
