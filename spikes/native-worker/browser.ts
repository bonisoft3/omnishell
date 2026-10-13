import { chromium } from 'npm:playwright@1.61.1';
import assert from 'node:assert/strict';
import fixture from './.generated/fixture.json' with { type: 'json' };
const browser = await chromium.launch();
const url = 'https://127.0.0.1:20220/equipe-campeonato/flamengo-rj/brazil-campeonato-brasileiro-2026';
try {
  const staticContext = await browser.newContext({ javaScriptEnabled: false, ignoreHTTPSErrors: true, serviceWorkers: 'block' });
  const staticPage = await staticContext.newPage();
  await staticPage.goto(url);
  const h1 = await staticPage.locator('.team-membership-heading h1').innerText();
  assert.match(h1, /Flamengo/);
  const links = await staticPage.locator('a[href]').count();
  assert.ok(links > 20);
  assert.ok(await staticPage.locator('.position-odds-graph svg').count());
  const title = await staticPage.title();
  assert.notEqual(title, 'Loading…');
  await staticContext.close();
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', locale: 'pt-BR' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/shell/boot.js', async route => { await gate; await route.continue(); });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-served] .team-membership-heading h1').waitFor();
  await page.evaluate(() => {
    globalThis.spikeHeading = document.querySelector('.team-membership-heading h1');
    globalThis.spikeRows = [...document.querySelectorAll('.team-membership [data-id]')];
    globalThis.spikeRowInfo = globalThis.spikeRows.map(node => ({ id: node.dataset.id, table: node.closest('[data-live]')?.getAttribute('data-live') }));
  });
  release();
  await page.waitForFunction(() => document.querySelector('.shell-screen:not([data-served]) .position-odds-graph svg'), { timeout: 45000 });
  const adopted = await page.evaluate(() => ({
    heading: globalThis.spikeHeading === document.querySelector('.team-membership-heading h1'),
    retainedRows: globalThis.spikeRows.filter(node => node.isConnected).length,
    totalRows: globalThis.spikeRows.length,
    removed: globalThis.spikeRows.flatMap((node, index) => node.isConnected ? [] : [globalThis.spikeRowInfo[index]]),
  }));
  console.log(JSON.stringify({ noJavaScript: { h1, title, links }, adopted, errors }));
  assert.ok(adopted.heading);
  // Tab-derived chart inputs may be rebuilt when the browser takes ownership;
  // persisted football rows and the heading must be adopted in place.
  for (const row of adopted.removed) assert.equal(fixture.cfg.schema[row.table]?.durability, 'tab');
  assert.deepEqual(errors, []);
  await context.close();
} finally { await browser.close(); }
