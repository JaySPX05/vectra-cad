// Dynamic label height in headless Edge: DIMDYN, dimensions of different sizes, grip drag, Properties.
// Usage: node scripts/browser_dimdyn_check.mjs <outDir> [baseUrl]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] ?? 'test-output/screens_dimdyn';
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
const labels = () => page.evaluate(() => {
  const app = window.__app;
  return app.scene.items.filter((g) => g.rec.type === 'DIMENSION').map((g) => {
    const t = app.doc.block(g.rec.str(2)).entities.find((e) => e.type === 'MTEXT');
    return [t.get(1), +t.num(40, 0).toFixed(3)];
  });
});
const cv = await page.locator('canvas.viewport').boundingBox();
const clickW = async (p) => {
  const [x, y] = await page.evaluate((p) => window.__app.toScreen([p[0], p[1], 0]), p);
  await page.mouse.move(cv.x + x - 2, cv.y + y);
  await page.mouse.click(cv.x + x, cv.y + y);
  await page.waitForTimeout(80);
};

await page.selectOption('.toolbar-select', 'ucs_dims.dxf');
await page.waitForTimeout(700);
await page.evaluate(() => { window.__app.snapOn = false; });
// dynamic: 8 %, limits 1..12, rounded (via the menu entry)
await page.locator('select[title="Measure & dimension"]').selectOption('DIMDYN');
await page.waitForTimeout(80);
await type('8', '1', '12', 'Yes');
console.log('DIMDYN ->', (await page.locator('.cmd-log').innerText()).split('\n').slice(-1)[0]);

await type('DIMLINEAR', '0,0', '120,0', '60,-15'); // 120 -> 9.6 -> 10
await type('DIMLINEAR', '120,0', '120,80', '140,40'); // 80 -> 6.4 -> 7
await type('DIMDIAMETER'); await clickW([275, 140]); await type('85,50'); // 30 -> 2.4 -> 2.5
await type('DIMRADIUS'); await clickW([226, 160]); await type('-15,75'); // 6 -> 0.48 -> min 1
await type('DIMORDINATE', '100,60', '100,100'); // leader 40 -> 3.2 -> 3.5
console.log('labels (text, height):', JSON.stringify(await labels()));
await page.evaluate(() => window.__app.zoomExtents());
await page.waitForTimeout(200);
await shot('10_dynamic_labels');

// grip-drag the 120 dimension down to 40 -> label shrinks to 3.5
const h = await page.evaluate(() => {
  const a = window.__app;
  const d = a.scene.items.find((g) => g.rec.type === 'DIMENSION' && Math.abs(g.rec.num(42, 0) - 120) < 1e-6).rec;
  a.select([d], 'replace');
  return { p14: d.point(14), h: d.handle };
});
await page.waitForTimeout(150);
const [gx, gy] = await page.evaluate((p) => window.__app.toScreen(p), h.p14);
const [tx, ty] = await page.evaluate(() => window.__app.toScreen([240, 100, 0]));
await page.mouse.move(cv.x + gx, cv.y + gy);
await page.mouse.down();
await page.mouse.move(cv.x + tx, cv.y + ty, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(200);
console.log('after grip to 40:', JSON.stringify(await page.evaluate((hd) => {
  const a = window.__app; const d = a.doc.byHandle(hd);
  return [+d.num(42, 0).toFixed(2), a.doc.block(d.str(2)).entities.find((e) => e.type === 'MTEXT').num(40, 0)];
}, h.h)));
const propRows = await page.locator('.panel.props .prop-row').allInnerTexts();
console.log('properties:', JSON.stringify(propRows.filter((t) => /Dynamic|height|ratio/i.test(t))));
await shot('20_after_grip_properties');

// Properties: ratio 15 % -> 40 * 0.15 = 6 -> 5 (nearest standard on a log scale)
const ratio = page.locator('.prop-row', { hasText: 'Height ratio' }).locator('input');
await ratio.fill('15');
await ratio.press('Enter');
await page.waitForTimeout(150);
console.log('after ratio 15%:', JSON.stringify(await page.evaluate((hd) => {
  const a = window.__app; const d = a.doc.byHandle(hd);
  return a.doc.block(d.str(2)).entities.find((e) => e.type === 'MTEXT').num(40, 0);
}, h.h)));
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
