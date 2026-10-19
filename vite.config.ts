import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// The LibreDWG WebAssembly binary isn't exposed by the package's "exports" map; alias it so the
// DWG worker can import its URL (it is fetched only when a DWG is opened).
const libredwgWasm = fileURLToPath(new URL('./node_modules/@mlightcad/libredwg-web/wasm/libredwg-web.wasm', import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^@libredwg-wasm/, replacement: libredwgWasm }],
  },
  worker: { format: 'es' },
  // the DWG tests compile a 10 MB WebAssembly module, which slows other suites running in parallel
  test: { testTimeout: 30000 },
});
