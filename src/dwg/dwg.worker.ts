/// <reference lib="webworker" />
// Runs one DWG -> DXF conversion in its own worker, so a large file doesn't freeze the UI and a
// LibreDWG crash can't corrupt the next conversion (each worker gets a fresh WebAssembly instance).
import { createModule, LibreDwg } from '@mlightcad/libredwg-web';
import wasmUrl from '@libredwg-wasm?url';
import { convertWithLibreDwg } from './libredwg';

self.onmessage = async (e: MessageEvent<Uint8Array>) => {
  try {
    const mod = await createModule({ locateFile: () => wasmUrl, print: () => {}, printErr: () => {} });
    const dxf = convertWithLibreDwg(LibreDwg.createByWasmInstance(mod), e.data);
    (self as DedicatedWorkerGlobalScope).postMessage({ ok: true, dxf }, [dxf.buffer]);
  } catch (err) {
    (self as DedicatedWorkerGlobalScope).postMessage({ ok: false, error: (err as Error).message });
  }
};
