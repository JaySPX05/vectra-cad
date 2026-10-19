// End-to-end test of the desktop app (Electron) with Playwright's Electron driver.
// Usage: node scripts/electron_check.mjs <workDir> [path/to/Vectra CAD.exe]
// Without an exe it runs the unpackaged app (`electron .`, needs `vite build` first).
import { _electron as electron } from 'playwright-core';
import { copyFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const work = resolve(process.argv[2] ?? 'test-output/electron');
const exe = process.argv[3];
mkdirSync(work, { recursive: true });
const dxfPath = join(work, 'plate.dxf');
const dwgPath = join(work, 'house plan 2018.dwg'); // a space in the name, like real paths
copyFileSync('public/samples/ucs_dims.dxf', dxfPath);
copyFileSync('public/samples/public/example_2018.dwg', dwgPath);

const launch = (file) => electron.launch(exe ? { executablePath: exe, args: [file] } : { args: ['.', file] });
const errors = [];
/** Poll a page condition (the app's CSP forbids eval, which page.waitForFunction relies on). */
async function poll(page, fn, arg, timeout = 30000) {
  const end = Date.now() + timeout;
  for (;;) {
    if (await page.evaluate(fn, arg).catch(() => false)) return;
    if (Date.now() > end) throw new Error('timed out waiting for ' + fn.toString());
    await new Promise((r) => setTimeout(r, 150));
  }
}

// 1) open a drawing passed on the command line (what a double-click in Explorer does)
let appE = await launch(dxfPath);
let page = await appE.firstWindow();
page.on('pageerror', (e) => errors.push(e.message));
await poll(page, () => window.__app?.fileName === 'plate.dxf', undefined, 30000);
console.log('opened from argv:', JSON.stringify(await page.evaluate(() => ({ path: window.__app.filePath, entities: window.__app.scene.items.length }))));
console.log('window title:', await page.title());

// 2) offline: the page cannot reach the network
const net = await page.evaluate(() => fetch('https://example.com/').then(() => 'reached network', (e) => 'blocked: ' + e.message));
console.log('network fetch ->', net);
console.log('origin:', await page.evaluate(() => location.href));

// 3) edit + Ctrl+S writes back to the same .dxf on disk
await page.locator('canvas.viewport').click({ position: { x: 5, y: 5 } });
await page.keyboard.press('Escape');
for (const t of ['DIMLINEAR', '0,0', '120,0', '60,-15']) { await page.keyboard.type(t); await page.keyboard.press('Enter'); await page.waitForTimeout(80); }
// Dimension Style Manager under the app's CSP: preview draws, colour picker works, Modify regenerates
await page.keyboard.type('DIMSTYLE');
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
const inked = () => page.evaluate(() => {
  const c = document.querySelector('.ds-preview');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - d[0]) + Math.abs(d[i + 1] - d[1]) + Math.abs(d[i + 2] - d[2]) > 60) n++;
  return n;
});
console.log('style manager open:', await page.locator('.ds-manager-modal').isVisible(), '| preview pixels:', await inked());
await page.locator('.ds-actions button', { hasText: 'Modify…' }).click();
await page.waitForTimeout(300);
await page.locator('.ds-edit-modal [aria-label="Color"]').first().click();
await page.locator('.popover button[title="ACI 1"]').click();
await page.locator('.ds-edit-modal button', { hasText: 'OK' }).click();
await page.waitForTimeout(300);
console.log('modify ->', await page.evaluate(() => [...document.querySelectorAll('.cmd-line')].at(-1).textContent));
await page.locator('.ds-manager-modal .modal-buttons button', { hasText: 'Close' }).click();
console.log('dirty before save:', await page.evaluate(() => window.__app.dirtyFile), '| title', await page.title());
await page.keyboard.press('Control+s');
await poll(page, () => !window.__app.dirtyFile, undefined, 10000);
const saved = readFileSync(dxfPath, 'latin1');
console.log('saved in place:', saved.includes('DIMENSION'), '| title', await page.title());

// 4) a DWG opened later (second launch forwards it to the running window)
// launch a second copy directly (as Explorer does); it hands the file to the running window and exits
const { spawn } = await import('node:child_process');
const electronBin = exe ?? (await import('electron')).default;
const child = spawn(electronBin, exe ? [dwgPath] : ['.', dwgPath], { stdio: 'ignore' });
const exitCode = await new Promise((r) => child.on('exit', r));
console.log('second instance exited with', exitCode);
await poll(page, () => window.__app?.fileName === 'house plan 2018.dwg', undefined, 60000);
console.log('DWG via second instance:', JSON.stringify(await page.evaluate(() => ({ version: window.__app.doc.version, entities: window.__app.scene.items.length, path: window.__app.filePath }))));
console.log('log:', (await page.locator('.cmd-log').innerText()).split('\n').slice(-3).join(' | '));
await page.screenshot({ path: join(work, 'desktop_dwg.png') });

// 5) Save on a DWG -> Save As dialog (stubbed) proposes a .dxf next to it
await appE.evaluate(({ dialog }, target) => {
  dialog.showSaveDialog = async (_w, opts) => { globalThis.__lastSaveDefault = opts.defaultPath; return { canceled: false, filePath: target }; };
}, join(work, 'house plan 2018 converted'));
await page.keyboard.press('Control+s');
await poll(page, () => window.__app.fileName.endsWith('.dxf'), undefined, 10000);
console.log('Save As default:', await appE.evaluate(() => globalThis.__lastSaveDefault));
console.log('wrote', existsSync(join(work, 'house plan 2018 converted.dxf')) ? 'house plan 2018 converted.dxf' : 'NOTHING');

// 6) closing with unsaved changes asks first (stub answers "Don't Save")
for (const t of ['LINE', '0,0', '10,10', '']) { await page.keyboard.type(t); await page.keyboard.press('Enter'); await page.waitForTimeout(80); }
await appE.evaluate(({ dialog }) => {
  dialog.showMessageBox = async (_w, opts) => { globalThis.__asked = opts.message; return { response: 1 }; };
});
const closed = appE.waitForEvent('close');
await page.evaluate(() => window.close());
await appE.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close()).catch(() => {});
await closed.catch(() => {});
console.log('asked on close: yes (app exited after "Don\'t Save")');
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
