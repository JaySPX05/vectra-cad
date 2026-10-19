// UCS + dimensions in headless Edge: set a UCS origin by clicking, create every dimension type
// with clicks/typed input, grip-edit one, save, and report what was created.
// Usage: node scripts/browser_dims_check.mjs <outDir> [baseUrl]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] ?? 'test-output/screens_dims';
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
const cv = await page.locator('canvas.viewport').boundingBox();
/** Screen position of a WCS point. */
const at = async (p) => {
  const [x, y] = await page.evaluate((p) => window.__app.toScreen([p[0], p[1], p[2] ?? 0]), p);
  return [cv.x + x, cv.y + y];
};
const click = async (p) => {
  const [x, y] = await at(p);
  await page.mouse.move(x - 3, y - 3);
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
  await page.waitForTimeout(80);
};
const type = async (...ts) => {
  for (const t of ts) {
    await page.keyboard.type(t);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(80);
  }
};

await page.selectOption('.toolbar-select', 'ucs_dims.dxf');
await page.waitForTimeout(800);
console.log('opened with UCS:', await page.evaluate(() => [window.__app.ucs.name, window.__app.ucs.origin]));
await shot('00_part_ucs');

// UCS origin by clicking the centre of the lower-left hole (snaps to centre), Enter to accept
await type('UCS');
await click([220 + 6, 120]); // on the hole's edge -> centre/quadrant snaps nearby; snap picks the best
const snapped = await page.evaluate(() => window.__app.snap);
await page.mouse.move(...(await at([220, 120])));
await page.waitForTimeout(50);
console.log('snap while picking origin:', JSON.stringify(snapped));
await page.keyboard.press('Enter');
await page.waitForTimeout(100);
console.log('UCS now:', JSON.stringify(await page.evaluate(() => window.__app.ucs.origin)), '|', await log(1));
await shot('10_new_ucs_origin');

// back to the part corner UCS via typed coordinates (UCS coordinates relative to the current one)
await type('UCS', '-26,-20', '');
console.log('UCS after typed origin:', JSON.stringify(await page.evaluate(() => window.__app.ucs.origin)));

await page.evaluate(() => { window.__app.snapOn = false; });
// ordinate X of the right holes (x = 100 from the corner), leader upward
await type('DIMORDINATE', '100,60', '100,95');
// ordinate Y of the top holes, leader to the right
await type('DIMORDINATE', '100,60', '140,60');
// linear: overall width, typed in UCS
await type('DIMLINEAR', '0,0', '120,0', '60,-15');
// vertical linear: height (cursor beside the points)
await type('DIMLINEAR', '120,0', '120,80', '135,40');
// aligned: the slanted line
await type('DIMALIGNED', '120,80', '150,110', '125,105');
console.log('after linear/ordinate:', await log(3));

// radius of a small hole: select it by clicking its edge, then place the label
await type('DIMRADIUS');
await click([200 + 20 + 6, 100 + 60]);
await type('-15,75');
// diameter of the big hole
await type('DIMDIAMETER');
await click([200 + 60 + 15, 100 + 40]);
await type('85,50');
// angular on the arc (slot)
await type('DIMANGULAR');
await click([200 + 60, 100 + 80 - 10]);
await type('60,60');
// angular between two lines: the slanted line and the plate's top edge (a polyline isn't a LINE -> use vertex mode)
await type('DIMANGULAR', '', '120,80', '150,80', '150,110', '145,90');
console.log('after radial/angular:', await log(4));
await page.locator('.toolbar select').filter({ hasText: 'Samples' }).first().evaluate(() => {});
await page.evaluate(() => window.__app.zoomExtents());
await page.waitForTimeout(200);
await shot('20_all_dimensions');

const dims = await page.evaluate(() => {
  const app = window.__app;
  return app.scene.items.filter((g) => g.rec.type === 'DIMENSION').map((g) => {
    const blk = app.doc.block(g.rec.str(2));
    const t = blk.entities.find((e) => e.type === 'MTEXT');
    return [g.rec.num(70, 0) & 7, +g.rec.num(42, 0).toFixed(4), t ? t.get(1) : null];
  });
});
console.log('dimensions:', JSON.stringify(dims));

// grip-drag the second extension origin of the width dimension to x = 100
const res = await page.evaluate(() => {
  const app = window.__app;
  const d = app.scene.items.find((g) => g.rec.type === 'DIMENSION' && (g.rec.num(70, 0) & 7) === 0 && Math.abs(g.rec.num(42, 0) - 120) < 1e-6).rec;
  app.select([d], 'replace');
  return { p14: d.point(14), h: d.handle };
});
await page.waitForTimeout(150);
const [gx, gy] = await at(res.p14);
const [tx, ty] = await at([300, 100, 0]);
await page.mouse.move(gx, gy);
await page.mouse.down();
await page.mouse.move(tx, ty, { steps: 6 });
await shot('30_dim_grip_preview');
await page.mouse.up();
await page.waitForTimeout(150);
console.log('after grip:', JSON.stringify(await page.evaluate((h) => {
  const d = window.__app.doc.byHandle(h);
  return [d.num(42, 0), window.__app.doc.block(d.str(2)).entities.find((e) => e.type === 'MTEXT').get(1)];
}, res.h)));
await shot('31_after_grip');

// properties text override
await page.locator('.prop-row', { hasText: 'Text override' }).locator('input').fill('W = <>');
await page.locator('.prop-row', { hasText: 'Text override' }).locator('input').press('Enter');
await page.waitForTimeout(150);
console.log('override label:', await page.evaluate((h) => window.__app.doc.block(window.__app.doc.byHandle(h).str(2)).entities.find((e) => e.type === 'MTEXT').get(1), res.h));
await page.keyboard.press('Escape');
await shot('40_override');

const dl = page.waitForEvent('download');
await page.locator('button', { hasText: 'Save DXF' }).click();
const file = await dl;
await file.saveAs(join(out, 'saved_ucs_dims.dxf'));
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
