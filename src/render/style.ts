import type { DxfRecord } from '../dxf/record';
import type { DxfDocument } from '../model/database';
import { ACI_RGB } from '../model/aci';

/** Resolved colour: 'fg' means ACI 7 (white on dark backgrounds, black on light). */
export type Color = number | 'fg';

/** DXF linetype pattern: positive = dash, negative = gap, 0 = dot (drawing units). */
export interface Linetype {
  name: string;
  pattern: number[];
  total: number;
}

export interface Style {
  color: Color;
  linetype: Linetype | null; // null = continuous
  /** Pattern scale (LTSCALE x CELTSCALE x block scale). */
  ltScale: number;
  /** Lineweight in mm (0 = thinnest). */
  lineweight: number;
}

/** Properties an INSERT passes down to BYBLOCK / layer-0 entities. */
export interface Inherit {
  color: Color;
  linetype: string;
  lineweight: number;
  layer: string | null;
  ltScale: number;
}

export const TOP_INHERIT: Inherit = { color: 'fg', linetype: 'CONTINUOUS', lineweight: -3, layer: null, ltScale: 1 };

export class StyleResolver {
  private layerCache = new Map<string, DxfRecord | null>();
  private ltCache = new Map<string, Linetype | null>();
  ltscale = 1;
  defaultLineweight = 0.25;

  constructor(private doc: DxfDocument) {
    this.reset();
  }

  reset(): void {
    this.layerCache.clear();
    this.ltCache.clear();
    this.ltscale = this.doc.headerNum('$LTSCALE', 1) || 1;
    const lwd = this.doc.headerNum('$LWDEFAULT', 25);
    this.defaultLineweight = lwd > 0 ? lwd / 100 : 0.25;
  }

  layerRec(name: string): DxfRecord | null {
    const key = name.toUpperCase();
    let r = this.layerCache.get(key);
    if (r === undefined) {
      r = this.doc.layer(name) ?? null;
      this.layerCache.set(key, r);
    }
    return r;
  }

  /** Effective layer: entities on layer 0 inside a block take the INSERT's layer. */
  effectiveLayer(rec: DxfRecord, inh: Inherit): string {
    const l = rec.layer;
    return l === '0' && inh.layer ? inh.layer : l;
  }

  /** Layer visible? Off = negative colour; frozen = flag bit 1. */
  layerVisible(name: string): boolean {
    const l = this.layerRec(name);
    if (!l) return true;
    if (l.num(62, 7) < 0) return false;
    return (l.num(70, 0) & 1) === 0;
  }
  layerFrozen(name: string): boolean {
    const l = this.layerRec(name);
    return !!l && (l.num(70, 0) & 1) !== 0;
  }

  layerColor(name: string): Color {
    const l = this.layerRec(name);
    if (!l) return 'fg';
    if (l.has(420)) return l.num(420, 0) & 0xffffff;
    return aciColor(Math.abs(l.num(62, 7)));
  }

  color(rec: DxfRecord, inh: Inherit): Color {
    if (rec.has(420)) return rec.num(420, 0) & 0xffffff;
    const aci = rec.num(62, 256);
    if (aci === 0) return inh.color;
    if (aci === 256) return this.layerColor(this.effectiveLayer(rec, inh));
    return aciColor(Math.abs(aci));
  }

  linetypeName(rec: DxfRecord, inh: Inherit): string {
    const lt = rec.str(6, 'BYLAYER');
    const u = lt.toUpperCase();
    if (u === 'BYBLOCK') return inh.linetype;
    if (u === 'BYLAYER') {
      const l = this.layerRec(this.effectiveLayer(rec, inh));
      return l ? l.str(6, 'CONTINUOUS') : 'CONTINUOUS';
    }
    return lt;
  }

  linetype(name: string): Linetype | null {
    const key = name.toUpperCase();
    if (key === 'CONTINUOUS' || key === 'BYLAYER' || key === 'BYBLOCK') return null;
    let lt = this.ltCache.get(key);
    if (lt === undefined) {
      lt = null;
      const r = this.doc.tableEntry('LTYPE', name);
      if (r) {
        const pattern = r.all(49).map(Number).filter(Number.isFinite);
        const total = pattern.reduce((s, v) => s + Math.abs(v), 0);
        if (pattern.length >= 2 && total > 0) lt = { name, pattern, total };
      }
      this.ltCache.set(key, lt);
    }
    return lt;
  }

  /** Lineweight in mm; -1 BYLAYER, -2 BYBLOCK, -3 DEFAULT (per DXF 370 group). */
  lineweightRaw(rec: DxfRecord, inh: Inherit): number {
    let lw = rec.num(370, -1);
    if (lw === -2) lw = inh.lineweight;
    if (lw === -1) {
      const l = this.layerRec(this.effectiveLayer(rec, inh));
      lw = l ? l.num(370, -3) : -3;
      if (lw < -1) lw = -3;
    }
    return lw;
  }

  style(rec: DxfRecord, inh: Inherit): Style {
    const lw = this.lineweightRaw(rec, inh);
    return {
      color: this.color(rec, inh),
      linetype: this.linetype(this.linetypeName(rec, inh)),
      ltScale: this.ltscale * rec.num(48, 1) * inh.ltScale,
      lineweight: lw < 0 ? this.defaultLineweight : lw / 100,
    };
  }
}

export function aciColor(aci: number): Color {
  if (aci === 7 || aci <= 0 || aci > 255) return 'fg';
  return ACI_RGB[aci];
}
