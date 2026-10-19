// The Measure / Dimension toolbar dropdown: lists every entry, each starts its command.
// Usage: node scripts/browser_dimmenu_check.mjs <outDir> [baseUrl]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] ?? 'test-output/screens_dimmenu';
const base = process.argv[3] ?? 'http://localhost:5199/';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(base);
await page.waitForTimeout(1200);
await page.selectOption('.toolbar-select', 'ucs_dims.dxf');
await page.waitForTimeout(600);

const menu = page.locator('select[title="Measure & dimension"]');
console.log('measure button gone:', (await page.locator('button', { hasText: 'Measure distance' }).count()) === 0);
const groups = await menu.evaluate((s) => [...s.querySelectorAll('optgroup')].map((g) => `${g.label}: ${[...g.children].map((o) => o.textContent).join(', ')}`));
console.log(groups.join('\n'));
await page.screenshot({ path: join(out, 'toolbar.png'), clip: { x: 0, y: 0, width: 1600, height: 80 } });

// each entry starts its command (prompt appears), Esc cancels
for (const v of await menu.evaluate((s) => [...s.querySelectorAll('option')].map((o) => o.value).filter(Boolean))) {
  await menu.selectOption(v);
  await page.waitForTimeout(120);
  const prompt = await page.locator('.cmd-prompt').innerText();
  console.log(v.padEnd(12), '->', prompt);
  await page.keyboard.press('Escape');
  await page.locator('.cmd-input').press('Escape').catch(() => {});
  await page.waitForTimeout(60);
}

// DIMEDIT end to end: make a dimension, then change its label through the menu
await page.evaluate(() => { window.__app.snapOn = false; });
const type = async (...ts) => { for (const t of ts) { await page.keyboard.type(t); await page.keyboard.press('Enter'); await page.waitForTimeout(80); } };
await page.locator('canvas.viewport').click({ position: { x: 5, y: 5 } });
await page.keyboard.press('Escape');
await type('DIMLINEAR', '0,0', '120,0', '60,-15');
await page.evaluate(() => { const a = window.__app; a.select([a.scene.items.find((g) => g.rec.type === 'DIMENSION').rec], 'replace'); });
await menu.selectOption('DIMEDIT');
await page.waitForTimeout(100);
await page.locator('.cmd-input').fill('W = <>');
await page.locator('.cmd-input').press('Enter');
await page.waitForTimeout(150);
console.log('DIMEDIT label:', await page.evaluate(() => { const a = window.__app; const d = a.scene.items.find((g) => g.rec.type === 'DIMENSION').rec; return a.doc.block(d.str(2)).entities.find((e) => e.type === 'MTEXT').get(1); }));
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
