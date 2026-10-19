import type { DxfRecord } from '../dxf/record';
import type { DxfDocument } from '../model/database';
import type { Scene } from '../render/scene';
import { cloneEntity, ensureLayer } from './create';
import { applyGrip, type Grip } from './grips';
import { History, type Tx } from './history';
import { affectedRecords, canTransform, type Similarity, similarityInUcs, transformEntity, TransformError } from './transform';
import { Ucs } from '../model/ucs';
import type { NewProps } from './create';
import { type DimSpec, newDimension, regenDimension, setDimDynamic, setDimOverride } from '../dims/create';
import { type DynText, readDynamic, writeDynamic } from '../dims/dynamic';
import { DIMVAR, dimStyleFor } from '../dims/style';

const isDimension = (r: DxfRecord) => r.type === 'DIMENSION';

/**
 * All drawing modifications go through here: each runs as an undoable transaction
 * on the DxfDocument, then the affected entities are regenerated in the Scene.
 */
export class Editor {
  history = new History();
  /** Top-level entities whose geometry must be regenerated after a tx. */
  private dirty = new WeakMap<Tx, Set<DxfRecord>>();
  onChanged: () => void = () => {};

  constructor(public doc: DxfDocument, public scene: Scene) {
    this.history.onChange = (tx) => this.refresh(tx);
  }

  private refresh(tx: Tx) {
    this.doc.invalidateHandles();
    if (tx.global) this.scene.rebuildAll();
    else {
      this.scene.sync();
      for (const r of this.dirty.get(tx) ?? []) if (this.scene.geomOf(r)) this.scene.rebuild(r);
    }
    this.onChanged();
  }

  private run<T>(label: string, fn: (tx: Tx, dirty: Set<DxfRecord>) => T): T {
    return this.history.run(label, (tx) => {
      const d = new Set<DxfRecord>();
      this.dirty.set(tx, d);
      return fn(tx, d);
    });
  }

  private touchEntity(tx: Tx, r: DxfRecord) {
    for (const a of affectedRecords(r, this.doc)) tx.touch(a);
  }

  /** Table-level change (dimension styles…): everything is regenerated afterwards. */
  styleTx<T>(label: string, fn: (tx: Tx) => T): T {
    return this.run(label, (tx) => {
      tx.global = true;
      return fn(tx);
    });
  }

  /** Apply a transform; entities that can't be transformed are skipped and reported. */
  transform(label: string, recs: DxfRecord[], t: Similarity): { skipped: string[] } {
    const skipped: string[] = [];
    this.run(label, (tx, dirty) => {
      for (const r of recs) {
        if (!canTransform(r)) {
          skipped.push(r.type);
          continue;
        }
        this.touchEntity(tx, r);
        try {
          transformEntity(r, t, this.doc);
          // dynamic labels re-measure after SCALE etc.
          if (isDimension(r) && readDynamic(r)) regenDimension(this.doc, r, tx);
          dirty.add(r);
        } catch (e) {
          if (e instanceof TransformError) {
            skipped.push(r.type);
            continue;
          }
          throw e;
        }
      }
    });
    return { skipped };
  }

  // Displacements, base points and angles are given in `ucs` coordinates (default: world).
  move(recs: DxfRecord[], dx: number, dy: number, ucs: Ucs = Ucs.WORLD) {
    return this.transform('Move', recs, similarityInUcs(ucs, { dx, dy }));
  }
  rotate(recs: DxfRecord[], base: [number, number], angleRad: number, ucs: Ucs = Ucs.WORLD) {
    return this.transform('Rotate', recs, similarityInUcs(ucs, { base, angle: angleRad }));
  }
  scale(recs: DxfRecord[], base: [number, number], factor: number, ucs: Ucs = Ucs.WORLD) {
    return this.transform('Scale', recs, similarityInUcs(ucs, { base, scale: factor }));
  }

  copy(recs: DxfRecord[], dx: number, dy: number, ucs: Ucs = Ucs.WORLD): DxfRecord[] {
    const t = similarityInUcs(ucs, { dx, dy });
    return this.run('Copy', (tx, dirty) => {
      const ents = tx.touchArray(this.doc.entities);
      const out: DxfRecord[] = [];
      for (const r of recs) {
        if (!canTransform(r)) continue;
        const c = cloneEntity(this.doc, r, tx);
        transformEntity(c, t, this.doc);
        ents.push(c);
        dirty.add(c);
        out.push(c);
      }
      return out;
    });
  }

  erase(recs: DxfRecord[]) {
    const kill = new Set(recs);
    this.run('Erase', (tx) => {
      const ents = tx.touchArray(this.doc.entities);
      const keep = ents.filter((e) => !kill.has(e));
      ents.splice(0, ents.length, ...keep);
    });
  }

  add(recs: DxfRecord[], label = 'Draw') {
    this.run(label, (tx, dirty) => {
      const ents = tx.touchArray(this.doc.entities);
      for (const r of recs) {
        ents.push(r);
        dirty.add(r);
      }
    });
  }

  /** Set (or with value null, remove) a group on each entity, e.g. 8 layer, 62 colour. */
  setGroup(recs: DxfRecord[], code: number, value: string | number | null, label = 'Properties') {
    this.run(label, (tx, dirty) => {
      if (code === 8 && typeof value === 'string') ensureLayer(this.doc, value, tx);
      for (const r of recs) {
        tx.touch(r);
        if (value === null) r.remove(code);
        else r.set(code, value);
        if (code === 62 && r.has(420)) r.remove(420); // ACI choice replaces true colour
        dirty.add(r);
      }
    });
  }

  /** Raw edit of one group (inspector). `owner` is the top-level entity to regenerate. */
  setRawGroup(rec: DxfRecord, index: number, value: string, owner: DxfRecord | null) {
    this.run('Edit group', (tx, dirty) => {
      tx.touch(rec);
      if (owner && owner !== rec) tx.touch(owner);
      rec.groups[index].value = value;
      if (owner) dirty.add(owner);
      else tx.global = true;
    });
  }

  /** Drag a grip: reshape, or translate for move-grips. Dimensions regenerate their graphics. */
  grip(rec: DxfRecord, g: Grip, x: number, y: number) {
    if (g.move) return this.move([rec], x - g.x, y - g.y);
    this.run('Grip edit', (tx, dirty) => {
      tx.touch(rec);
      applyGrip(rec, g, x, y);
      if (isDimension(rec)) regenDimension(this.doc, rec, tx);
      dirty.add(rec);
    });
    return { skipped: [] };
  }

  /** Create a DIMENSION (entity + anonymous block) from definition points. */
  addDimension(spec: DimSpec, ucs: Ucs, props: NewProps): DxfRecord {
    return this.run('Dimension', (tx, dirty) => {
      const rec = newDimension(this.doc, spec, ucs, props, tx);
      tx.touchArray(this.doc.entities).push(rec);
      dirty.add(rec);
      return rec;
    });
  }

  /** Set (null = clear) a DIMSTYLE override (e.g. DIMSCALE 40) on dimensions and regenerate them. */
  setDimOverride(recs: DxfRecord[], code: number, value: number | null) {
    this.run('Dimension override', (tx, dirty) => {
      for (const r of recs) {
        if (!isDimension(r)) continue;
        setDimOverride(this.doc, r, code, value, tx);
        dirty.add(r);
      }
    });
  }

  /** Set the label height (drawing units) of dimensions; null returns them to their style's height. */
  setDimTextHeight(recs: DxfRecord[], height: number | null) {
    this.run('Dimension text height', (tx, dirty) => {
      for (const r of recs) {
        if (!isDimension(r)) continue;
        // DIMTXT is multiplied by the dimension's DIMSCALE
        const value = height === null ? null : height / dimStyleFor(this.doc, r).scale;
        tx.touch(r);
        writeDynamic(r, null); // an explicit height ends dynamic sizing
        setDimOverride(this.doc, r, DIMVAR.DIMTXT, value, tx);
        dirty.add(r);
      }
    });
  }

  /** Make dimension labels follow their measured value (settings), or stop (null: keep the current height). */
  setDimDynamic(recs: DxfRecord[], d: DynText | null) {
    this.run('Dynamic text height', (tx, dirty) => {
      for (const r of recs) {
        if (!isDimension(r)) continue;
        setDimDynamic(this.doc, r, d, tx);
        dirty.add(r);
      }
    });
  }

  /** Change a dimension's text override (group 1; "<>" = measured value) and regenerate it. */
  setDimensionText(rec: DxfRecord, text: string) {
    this.run('Dimension text', (tx, dirty) => {
      tx.touch(rec);
      rec.set(1, text);
      regenDimension(this.doc, rec, tx);
      dirty.add(rec);
    });
  }

  /** Layer state changes are table edits and affect many entities. */
  setLayerState(name: string, change: { on?: boolean; frozen?: boolean; color?: number }) {
    const layer = this.doc.layer(name);
    if (!layer) return;
    this.run('Layer', (tx) => {
      tx.touch(layer);
      tx.global = true;
      const c = layer.num(62, 7);
      if (change.color !== undefined) layer.set(62, c < 0 ? -Math.abs(change.color) : Math.abs(change.color));
      if (change.on !== undefined) layer.set(62, change.on ? Math.abs(layer.num(62, 7)) : -Math.abs(layer.num(62, 7)));
      if (change.frozen !== undefined) {
        const f = layer.num(70, 0);
        layer.set(70, change.frozen ? f | 1 : f & ~1);
      }
    });
  }

  undo() {
    return this.history.undo();
  }
  redo() {
    return this.history.redo();
  }
}
