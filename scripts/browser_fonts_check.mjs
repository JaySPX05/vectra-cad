// Roman S text and auto-sized dimension labels in headless Edge.
// Usage: node scripts/browser_fonts_check.mjs <outDir> [baseUrl]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] ?? 'test-output/screens_fonts';
const base = process.argv[3] ?? 'http://localhost:5199/';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !m.text().includes('404') && errors.push(m.text()));
await page.goto(base);
await page.waitForTimeout(1200);
const shot = (n) => page.screenshot({ path: join(out, n + '.png') });
const log = async (n = 2) => (await page.locator('.cmd-log').innerText()).split('\n').slice(-n).join(' | ');
const type = async (...ts) => {
  for (const t of ts) {
    await page.keyboard.type(t);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(80);
  }
};

for (const f of ['text_mtext.dxf', 'dimensions_leaders.dxf', 'blocks_inserts.dxf']) {
  await page.selectOption('.toolbar-select', f);
  await page.waitForTimeout(700);
  console.log(f, '->', await log(2));
  await shot('00_' + f.replace('.dxf', ''));
}

// dimensions on the plate: labels auto-sized from the drawing extent
await page.selectOption('.toolbar-select', 'ucs_dims.dxf');
await page.waitForTimeout(700);
await page.evaluate(() => { window.__app.snapOn = false; });
await type('DIMLINEAR', '0,0', '120,0', '60,-15');
await type('DIMLINEAR', '120,0', '120,80', '135,40');
await type('DIMORDINATE', '100,60', '100,95');
await type('DIMRADIUS');
const cv = await page.locator('canvas.viewport').boundingBox();
const [x, y] = await page.evaluate(() => window.__app.toScreen([226, 160, 0]));
await page.mouse.move(cv.x + x - 2, cv.y + y);
await page.mouse.click(cv.x + x, cv.y + y);
await type('-15,75');
await type('DIMSCALE', ''); // report the auto value
console.log('auto scale ->', await log(1));
const sizes = await page.evaluate(() => {
  const app = window.__app;
  return app.scene.items.filter((g) => g.rec.type === 'DIMENSION').map((g) => {
    const t = app.doc.block(g.rec.str(2)).entities.find((e) => e.type === 'MTEXT');
    return [t.get(1), +t.num(40, 0).toFixed(3)];
  });
});
console.log('labels (text, height):', JSON.stringify(sizes));
await page.evaluate(() => window.__app.zoomExtents());
await page.waitForTimeout(200);
await shot('10_plate_dims_auto');

// a big drawing: the stress sample spans ~2000 units
await page.selectOption('.toolbar-select', 'basic_entities.dxf');
await page.waitForTimeout(700);
await type('-DIMSTYLE', 'Standard');
await type('DIMLINEAR', '0,0', '100,0', '50,-20');
await type('DIMALIGNED', '0,60', '100,60', '50,75');
console.log('basic dims ->', await log(1), JSON.stringify(await page.evaluate(() => {
  const app = window.__app;
  return app.scene.items.filter((g) => g.rec.type === 'DIMENSION').map((g) => app.doc.block(g.rec.str(2)).entities.find((e) => e.type === 'MTEXT').num(40, 0));
})));
await shot('20_basic_dims');

// ROMANS OFF shows original fonts, ON again
await page.selectOption('.toolbar-select', 'text_mtext.dxf');
await page.waitForTimeout(600);
await type('ROMANS', 'OFF');
await shot('30_romans_off');
await type('ROMANS', 'ON');
await shot('31_romans_on');
console.log('romans toggle ->', await log(2));

const dl = page.waitForEvent('download');
await page.locator('button', { hasText: 'Save DXF' }).click();
await (await dl).saveAs(join(out, 'saved_text_mtext.dxf'));
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
