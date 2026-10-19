// DWG opening in headless Edge: Samples menu, file picker and drag & drop; then save as DXF.
// Usage: node scripts/browser_dwg_check.mjs <outDir> [baseUrl] [extra.dwg ...]
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const [out = 'test-output/screens_dwg', base = 'http://localhost:5199/', ...extra] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !m.text().includes('404') && errors.push(m.text()));
await page.goto(base);
await page.waitForTimeout(1200);
const log = async (n = 3) => (await page.locator('.cmd-log').innerText()).split('\n').slice(-n).join(' | ');
const waitLoaded = (name) => page.waitForFunction((n) => document.querySelector('.cmd-log')?.textContent?.includes(`Opened ${n}`) || /could not convert this|not a DWG|not supported/.test(document.querySelector('.cmd-log')?.lastElementChild?.textContent ?? ''), name, { timeout: 60000 });
const info = () => page.evaluate(() => ({ file: window.__app.fileName, version: window.__app.doc.version, entities: window.__app.scene.items.length }));

// 1) Samples menu
const t0 = Date.now();
await page.selectOption('.toolbar-select', 'public/example_2018.dwg');
await waitLoaded('example_2018.dwg');
console.log('sample 2018 DWG:', JSON.stringify(await info()), `${Date.now() - t0} ms |`, await log(4));
await page.screenshot({ path: join(out, '00_dwg_2018.png') });

// 2) file picker with the 2004 DWG
const chooser = page.waitForEvent('filechooser');
await page.locator('button', { hasText: 'Open' }).first().click();
await (await chooser).setFiles(join('public', 'samples', 'public', 'example_2004.dwg'));
await waitLoaded('example_2004.dwg');
console.log('picker 2004 DWG:', JSON.stringify(await info()), '|', await log(2));
await page.screenshot({ path: join(out, '10_dwg_2004.png') });

// 3) drag & drop of any extra DWGs given on the command line
for (const f of extra) {
  const data = [...readFileSync(f)];
  const name = basename(f);
  const handle = await page.evaluateHandle(({ data, name }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(data)], name));
    return dt;
  }, { data, name });
  await page.dispatchEvent('.viewport-wrap', 'drop', { dataTransfer: handle });
  await waitLoaded(name);
  console.log('dropped', name, JSON.stringify(await info()), '|', await log(1));
}

// 4) a broken file reports an error instead of crashing
const bad = await page.evaluateHandle(() => {
  const dt = new DataTransfer();
  dt.items.add(new File([new TextEncoder().encode('AC1032 this is not really a drawing')], 'broken.dwg'));
  return dt;
});
await page.dispatchEvent('.viewport-wrap', 'drop', { dataTransfer: bad });
await page.waitForTimeout(3000);
console.log('broken.dwg ->', await log(1));

// 5) save writes DXF
const dl = page.waitForEvent('download');
await page.locator('button', { hasText: 'Save DXF' }).click();
const file = await dl;
await file.saveAs(join(out, 'saved_' + file.suggestedFilename()));
console.log('saved as', file.suggestedFilename());
console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
await browser.close();
