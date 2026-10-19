import type { DxfRecord, RecordSnapshot } from '../dxf/record';

/**
 * A transaction records the "before" state of every record and array it touches;
 * commit captures the "after" state. Undo/redo swap between the two.
 */
export class Tx {
  private recs = new Map<DxfRecord, RecordSnapshot>();
  private arrays = new Map<unknown[], unknown[]>();
  private afterRecs = new Map<DxfRecord, RecordSnapshot>();
  private afterArrays = new Map<unknown[], unknown[]>();
  /** Set if anything other than model-space entities changed (layers, blocks...). */
  global = false;

  constructor(public label: string) {}

  touch(r: DxfRecord): DxfRecord {
    if (!this.recs.has(r)) this.recs.set(r, r.snapshot());
    return r;
  }
  touchArray<T>(a: T[]): T[] {
    if (!this.arrays.has(a)) this.arrays.set(a, a.slice());
    return a;
  }

  get records(): DxfRecord[] {
    return [...this.recs.keys()];
  }
  get empty(): boolean {
    return this.recs.size === 0 && this.arrays.size === 0;
  }

  commit(): void {
    for (const r of this.recs.keys()) this.afterRecs.set(r, r.snapshot());
    for (const a of this.arrays.keys()) this.afterArrays.set(a, a.slice());
  }

  undo(): void {
    for (const [r, s] of this.recs) r.restore(s);
    for (const [a, s] of this.arrays) a.splice(0, a.length, ...s);
  }
  redo(): void {
    for (const [r, s] of this.afterRecs) r.restore(s);
    for (const [a, s] of this.afterArrays) a.splice(0, a.length, ...s);
  }
}

export class History {
  private done: Tx[] = [];
  private undone: Tx[] = [];
  onChange: (tx: Tx, kind: 'do' | 'undo' | 'redo') => void = () => {};

  /** Run `fn` inside a transaction. If it throws, the changes are rolled back. */
  run<T>(label: string, fn: (tx: Tx) => T): T {
    const tx = new Tx(label);
    let result: T;
    try {
      result = fn(tx);
    } catch (e) {
      tx.undo();
      throw e;
    }
    if (!tx.empty) {
      tx.commit();
      this.done.push(tx);
      this.undone = [];
      this.onChange(tx, 'do');
    }
    return result;
  }

  undo(): Tx | null {
    const tx = this.done.pop();
    if (!tx) return null;
    tx.undo();
    this.undone.push(tx);
    this.onChange(tx, 'undo');
    return tx;
  }
  redo(): Tx | null {
    const tx = this.undone.pop();
    if (!tx) return null;
    tx.redo();
    this.done.push(tx);
    this.onChange(tx, 'redo');
    return tx;
  }
  get canUndo() {
    return this.done.length > 0;
  }
  get canRedo() {
    return this.undone.length > 0;
  }
  get undoLabel() {
    return this.done[this.done.length - 1]?.label;
  }
  clear() {
    this.done = [];
    this.undone = [];
  }
}
