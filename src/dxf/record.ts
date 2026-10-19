import { type Group, cloneGroups, formatValue } from './groups';

export type Vec3 = [number, number, number];

/**
 * One DXF object (entity, table entry, object, class...). The record owns the exact
 * group list it was read from; typed views are decoded from it on demand, and edits
 * rewrite individual groups so that anything we don't understand is preserved.
 */
export class DxfRecord {
  /** VERTEX / ATTRIB records that follow a POLYLINE / INSERT. */
  children: DxfRecord[] = [];
  /** The SEQEND that closes `children`, if any. */
  seqend: DxfRecord | null = null;

  constructor(
    public type: string,
    /** All groups after the `0 TYPE` group. */
    public groups: Group[],
  ) {}

  get handle(): string | undefined {
    return this.get(this.type === 'DIMSTYLE' ? 105 : 5);
  }
  get owner(): string | undefined {
    return this.get(330);
  }
  get layer(): string {
    return this.get(8) ?? '0';
  }

  indexOf(code: number, from = 0): number {
    const gs = this.groups;
    for (let i = from; i < gs.length; i++) if (gs[i].code === code) return i;
    return -1;
  }

  get(code: number): string | undefined {
    const i = this.indexOf(code);
    return i < 0 ? undefined : this.groups[i].value;
  }
  str(code: number, def = ''): string {
    const v = this.get(code);
    return v === undefined ? def : v.trim();
  }
  num(code: number, def = 0): number {
    const v = this.get(code);
    if (v === undefined) return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  }
  has(code: number): boolean {
    return this.indexOf(code) >= 0;
  }
  /** All values for a repeated code, in order. */
  all(code: number): string[] {
    const out: string[] = [];
    for (const g of this.groups) if (g.code === code) out.push(g.value);
    return out;
  }

  /** Point starting at the first group `code` (x), with y = code+10 and z = code+20. */
  point(code: number, def: Vec3 = [0, 0, 0]): Vec3 {
    const i = this.indexOf(code);
    return i < 0 ? [def[0], def[1], def[2]] : readPointAt(this.groups, i);
  }
  hasPoint(code: number): boolean {
    return this.indexOf(code) >= 0;
  }

  /** Set the first group with `code`, inserting one if absent. */
  set(code: number, v: number | string | boolean): void {
    const value = formatValue(code, v);
    const i = this.indexOf(code);
    if (i >= 0) {
      this.groups[i].value = value;
      return;
    }
    this.groups.splice(this.insertionIndex(code), 0, { code, value });
  }

  remove(code: number): void {
    this.groups = this.groups.filter((g) => g.code !== code);
  }

  setPoint(code: number, p: Vec3 | [number, number], is3d = true): void {
    const i = this.indexOf(code);
    if (i >= 0) {
      writePointAt(this.groups, i, p);
      return;
    }
    const at = this.insertionIndex(code);
    const gs: Group[] = [
      { code, value: formatValue(code, p[0]) },
      { code: code + 10, value: formatValue(code + 10, p[1]) },
    ];
    if (is3d) gs.push({ code: code + 20, value: formatValue(code + 20, p[2] ?? 0) });
    this.groups.splice(at, 0, ...gs);
  }

  /**
   * Where a new group goes. Common entity properties (color, linetype...) live right
   * after the layer in the AcDbEntity subclass; anything else goes before XDATA.
   */
  private insertionIndex(code: number): number {
    const common = [6, 48, 60, 62, 370, 420, 430, 440];
    if (common.includes(code)) {
      const li = this.indexOf(8);
      if (li >= 0) return li + 1;
    }
    const x = this.indexOf(1001);
    return x >= 0 ? x : this.groups.length;
  }

  clone(): DxfRecord {
    const r = new DxfRecord(this.type, cloneGroups(this.groups));
    r.children = this.children.map((c) => c.clone());
    r.seqend = this.seqend ? this.seqend.clone() : null;
    return r;
  }

  /** Snapshot used by undo: groups of this record and its children. */
  snapshot(): RecordSnapshot {
    return {
      type: this.type,
      groups: cloneGroups(this.groups),
      children: this.children.map((c) => c.snapshot()),
      seqend: this.seqend ? cloneGroups(this.seqend.groups) : null,
    };
  }
  restore(s: RecordSnapshot): void {
    this.type = s.type;
    this.groups = cloneGroups(s.groups);
    this.children = s.children.map((cs) => {
      const c = new DxfRecord(cs.type, []);
      c.restore(cs);
      return c;
    });
    if (s.seqend) {
      this.seqend = this.seqend ?? new DxfRecord('SEQEND', []);
      this.seqend.groups = cloneGroups(s.seqend);
    } else this.seqend = null;
  }
}

export interface RecordSnapshot {
  type: string;
  groups: Group[];
  children: RecordSnapshot[];
  seqend: Group[] | null;
}

export function readPointAt(gs: Group[], i: number): Vec3 {
  const code = gs[i].code;
  const x = Number(gs[i].value) || 0;
  let y = 0;
  let z = 0;
  if (i + 1 < gs.length && gs[i + 1].code === code + 10) {
    y = Number(gs[i + 1].value) || 0;
    if (i + 2 < gs.length && gs[i + 2].code === code + 20) z = Number(gs[i + 2].value) || 0;
  }
  return [x, y, z];
}

export function writePointAt(gs: Group[], i: number, p: Vec3 | [number, number]): void {
  const code = gs[i].code;
  gs[i].value = formatValue(code, p[0]);
  if (i + 1 < gs.length && gs[i + 1].code === code + 10) {
    gs[i + 1].value = formatValue(code + 10, p[1]);
    if (i + 2 < gs.length && gs[i + 2].code === code + 20 && p.length > 2) {
      gs[i + 2].value = formatValue(code + 20, p[2] ?? 0);
    }
  }
}
