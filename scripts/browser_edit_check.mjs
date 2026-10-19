// End-to-end edit workflow in headless Edge: grip edit, MOVE by clicks, raw group edit,
// layer change, save (download) — then the saved file is validated with ezdxf separately.
// Usage: node scripts/browser_edit_check.mjs <outDir> [baseUrl]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] ?? 'test-output/screens';
const base = process.argv[3] ?? 'http://localhost:5199/';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !m.text().includes('404') && errors.push(m.text()));
await page.goto(base);
await page.waitForTimeout(1200);

await page.selectOption('.toolbar-select', 'r12_legacy.dxf');
await page.waitForTimeout(600);
const cv = await page.locator('canvas.viewport').boundingBox();

// world <-> screen helper using the app's view (exposed below via evaluate)
const toScreen = async (x, y) => page.evaluate(([x, y]) => {
  const v = window.__app.view;
  return [(x - v.cx) * v.s + v.w / 2, v.h / 2 - (y - v.cy) * v.s];
}, [x, y]);

const log = async () => (await page.locator('.cmd-log').innerText()).split('\n').slice(-3).join(' | ');

// 1) select the LINE (0,0)-(50,50) by clicking its midpoint
let [sx, sy] = await toScreen(25, 25);
await page.mouse.click(cv.x + sx, cv.y + sy);
await page.waitForTimeout(200);
console.log('selected:', await page.locator('.panel.props .section-title').first().innerText());

// 2) drag the end grip (50,50) to (60,40)
[sx, sy] = await toScreen(50, 50);
const [tx, ty] = await toScreen(60, 40);
await page.mouse.move(cv.x + sx, cv.y + sy);
await page.mouse.down();
await page.mouse.move(cv.x + tx, cv.y + ty, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(200);
await page.screenshot({ path: join(out, '70_grip_edit.png') });
const lineEnd = await page.evaluate(() => {
  const r = [...window.__app.selection][0];
  return r ? [r.type, r.point(11)] : null;
});
console.log('after grip:', JSON.stringify(lineEnd));

// 3) MOVE the circle by clicking base and target points
await page.keyboard.press('Escape');
[sx, sy] = await toScreen(35, 25); // on the circle (center 25,25 r10)
await page.mouse.click(cv.x + sx, cv.y + sy);
await page.keyboard.type('M');
await page.keyboard.press('Enter');
[sx, sy] = await toScreen(25, 25);
await page.mouse.move(cv.x + sx + 30, cv.y + sy + 30);
await page.keyboard.type('25,25'); await page.keyboard.press('Enter');
await page.keyboard.type('@40,0'); await page.keyboard.press('Enter');
await page.waitForTimeout(200);
console.log('after MOVE:', await log());

// 4) raw group edit: select the TEXT and change its contents through the group table
await page.evaluate(() => {
  const app = window.__app;
  const t = app.scene.items.find((g) => g.rec.type === 'TEXT').rec;
  app.select([t], 'replace');
});
await page.waitForTimeout(200);
const row = page.locator('.groups .grow', { has: page.locator('.gcode', { hasText: /^1$/ }) }).first();
const inp = row.locator('input.gval');
await inp.fill('Edited in browser ✓ Ä');
await inp.press('Enter');
await page.waitForTimeout(200);
console.log('text now:', await page.evaluate(() => window.__app.scene.items.find((g) => g.rec.type === 'TEXT').rec.get(1)));

// 5) change layer via properties select
await page.locator('.panel.props select.inp').first().selectOption('R12LAYER');
await page.waitForTimeout(200);
console.log('text layer:', await page.evaluate(() => window.__app.scene.items.find((g) => g.rec.type === 'TEXT').rec.layer));
await page.screenshot({ path: join(out, '71_after_edits.png') });

// 6) undo/redo the layer change
await page.keyboard.press('Escape');
await page.locator('canvas.viewport').click({ position: { x: 5, y: 5 } });
await page.keyboard.press('Control+z');
await page.waitForTimeout(100);
const afterUndo = await page.evaluate(() => window.__app.scene.items.find((g) => g.rec.type === 'TEXT').rec.layer);
await page.keyboard.press('Control+y');
await page.waitForTimeout(100);
const afterRedo = await page.evaluate(() => window.__app.scene.items.find((g) => g.rec.type === 'TEXT').rec.layer);
console.log('undo/redo layer:', afterUndo, afterRedo);

// 7) save
const dl = page.waitForEvent('download');
await page.locator('button', { hasText: 'Save DXF' }).click();
const file = await dl;
const saved = join(out, 'saved_' + file.suggestedFilename());
await file.saveAs(saved);
console.log('saved to', saved);

// 8) hatch gradient + zoom to selection
await page.selectOption('.toolbar-select', 'hatches.dxf');
await page.waitForTimeout(600);
await page.screenshot({ path: join(out, '72_hatches_gradient.png') });

console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
