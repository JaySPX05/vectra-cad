// AutoCAD Color Index (ACI). 1-9 are fixed colors; 10-249 are 24 hues x 10 shades
// (even index = full saturation, odd = half; brightness 100/80/60/50/30%); 250-255 are greys.

function buildAci(): number[] {
  const t = new Array<number>(256).fill(0);
  const fixed = [0x000000, 0xff0000, 0xffff00, 0x00ff00, 0x00ffff, 0x0000ff, 0xff00ff, 0xffffff, 0x808080, 0xc0c0c0];
  for (let i = 0; i < 10; i++) t[i] = fixed[i];
  const shades = [1.0, 0.8, 0.6, 0.5, 0.3];
  for (let i = 10; i < 250; i++) {
    const hue = Math.floor((i - 10) / 10) * 15;
    const k = (i - 10) % 10;
    const [r, g, b] = hsvToRgb(hue, 1, 1);
    const pastel = k % 2 === 1;
    const v = shades[k >> 1];
    // pastel = halfway to white; floor matches the published table (e.g. 20 = #FF3F00, 13 = #CC6666)
    const ch = (c: number) => Math.floor((pastel ? 127.5 + c / 2 : c) * v + 1e-9);
    t[i] = (ch(r) << 16) | (ch(g) << 8) | ch(b);
  }
  const greys = [0x33, 0x50, 0x69, 0x82, 0xbe, 0xff];
  for (let i = 0; i < 6; i++) t[250 + i] = greys[i] * 0x010101;
  return t;
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5) * 255, f(3) * 255, f(1) * 255];
}

export const ACI_RGB = buildAci();

export const ACI_BYBLOCK = 0;
export const ACI_BYLAYER = 256;

export function rgbToCss(rgb: number): string {
  return '#' + (rgb & 0xffffff).toString(16).padStart(6, '0');
}

/** CSS background for a swatch; ACI 7 is drawn black/white since it follows the background. */
export function aciSwatchCss(aci: number): string {
  return Math.abs(aci) === 7 ? 'linear-gradient(135deg, #fff 50%, #000 50%)' : aciToCss(aci);
}

export function aciToCss(aci: number): string {
  return rgbToCss(ACI_RGB[Math.max(0, Math.min(255, Math.abs(aci)))]);
}

/** Nearest ACI for an RGB value (used when the user picks a colour for an R12 file). */
export function nearestAci(rgb: number): number {
  let best = 7, bestD = Infinity;
  const r = (rgb >> 16) & 255, g = (rgb >> 8) & 255, b = rgb & 255;
  for (let i = 1; i < 256; i++) {
    const c = ACI_RGB[i];
    const d = (((c >> 16) & 255) - r) ** 2 + (((c >> 8) & 255) - g) ** 2 + ((c & 255) - b) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
