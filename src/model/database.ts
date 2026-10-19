import { type Group, group } from '../dxf/groups';
import { DxfRecord } from '../dxf/record';

export interface HeaderVar {
  name: string;
  groups: Group[];
}

export interface DxfTable {
  name: string;
  head: DxfRecord;
  entries: DxfRecord[];
  end: DxfRecord;
}

export interface DxfBlock {
  begin: DxfRecord;
  entities: DxfRecord[];
  end: DxfRecord;
}

export type DxfSection =
  | { kind: 'header'; name: string; vars: HeaderVar[] }
  | { kind: 'classes'; name: string; records: DxfRecord[] }
  | { kind: 'tables'; name: string; tables: DxfTable[] }
  | { kind: 'blocks'; name: string; blocks: DxfBlock[] }
  | { kind: 'entities'; name: string; entities: DxfRecord[] }
  | { kind: 'objects'; name: string; records: DxfRecord[] }
  | { kind: 'raw'; name: string; groups: Group[] };

/** Release names for $ACADVER values. */
export const ACAD_VERSIONS: Record<string, string> = {
  AC1006: 'R10', AC1009: 'R11/R12', AC1012: 'R13', AC1014: 'R14', AC1015: 'AutoCAD 2000',
  AC1018: 'AutoCAD 2004', AC1021: 'AutoCAD 2007', AC1024: 'AutoCAD 2010',
  AC1027: 'AutoCAD 2013', AC1032: 'AutoCAD 2018',
};

/**
 * The drawing database: an ordered set of sections, exactly as read, plus indexes.
 * Model space entities live in the ENTITIES section (those without 67=1);
 * block definitions (including *Model_Space/*Paper_Space and anonymous *D/*U blocks) in BLOCKS.
 */
export class DxfDocument {
  sections: DxfSection[] = [];
  private handleIndex: Map<string, DxfRecord> | null = null;
  private handleCounter = 0;

  // ---- sections --------------------------------------------------------------
  private section<K extends DxfSection['kind']>(kind: K): Extract<DxfSection, { kind: K }> | undefined {
    return this.sections.find((s) => s.kind === kind) as Extract<DxfSection, { kind: K }> | undefined;
  }

  get headerVars(): HeaderVar[] {
    return this.section('header')?.vars ?? [];
  }
  get tables(): DxfTable[] {
    return this.section('tables')?.tables ?? [];
  }
  get blocks(): DxfBlock[] {
    return this.section('blocks')?.blocks ?? [];
  }
  get objects(): DxfRecord[] {
    return this.section('objects')?.records ?? [];
  }
  get classes(): DxfRecord[] {
    return this.section('classes')?.records ?? [];
  }
  /** The ENTITIES section list, created if the file had none. */
  get entities(): DxfRecord[] {
    let s = this.section('entities');
    if (!s) {
      s = { kind: 'entities', name: 'ENTITIES', entities: [] };
      const objIdx = this.sections.findIndex((x) => x.kind === 'objects');
      if (objIdx >= 0) this.sections.splice(objIdx, 0, s);
      else this.sections.push(s);
    }
    return s.entities;
  }

  // ---- header ----------------------------------------------------------------
  headerVar(name: string): HeaderVar | undefined {
    const n = name.toUpperCase();
    return this.headerVars.find((v) => v.name.toUpperCase() === n);
  }
  headerValue(name: string): string | undefined {
    return this.headerVar(name)?.groups[0]?.value.trim();
  }
  headerNum(name: string, def: number): number {
    const v = this.headerValue(name);
    const n = v === undefined ? NaN : Number(v);
    return Number.isFinite(n) ? n : def;
  }
  headerPoint(name: string): [number, number, number] | undefined {
    const v = this.headerVar(name);
    if (!v || !v.groups.length) return undefined;
    const p: [number, number, number] = [0, 0, 0];
    for (const g of v.groups) {
      const axis = Math.floor((g.code % 100) / 10) - 1;
      if (axis >= 0 && axis < 3) p[axis] = Number(g.value) || 0;
    }
    return p;
  }
  setHeader(name: string, code: number, v: number | string): void {
    const hv = this.headerVar(name);
    if (hv) hv.groups = [group(code, v)];
    else this.section('header')?.vars.push({ name, groups: [group(code, v)] });
  }

  get version(): string {
    return this.headerValue('$ACADVER') ?? 'AC1009';
  }
  /** True for R13+ files that use subclass markers (100 groups) and owner handles. */
  get isModern(): boolean {
    return this.version > 'AC1009';
  }
  get usesHandles(): boolean {
    if (this.isModern) return true;
    return this.headerNum('$HANDLING', 0) !== 0 || [...this.allRecords()].some((r) => r.has(5));
  }

  // ---- tables ----------------------------------------------------------------
  table(name: string): DxfTable | undefined {
    const n = name.toUpperCase();
    return this.tables.find((t) => t.name.toUpperCase() === n);
  }
  tableEntry(table: string, name: string): DxfRecord | undefined {
    const n = name.toUpperCase();
    return this.table(table)?.entries.find((e) => e.str(2).toUpperCase() === n);
  }
  layer(name: string): DxfRecord | undefined {
    return this.tableEntry('LAYER', name);
  }
  block(name: string): DxfBlock | undefined {
    const n = name.toUpperCase();
    return this.blocks.find((b) => b.begin.str(2).toUpperCase() === n);
  }
  /** BLOCK_RECORD handle for *Model_Space (owner of new model-space entities). */
  get modelSpaceHandle(): string | undefined {
    return this.tableEntry('BLOCK_RECORD', '*Model_Space')?.handle;
  }

  // ---- handles ---------------------------------------------------------------
  *allRecords(): Generator<DxfRecord> {
    for (const s of this.sections) {
      if (s.kind === 'classes' || s.kind === 'objects') yield* s.records;
      else if (s.kind === 'tables') {
        for (const t of s.tables) {
          yield t.head;
          yield* t.entries;
        }
      } else if (s.kind === 'blocks') {
        for (const b of s.blocks) {
          yield b.begin;
          for (const e of b.entities) yield* withChildren(e);
          yield b.end;
        }
      } else if (s.kind === 'entities') {
        for (const e of s.entities) yield* withChildren(e);
      }
    }
  }

  byHandle(h: string): DxfRecord | undefined {
    if (!this.handleIndex) {
      this.handleIndex = new Map();
      for (const r of this.allRecords()) {
        const hh = r.handle;
        if (hh) this.handleIndex.set(hh.trim().toUpperCase(), r);
      }
    }
    return this.handleIndex.get(h.trim().toUpperCase());
  }
  invalidateHandles(): void {
    this.handleIndex = null;
  }

  /** Allocate a fresh handle and advance $HANDSEED. */
  newHandle(): string {
    if (!this.handleCounter) {
      let max = 0;
      for (const r of this.allRecords()) {
        const v = parseInt(r.handle ?? '', 16);
        if (v > max) max = v;
      }
      const seed = parseInt(this.headerValue('$HANDSEED') ?? '0', 16) || 0;
      this.handleCounter = Math.max(seed, max + 1);
    }
    const h = this.handleCounter.toString(16).toUpperCase();
    this.handleCounter++;
    this.setHeader('$HANDSEED', 5, this.handleCounter.toString(16).toUpperCase());
    this.handleIndex = null;
    return h;
  }
}

export function* withChildren(e: DxfRecord): Generator<DxfRecord> {
  yield e;
  yield* e.children;
  if (e.seqend) yield e.seqend;
}
