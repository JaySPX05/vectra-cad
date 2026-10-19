// Drive the app in headless Edge: load samples, run commands, take screenshots.
// Usage: node scripts/browser_check.mjs <outDir> [baseUrl]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] ?? 'test-output/screens';
const base = process.argv[3] ?? 'http://localhost:5199/';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

await page.goto(base);
await page.waitForTimeout(1500);
const shot = async (name) => page.screenshot({ path: join(out, name + '.png') });
const log = async () => (await page.locator('.cmd-log').innerText()).split('\n').slice(-4).join(' | ');

await shot('00_startup_example2018');
console.log('startup log:', await log());

const samples = ['basic_entities.dxf', 'text_mtext.dxf', 'blocks_inserts.dxf', 'hatches.dxf', 'dimensions_leaders.dxf', 'meshes_3d.dxf', 'r12_legacy.dxf', 'stress_20k.dxf', 'public/example_2000.dxf'];
for (const s of samples) {
  await page.selectOption('.toolbar-select', s);
  await page.waitForTimeout(s.startsWith('stress') ? 2500 : 900);
  await shot('10_' + s.replace(/[\\/]/g, '_').replace('.dxf', ''));
  console.log(s, '->', await log());
}

// interaction: open basic, select by click, inspect, run a MOVE via command line
await page.selectOption('.toolbar-select', 'basic_entities.dxf');
await page.waitForTimeout(800);
const box = await page.locator('canvas.viewport').boundingBox();
// window select over the left half
await page.mouse.move(box.x + 40, box.y + 40);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.45, box.y + box.height - 40, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(300);
await shot('20_window_selection');
console.log('props after window select:', (await page.locator('.panel.props .section-title').first().innerText()));

await page.keyboard.press('Escape');
// type a LINE command with coordinates
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
for (const t of ['LINE', '0,0', '@50,25', '@0,-25', '']) {
  await page.keyboard.type(t);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
}
console.log('after LINE:', await log());
await page.keyboard.type('CIRCLE'); await page.keyboard.press('Enter');
await page.keyboard.type('25,12'); await page.keyboard.press('Enter');
await page.keyboard.type('8'); await page.keyboard.press('Enter');
await page.waitForTimeout(200);
console.log('after CIRCLE:', await log());
// click on the new circle edge to select it and check properties
const pt = await page.evaluate(() => {
  const w = window; return null;
});
void pt;
await shot('30_after_draw');
// undo twice
await page.keyboard.press('Control+z');
await page.waitForTimeout(150);
console.log('after undo:', await log());
await shot('31_after_undo');

// select the first entity via Entities tab and inspect raw groups
await page.locator('.tab', { hasText: 'Entities' }).click();
await page.locator('.tree-item.link').first().click();
await page.waitForTimeout(300);
await shot('40_select_type');
console.log('selection title:', await page.locator('.panel.props .section-title').first().innerText());

// hover + grips: click a single entity in the middle region
await page.keyboard.press('Escape');
await page.selectOption('.toolbar-select', 'blocks_inserts.dxf');
await page.waitForTimeout(800);
await page.locator('.tab', { hasText: 'Entities' }).click();
await page.locator('.tree-item.link', { hasText: 'INSERT' }).click();
await page.waitForTimeout(300);
await shot('41_inserts_selected');
await page.keyboard.press('Escape');

// layers: toggle a layer off
await page.selectOption('.toolbar-select', 'basic_entities.dxf');
await page.waitForTimeout(600);
const rows = page.locator('.layer-row');
console.log('layers:', await rows.count());
await rows.nth(1).locator('.icon').nth(1).click();
await page.waitForTimeout(300);
await shot('50_layer_toggled');
console.log('after layer toggle:', await log());

// light theme
await page.locator('button.tbtn.toggle', { hasText: '◐' }).click();
await page.waitForTimeout(300);
await shot('60_light_theme');

console.log('\nCONSOLE ERRORS/WARNINGS:', errors.length ? '\n' + errors.join('\n') : 'none');
await browser.close();
