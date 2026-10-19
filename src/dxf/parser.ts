import type { Group } from './groups';
import { DxfRecord } from './record';
import { decodeDxfBytes, DxfFormatError, tokenize } from './tokenizer';
import { DxfDocument, type DxfBlock, type DxfSection, type DxfTable, type HeaderVar } from '../model/database';

/** Parse DXF text into a lossless DxfDocument. */
export function parseDxf(input: string | Uint8Array): DxfDocument {
  const text = typeof input === 'string' ? input : decodeDxfBytes(input);
  return new Parser(tokenize(text)).parse();
}

class Parser {
  private i = 0;
  constructor(private gs: Group[]) {}

  private is0(name: string): boolean {
    const g = this.gs[this.i];
    return !!g && g.code === 0 && g.value.trim() === name;
  }

  parse(): DxfDocument {
    const doc = new DxfDocument();
    while (this.i < this.gs.length) {
      const g = this.gs[this.i];
      if (g.code === 0 && g.value.trim() === 'EOF') break;
      if (g.code === 999) {
        this.i++; // comment before/between sections; not preserved
        continue;
      }
      if (!(g.code === 0 && g.value.trim() === 'SECTION')) {
        throw new DxfFormatError(`Expected SECTION, found ${g.code}/${g.value} at pair ${this.i}`);
      }
      this.i++;
      const nameG = this.gs[this.i++];
      if (!nameG || nameG.code !== 2) throw new DxfFormatError('SECTION without a name');
      doc.sections.push(this.section(nameG.value.trim()));
    }
    return doc;
  }

  private section(name: string): DxfSection {
    switch (name) {
      case 'HEADER':
        return { kind: 'header', name, vars: this.header() };
      case 'CLASSES':
        return { kind: 'classes', name, records: this.flat() };
      case 'TABLES':
        return { kind: 'tables', name, tables: this.tables() };
      case 'BLOCKS':
        return { kind: 'blocks', name, blocks: this.blocks() };
      case 'ENTITIES': {
        const entities = this.entityList(() => this.is0('ENDSEC'));
        this.endsec();
        return { kind: 'entities', name, entities };
      }
      case 'OBJECTS':
        return { kind: 'objects', name, records: this.flat() };
      default: {
        const groups: Group[] = [];
        while (this.i < this.gs.length && !this.is0('ENDSEC')) groups.push(this.gs[this.i++]);
        this.endsec();
        return { kind: 'raw', name, groups };
      }
    }
  }

  private endsec(): void {
    if (!this.is0('ENDSEC')) throw new DxfFormatError('Unterminated section (missing ENDSEC)');
    this.i++;
  }

  private header(): HeaderVar[] {
    const vars: HeaderVar[] = [];
    while (this.i < this.gs.length && !this.is0('ENDSEC')) {
      const g = this.gs[this.i++];
      if (g.code === 9) vars.push({ name: g.value.trim(), groups: [] });
      else if (vars.length) vars[vars.length - 1].groups.push(g);
    }
    this.endsec();
    return vars;
  }

  /** Read one `0 TYPE` record (the cursor sits on its 0 group). */
  private record(): DxfRecord {
    const type = this.gs[this.i++].value.trim();
    const start = this.i;
    while (this.i < this.gs.length && this.gs[this.i].code !== 0) this.i++;
    return new DxfRecord(type, this.gs.slice(start, this.i));
  }

  private flat(): DxfRecord[] {
    const out: DxfRecord[] = [];
    while (this.i < this.gs.length && !this.is0('ENDSEC')) out.push(this.record());
    this.endsec();
    return out;
  }

  private tables(): DxfTable[] {
    const out: DxfTable[] = [];
    while (this.i < this.gs.length && !this.is0('ENDSEC')) {
      if (!this.is0('TABLE')) {
        this.record(); // stray record; skip
        continue;
      }
      const head = this.record();
      const entries: DxfRecord[] = [];
      while (this.i < this.gs.length && !this.is0('ENDTAB') && !this.is0('ENDSEC')) entries.push(this.record());
      const end = this.is0('ENDTAB') ? this.record() : new DxfRecord('ENDTAB', []);
      out.push({ name: head.str(2), head, entries, end });
    }
    this.endsec();
    return out;
  }

  private blocks(): DxfBlock[] {
    const out: DxfBlock[] = [];
    while (this.i < this.gs.length && !this.is0('ENDSEC')) {
      if (!this.is0('BLOCK')) {
        this.record();
        continue;
      }
      const begin = this.record();
      const entities = this.entityList(() => this.is0('ENDBLK') || this.is0('ENDSEC'));
      const end = this.is0('ENDBLK') ? this.record() : new DxfRecord('ENDBLK', []);
      out.push({ begin, entities, end });
    }
    this.endsec();
    return out;
  }

  /** Entities, attaching VERTEX/ATTRIB followers and the closing SEQEND to their parent. */
  private entityList(stop: () => boolean): DxfRecord[] {
    const out: DxfRecord[] = [];
    while (this.i < this.gs.length && !stop()) {
      const e = this.record();
      const childType = e.type === 'POLYLINE' ? 'VERTEX' : e.type === 'INSERT' ? 'ATTRIB' : null;
      if (childType) {
        while (this.is0(childType)) e.children.push(this.record());
        if ((e.children.length || e.type === 'POLYLINE' || e.num(66) === 1) && this.is0('SEQEND')) {
          e.seqend = this.record();
        }
      }
      out.push(e);
    }
    return out;
  }
}

export { DxfFormatError };
