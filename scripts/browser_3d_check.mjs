// 3D viewing in headless Edge: saved view, presets, visual styles, orbit, grip edit in iso, save.
// Usage: node scripts/browser_3d_check.mjs <outDir> [baseUrl]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] ?? 'test-output/screens3d';
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
const log = async () => (await page.locator('.cmd-log').innerText()).split('\n').slice(-2).join(' | ');
const viewName = () => page.locator('select[title^="View direction"]').evaluate((s) => s.options[s.selectedIndex].text);

await page.selectOption('.toolbar-select', 'house_3d.dxf');
await page.waitForTimeout(800);
console.log('opened in view:', await viewName(), '|', await log());
await shot('00_house_saved_view');

const styleSel = page.locator('select[title^="Visual style"]');
for (const st of ['hidden', 'shaded', 'shadedEdges', 'wireframe']) {
  await styleSel.selectOption(st);
  await page.waitForTimeout(300);
  await shot('10_style_' + st);
}
await styleSel.selectOption('shadedEdges');

const viewSel = page.locator('select[title^="View direction"]');
for (const [i, n] of [[0, 'top'], [2, 'front'], [5, 'right'], [8, 'ne_iso']]) {
  await viewSel.selectOption(String(i));
  await page.waitForTimeout(300);
  await shot('20_view_' + n);
}

// orbit with shift + middle drag from SW iso
await viewSel.selectOption('6');
await page.waitForTimeout(200);
const cv = await page.locator('canvas.viewport').boundingBox();
const cx = cv.x + cv.width / 2, cy = cv.y + cv.height / 2;
await page.keyboard.down('Shift');
await page.mouse.move(cx, cy);
await page.mouse.down({ button: 'middle' });
await page.mouse.move(cx + 120, cy - 60, { steps: 10 });
await page.mouse.up({ button: 'middle' });
await page.keyboard.up('Shift');
await page.waitForTimeout(300);
console.log('after orbit view:', await viewName(), JSON.stringify(await page.evaluate(() => window.__app.viewDirection.map((v) => +v.toFixed(3)))));
await shot('30_orbited');

// typed commands
for (const t of ['VIEW', 'SEiso']) { await page.keyboard.type(t); await page.keyboard.press('Enter'); await page.waitForTimeout(100); }
console.log('VIEW cmd ->', await viewName());
for (const t of ['VS', 'H']) { await page.keyboard.type(t); await page.keyboard.press('Enter'); await page.waitForTimeout(100); }
console.log('VS cmd ->', await styleSel.inputValue());

// grip edit of a 3DFACE corner in SW iso: drag the right wall's top-back corner (40,30,20) up by snapping? move within its plane z=20
await viewSel.selectOption('6');
await styleSel.selectOption('wireframe');
await page.waitForTimeout(200);
const res = await page.evaluate(() => {
  const app = window.__app;
  const face = app.scene.items.find((g) => g.rec.type === '3DFACE' && g.rec.point(10)[0] === 40 && g.rec.point(11)[1] === 30);
  app.select([face.rec], 'replace');
  return { handle: face.rec.handle, p12: face.rec.point(12) };
});
await page.waitForTimeout(200);
const scr = async (p) => page.evaluate((p) => window.__app.toScreen(p), p);
const [gx, gy] = await scr(res.p12);
const [tx, ty] = await scr([res.p12[0] + 10, res.p12[1], res.p12[2]]);
await page.evaluate(() => { window.__app.snapOn = false; });
await page.mouse.move(cv.x + gx, cv.y + gy);
await page.mouse.down();
await page.mouse.move(cv.x + tx, cv.y + ty, { steps: 8 });
await shot('40_grip_drag_preview');
await page.mouse.up();
await page.waitForTimeout(200);
const p12 = await page.evaluate((h) => window.__app.doc.byHandle(h).point(12), res.handle);
console.log('3DFACE corner before', JSON.stringify(res.p12), 'after', JSON.stringify(p12.map((v) => +v.toFixed(3))));
await shot('41_after_grip');

// draw a circle in iso view by clicking: it lands on the Z=0 plane
await page.keyboard.press('Escape');
await page.keyboard.type('CIRCLE'); await page.keyboard.press('Enter');
const [c0x, c0y] = await scr([60, 40, 0]);
await page.mouse.click(cv.x + c0x, cv.y + c0y);
await page.keyboard.type('5'); await page.keyboard.press('Enter');
await page.waitForTimeout(200);
const circle = await page.evaluate(() => {
  const r = window.__app.scene.items[window.__app.scene.items.length - 1].rec;
  return [r.type, r.point(10).map((v) => +v.toFixed(3)), r.num(40, 0)];
});
console.log('circle drawn in iso view:', JSON.stringify(circle));
await shot('50_circle_in_iso');

// front view is edge-on to XY: clicking should warn, typed coordinates should work
await viewSel.selectOption('2');
await page.keyboard.type('LINE'); await page.keyboard.press('Enter');
await page.mouse.click(cx, cy);
await page.waitForTimeout(100);
console.log('edge-on click:', await log());
await page.keyboard.press('Escape');

const dl = page.waitForEvent('download');
await page.locator('button', { hasText: 'Save DXF' }).click();
const file = await dl;
await file.saveAs(join(out, 'saved_house_3d.dxf'));
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
