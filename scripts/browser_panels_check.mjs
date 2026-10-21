// Side panels in headless Edge: Properties pops up on selection (without resizing the drawing),
// × / Ctrl+1 / PROPERTIES, and the Layers column hides (button, «, Ctrl+2) and stays hidden after a reload.
// Usage: node scripts/browser_panels_check.mjs <outDir> [baseUrl]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] ?? 'test-output/screens_panels';
const base = process.argv[3] ?? 'http://localhost:5199/';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !m.text().includes('404') && errors.push(m.text()));
await page.goto(base);
await page.waitForTimeout(1200);
await page.selectOption('.toolbar-select', 'r12_legacy.dxf');
await page.waitForTimeout(600);

const props = page.locator('.panel.props');
const width = () => page.evaluate(() => window.__app.view.w);
const state = async () => `props ${(await props.isVisible()) ? 'shown' : 'hidden'}, canvas ${await width()} px`;
const toScreen = async (x, y) => page.evaluate(([x, y]) => {
  const v = window.__app.view;
  return [(x - v.cx) * v.s + v.w / 2, v.h / 2 - (y - v.cy) * v.s];
}, [x, y]);
const clickLine = async () => {
  const cv = await page.locator('canvas.viewport').boundingBox();
  const [sx, sy] = await toScreen(25, 25); // midpoint of the LINE (0,0)-(50,50)
  await page.mouse.click(cv.x + sx, cv.y + sy);
  await page.waitForTimeout(200);
};

console.log('1) loaded:', await state());
await page.screenshot({ path: join(out, '01_nothing_selected.png') });
await clickLine();
console.log('2) line clicked:', await state(), '|', await page.locator('.panel.props .section-title').first().innerText());
await page.screenshot({ path: join(out, '02_selected.png') });
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
console.log('3) Esc:', await state());

await clickLine();
await page.locator('.panel.props .panel-x').click();
await page.waitForTimeout(150);
console.log('4) × with selection kept:', await state(), '| selected', await page.evaluate(() => window.__app.selection.size));
await page.keyboard.press('Escape');
await clickLine();
console.log('5) new selection reopens:', await state());
await page.keyboard.press('Escape');

await page.locator('canvas.viewport').click({ position: { x: 5, y: 5 } });
await page.keyboard.press('Control+1');
await page.waitForTimeout(150);
console.log('6) Ctrl+1 pinned:', await state(), '|', await page.locator('.panel.props .section-title').first().innerText());
await page.keyboard.press('Control+1');
await page.waitForTimeout(150);
console.log('7) Ctrl+1 again:', await state());
for (const t of ['PR', '']) { await page.keyboard.type(t); await page.keyboard.press('Enter'); await page.waitForTimeout(100); }
console.log('8) PR command:', await state());
await page.locator('.toolbar .toggle', { hasText: 'Properties' }).click();
console.log('9) toolbar Properties unpins:', await state());

// explorer record -> inspector pops up, Esc closes it
await page.locator('.tab', { hasText: 'Tables' }).click();
await page.locator('.tree-item.link').first().click();
await page.waitForTimeout(150);
console.log('10) table entry inspected:', await state());
await page.locator('canvas.viewport').click({ position: { x: 5, y: 5 } });
await page.keyboard.press('Escape'); // cancels the window the click started
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
console.log('11) Esc:', await state());

const w0 = await width();
await page.locator('.panel.layers .panel-x').click();
await page.waitForTimeout(300);
const w1 = await width();
console.log(`12) « hides Layers: canvas ${w0} -> ${w1} px (+${w1 - w0}), visible: ${await page.locator('.side.left').isVisible()}`);
await page.screenshot({ path: join(out, '03_layers_hidden.png') });
await page.reload();
await page.waitForTimeout(1200);
console.log('13) after reload, Layers visible:', await page.locator('.side.left').isVisible(), '| canvas', await width());
await page.locator('canvas.viewport').click({ position: { x: 5, y: 5 } });
await page.keyboard.press('Control+2');
await page.waitForTimeout(300);
console.log('14) Ctrl+2:', await page.locator('.side.left').isVisible(), '| canvas', await width());
await page.keyboard.press('Control+2');
await page.waitForTimeout(300);
for (const t of ['LA', '']) { await page.keyboard.type(t); await page.keyboard.press('Enter'); await page.waitForTimeout(100); }
console.log('15) LA command shows Layers:', await page.locator('.side.left').isVisible());
await page.keyboard.press('Escape');

await browser.close();
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
