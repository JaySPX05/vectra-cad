import { DwgError } from './libredwg';

/** Convert a DWG to DXF bytes in a fresh worker (loads the LibreDWG WebAssembly on first use). */
export function dwgToDxf(bytes: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./dwg.worker.ts', import.meta.url), { type: 'module' });
    const done = () => worker.terminate();
    worker.onmessage = (e: MessageEvent<{ ok: boolean; dxf?: Uint8Array; error?: string }>) => {
      done();
      if (e.data.ok && e.data.dxf) resolve(e.data.dxf);
      else reject(new DwgError(e.data.error ?? 'DWG conversion failed.'));
    };
    worker.onerror = (e) => {
      done();
      reject(new DwgError(`DWG conversion failed: ${e.message || 'the converter crashed'}.`));
    };
    const copy = bytes.slice();
    worker.postMessage(copy, [copy.buffer]);
  });
}
