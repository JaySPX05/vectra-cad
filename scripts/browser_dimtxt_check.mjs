// Label height in headless Edge: Properties "Text height" on a selected dimension, multi-selection,
// and the DIMTXT command for new dimensions.
// Usage: node scripts/browser_dimtxt_check.mjs <outDir> [baseUrl]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] ?? 'test-output/screens_dimtxt';
const base = process.argv[3] ?? 'http://localhost:5199/';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !m.text().includes('404') && errors.push(m.text()));
await page.goto(base);
await page.waitForTimeout(1200);
const shot = (n) => page.screenshot({ path: join(out, n + '.png') });
const type = async (...ts) => {
  for (const t of ts) {
    await page.keyboard.type(t);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(80);
  }
};
const heights = () => page.evaluate(() => {
  const app = window.__app;
  return app.scene.items.filter((g) => g.rec.type === 'DIMENSION').map((g) => +app.doc.block(g.rec.str(2)).entities.find((e) => e.type === 'MTEXT').num(40, 0).toFixed(3));
});

await page.selectOption('.toolbar-select', 'ucs_dims.dxf');
await page.waitForTimeout(700);
await page.evaluate(() => { window.__app.snapOn = false; });
await type('DIMLINEAR', '0,0', '120,0', '60,-15');
await type('DIMLINEAR', '120,0', '120,80', '135,40');
console.log('auto heights:', JSON.stringify(await heights()));

// one dimension: Properties -> Text height 5
await page.evaluate(() => { const a = window.__app; a.select([a.scene.items.find((g) => g.rec.type === 'DIMENSION').rec], 'replace'); });
await page.waitForTimeout(150);
const field = page.locator('.prop-row', { hasText: 'Text height' }).locator('input');
await field.fill('5');
await field.press('Enter');
await page.waitForTimeout(150);
console.log('after Properties 5:', JSON.stringify(await heights()));
await shot('10_properties_height');

// both: multi-selection field
await page.evaluate(() => { const a = window.__app; a.select(a.scene.items.filter((g) => g.rec.type === 'DIMENSION').map((g) => g.rec), 'replace'); });
await page.waitForTimeout(150);
const multi = page.locator('.prop-row', { hasText: 'Text height' }).locator('input');
console.log('multi field shows:', JSON.stringify(await multi.inputValue()), 'placeholder', await multi.getAttribute('placeholder'));
await multi.fill('6');
await multi.press('Enter');
await page.waitForTimeout(150);
console.log('after multi 6:', JSON.stringify(await heights()));

// DIMTXT for new dimensions
await page.keyboard.press('Escape');
await page.locator('canvas.viewport').click({ position: { x: 5, y: 5 } });
await page.keyboard.press('Escape');
await type('DIMTXT', '4');
await type('DIMORDINATE', '100,60', '100,95');
console.log('after DIMTXT 4 + new ordinate:', JSON.stringify(await heights()));
await page.evaluate(() => window.__app.zoomExtents());
await page.waitForTimeout(150);
await shot('20_dimtxt_new');
await type('DIMTXT', 'Auto');
console.log('DIMTXT auto ->', (await page.locator('.cmd-log').innerText()).split('\n').slice(-1)[0]);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
