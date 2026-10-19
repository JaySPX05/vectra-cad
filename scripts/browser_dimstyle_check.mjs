// Dimension Style Manager end to end in headless Edge: open from the menu, New from Standard,
// change settings on every tab (preview screenshots), OK; existing dimensions update; Set Current,
// Override, Compare, Rename, Delete (refused while in use), undo; then save for ezdxf validation.
// Usage: node scripts/browser_dimstyle_check.mjs <outDir> [baseUrl]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] ?? 'test-output/screens_dimstyle';
const base = process.argv[3] ?? 'http://localhost:5199/';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('response', (r) => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${r.url()}`));
await page.goto(base);
await page.waitForTimeout(1200);
await page.selectOption('.toolbar-select', 'ucs_dims.dxf');
await page.waitForTimeout(600);
const wait = (ms = 120) => page.waitForTimeout(ms);
const log = (n = 1) => page.evaluate((n) => [...document.querySelectorAll('.cmd-line')].slice(-n).map((e) => e.textContent).join(' | '), n);
const dims = () => page.evaluate(() => {
  const a = window.__app;
  return a.doc.entities.filter((e) => e.type === 'DIMENSION').map((e) => ({ style: e.str(3), block: e.str(2) }));
});
const blockInfo = (name) => page.evaluate((name) => {
  const b = window.__app.doc.block(name);
  return b.entities.map((e) => `${e.type}${e.has(62) ? ':' + e.num(62, 0) : ''}`).join(' ');
}, name);

// a dimension on the current style to watch
await page.evaluate(() => { window.__app.snapOn = false; });
await page.locator('canvas.viewport').click({ position: { x: 5, y: 5 } });
await page.keyboard.press('Escape');
for (const t of ['DIMLINEAR', '0,0', '120,0', '60,-15']) { await page.keyboard.type(t); await page.keyboard.press('Enter'); await wait(80); }
const before = await dims();
console.log('dimensions:', before.length, 'styles used:', [...new Set(before.map((d) => d.style))].join(','));

// 1) open from the Measure / Dimension menu
await page.locator('select[title="Measure & dimension"]').selectOption('DIMSTYLE');
await wait(300);
const mgr = page.locator('.ds-manager-modal');
console.log('manager open:', await mgr.isVisible(), '|', await mgr.locator('.ds-current').innerText());
console.log('styles:', (await mgr.locator('.ds-item').allInnerTexts()).join(', '));
await page.screenshot({ path: join(out, '1_manager.png') });

// 2) New… from Standard
await mgr.locator('.ds-item[data-name="Standard"]').click();
await mgr.locator('button', { hasText: 'New…' }).click();
await wait();
await page.locator('[aria-label="New Style Name"]').fill('Arch-50');
await page.locator('button', { hasText: 'Continue' }).click();
await wait(300);
const ed = page.locator('.ds-edit-modal');
console.log('editor title:', await ed.locator('.modal-title').innerText());
const tab = async (t) => { await ed.locator(`.ds-tab[data-tab="${t}"]`).click(); await wait(80); };
const shot = async (n) => ed.screenshot({ path: join(out, n) });

await tab('Lines');
await ed.locator('[aria-label="Color"]').first().click();
await page.locator('.popover button[title="ACI 1"]').click();
await ed.locator('label.ds-check', { hasText: 'Suppress ext line 1' }).locator('input').check();
await ed.locator('[aria-label="Extend beyond dim lines"]').fill('2');
await shot('2_lines.png');

await tab('Symbols and Arrows');
await ed.locator('[aria-label="First arrowhead"]').selectOption('_ARCHTICK');
await ed.locator('[aria-label="Arrow size"]').fill('4');
await shot('3_arrows.png');

await tab('Text');
await ed.locator('[aria-label="Text height"]').fill('5');
await ed.locator('[aria-label="Vertical"]').selectOption('1');
await ed.locator('label.ds-check', { hasText: 'Draw frame around text' }).locator('input').check();
await ed.locator('label.ds-check', { hasText: 'ISO standard' }).locator('input').check();
await shot('4_text.png');

await tab('Fit');
await ed.locator('[aria-label="Use overall scale of"]').fill('1');
await shot('5_fit.png');

await tab('Primary Units');
await ed.locator('[aria-label="Unit format"]').first().selectOption('2');
await ed.locator('[aria-label="Precision"]').first().selectOption('1');
await ed.locator('[aria-label="DIMPOST suffix"]').fill(' mm');
await shot('6_units.png');

await tab('Alternate Units');
await ed.locator('label.ds-check', { hasText: 'Display alternate units' }).locator('input').check();
await shot('7_alt.png');
await ed.locator('label.ds-check', { hasText: 'Display alternate units' }).locator('input').uncheck();

await tab('Tolerances');
await ed.locator('[aria-label="Tolerance method"]').selectOption('dev');
await ed.locator('[aria-label="Upper value"]').fill('0.2');
await ed.locator('[aria-label="Lower value"]').fill('0.1');
await shot('8_tol.png');
await ed.locator('[aria-label="Tolerance method"]').selectOption('none');
await ed.locator('button', { hasText: 'OK' }).click();
await wait(300);
console.log('after New:', await log(1));
console.log('styles:', (await mgr.locator('.ds-item').allInnerTexts()).join(', '));
console.log('Arch-50 record:', await page.evaluate(() => {
  const r = window.__app.doc.tableEntry('DIMSTYLE', 'Arch-50');
  return r ? [176, 75, 44, 41, 140, 77, 147, 73, 74, 271, 3, 343, 342, 173].map((c) => `${c}=${r.get(c) ?? '-'}`).join(' ') : 'missing';
}));
await page.screenshot({ path: join(out, '9_manager_new.png') });

// 3) Set Current, then a new dimension uses it
await mgr.locator('.ds-item[data-name="Arch-50"]').click();
await mgr.locator('button', { hasText: 'Set Current' }).click();
await wait();
console.log('current now:', await mgr.locator('.ds-current').innerText());

// 4) Modify the style of the existing dimension; it regenerates
const watched = before[before.length - 1];
await mgr.locator(`.ds-item[data-name="${watched.style}"]`).click();
const blk0 = await blockInfo(watched.block);
await mgr.locator('button', { hasText: 'Modify…' }).click();
await wait(300);
await tab('Lines');
await ed.locator('[aria-label="Color"]').nth(1).click(); // extension line colour
await page.locator('.popover button[title="ACI 3"]').click();
await tab('Symbols and Arrows');
await ed.locator('[aria-label="First arrowhead"]').selectOption('_DOT');
await ed.locator('button', { hasText: 'OK' }).click();
await wait(300);
console.log('after Modify:', await log(1));
const after = await dims();
const blk1 = await blockInfo(after[after.length - 1].block);
console.log('watched dim block changed:', blk0 !== blk1, '\n  before:', blk0, '\n  after: ', blk1);

// 5) Delete refused while in use; Compare; Rename
await mgr.locator('.ds-item[data-name="Arch-50"]').click();
console.log('Delete disabled for the current style:', await mgr.locator('button', { hasText: 'Delete' }).isDisabled());
await mgr.locator('button', { hasText: 'Compare…' }).click();
await wait(200);
const cmp = page.locator('.ds-compare-modal');
await cmp.locator('[aria-label="With"]').selectOption('Standard');
await wait(100);
console.log('compare:', (await cmp.locator('.ds-compare p').innerText()), '| rows', await cmp.locator('tbody tr').count());
await cmp.screenshot({ path: join(out, '10_compare.png') });
await cmp.locator('button', { hasText: 'Close' }).click();
await mgr.locator('button', { hasText: 'Rename…' }).click();
await page.locator('[aria-label="New name"]').fill('Arch-100');
await page.locator('button', { hasText: 'Continue' }).click();
await wait(200);
console.log('after rename:', await mgr.locator('.ds-current').innerText());

// 6) Override… the current style -> <style overrides>
await mgr.locator('button', { hasText: 'Override…' }).click();
await wait(300);
await tab('Text');
await ed.locator('[aria-label="Text height"]').fill('8');
await ed.locator('button', { hasText: 'OK' }).click();
await wait(200);
console.log('overrides item:', await mgr.locator('.ds-override').count(), '|', await mgr.locator('.ds-desc').innerText());
await page.screenshot({ path: join(out, '11_override.png') });
await mgr.locator('.modal-buttons button', { hasText: 'Close' }).click();
await wait(100);
console.log('manager closed:', (await page.locator('.modal-back').count()) === 0);

// 7) a new dimension: Arch-100 + DIMTXT 8 override
await page.locator('canvas.viewport').click({ position: { x: 5, y: 5 } });
await page.keyboard.press('Escape');
for (const t of ['DIMLINEAR', '0,40', '80,40', '40,60']) { await page.keyboard.type(t); await page.keyboard.press('Enter'); await wait(80); }
console.log('new dim:', await page.evaluate(() => {
  const a = window.__app;
  const d = a.doc.entities.filter((e) => e.type === 'DIMENSION').at(-1);
  const m = a.doc.block(d.str(2)).entities.find((e) => e.type === 'MTEXT');
  const xd = d.groups.filter((g) => g.code >= 1000).map((g) => g.value).join(',');
  return `style=${d.str(3)} label=${m.get(1)} h=${m.num(40, 0)} xdata=${xd}`;
}));
await page.evaluate(() => window.__app.zoomExtents());
await wait(300);
await page.screenshot({ path: join(out, '12_drawing.png') });

// 8) undo the whole lot step by step restores the original style table
const undoSteps = await page.evaluate(() => {
  const a = window.__app;
  let n = 0;
  while (a.editor.history.undo()) n++;
  return n;
});
console.log('undone steps:', undoSteps, '| styles now:', await page.evaluate(() => window.__app.doc.table('DIMSTYLE').entries.map((e) => e.str(2)).join(',')));
await page.evaluate(() => { const a = window.__app; while (a.editor.history.redo()); });

// 9) Properties "Edit style…" opens the manager on the dimension's style
await page.evaluate(() => { const a = window.__app; a.select([a.doc.entities.filter((e) => e.type === 'DIMENSION').at(-1)], 'replace'); });
await wait(200);
await page.locator('button', { hasText: 'Edit style…' }).click();
await wait(200);
console.log('from Properties, selected:', await page.locator('.ds-item.sel').innerText());
await page.keyboard.press('Escape');
await wait(100);
console.log('Esc closes:', (await page.locator('.modal-back').count()) === 0);

// 10) save
const dl = page.waitForEvent('download');
await page.locator('button', { hasText: 'Save DXF' }).click();
const file = await dl;
const saved = join(out, 'saved_' + file.suggestedFilename());
await file.saveAs(saved);
console.log('saved:', saved);
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
