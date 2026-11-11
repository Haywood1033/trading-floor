// Browser tests: drive the real app in headless Chromium against the committed price history.
// Run with `npm run e2e` (needs Playwright and Chromium: see .github/workflows/test.yml).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

let server, base, browser;
before(async () => {
  // Static files like Vercel serves them; no API, so the app runs in "this browser only" mode.
  server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.startsWith('/api/')) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"not-configured"}'); return; }
    const file = normalize(join(ROOT, path === '/' ? 'app/index.html' : path));
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    try { const body = await readFile(file); res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' }); res.end(body); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => { await browser?.close(); server?.close(); });

async function open(opts = {}) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(base + '/');
  await page.waitForSelector('[data-panel="queue"]', { timeout: 30000 });
  return { ctx, page, errors };
}
const firstApprove = page => page.locator('[data-act="approve"]:not([disabled])').first();

test('a new fund opens at a real close with the quants\' proposals waiting', async () => {
  const { ctx, page, errors } = await open();
  assert.match(await page.textContent('#simDate'), /Jan 2, 2020 close/);
  assert.ok(await page.locator('.order').count() >= 2, 'rotation and crypto proposals');
  assert.equal(await page.textContent('#mktState'), 'Paused');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a touch that scrolls off Approve does not approve; a completed tap does', async () => {
  const { ctx, page } = await open({ hasTouch: true, viewport: { width: 390, height: 844 }, isMobile: true });
  const n = await page.locator('.order').count();
  const btn = firstApprove(page);
  // A finger lands on Approve and the page scrolls: down and cancel, no click.
  await btn.dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true });
  await btn.dispatchEvent('pointercancel', { pointerType: 'touch', isPrimary: true });
  assert.equal(await page.locator('.order').count(), n, 'still waiting');
  await btn.tap();
  await page.waitForSelector('.working li');
  assert.equal(await page.locator('.order').count(), n - 1);
  await ctx.close();
});

test('approved orders fill at the next close and show on the blotter', async () => {
  const { ctx, page } = await open();
  await firstApprove(page).click();
  await page.waitForSelector('.working li');
  await page.click('[data-act="skipDays"][data-v="1"]');
  await page.waitForFunction(() => /Jan 3, 2020 close/.test(document.getElementById('simDate').textContent));
  await page.goto(base + '/#blotter');
  await page.waitForSelector('.ostatus.filled');
  assert.match(await page.textContent('#desk'), /cost \$/);
  await ctx.close();
});

test('the fund survives a reload; an unreadable save is kept as a backup, not lost', async () => {
  const { ctx, page } = await open();
  await page.click('[data-act="skipDays"][data-v="1"]');
  await page.waitForFunction(() => /Jan 3, 2020/.test(document.getElementById('simDate').textContent));
  await page.reload();
  await page.waitForSelector('[data-panel="queue"]');
  assert.match(await page.textContent('#simDate'), /Jan 3, 2020/);
  await ctx.close();
  // A save this version can't open (planted before the page loads, so nothing overwrites it).
  const c2 = await browser.newContext();
  await c2.addInitScript(() => { if (!sessionStorage.getItem('planted')) { sessionStorage.setItem('planted', '1'); localStorage.setItem('tradingFloor.v1', JSON.stringify({ version: 99, note: 'from the future' })); } });
  const p2 = await c2.newPage();
  await p2.goto(base + '/');
  await p2.waitForSelector('[data-panel="queue"]');
  assert.match(await p2.textContent('#toast'), /could not be opened/);
  await p2.goto(base + '/#security');
  await p2.waitForSelector('.backups li');
  assert.match(await p2.textContent('.backups'), /cannot open/);
  await c2.close();
});


test('an open dropdown survives background redraws while playing', async () => {
  const { ctx, page } = await open();
  await page.goto(base + '/#blotter');
  await page.waitForSelector('#t-sym');
  await page.selectOption('#t-sym', 'GLD');
  await page.focus('#t-sym');
  await page.evaluate(() => document.querySelector('[data-act="speed"][data-v="fast"]').click());
  await page.waitForTimeout(1200);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 't-sym', 'still focused');
  assert.equal(await page.inputValue('#t-sym'), 'GLD');
  await page.evaluate(() => document.querySelector('[data-act="speed"][data-v="pause"]').click());
  await ctx.close();
});

test('every desk renders without errors, and nothing scrolls sideways on a phone', async () => {
  const { ctx, page, errors } = await open({ viewport: { width: 390, height: 844 } });
  for (const d of ['floor', 'portfolio', 'risk', 'quants', 'blotter', 'security', 'reports']) {
    await page.goto(`${base}/#${d}`);
    await page.waitForFunction(id => document.querySelector('#nav a[aria-current="page"]')?.getAttribute('href') === '#' + id, d);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(wide <= 1, `${d}: page is ${wide}px wider than the screen`);
  }
  const header = await page.evaluate(() => document.querySelector('header.bar').getBoundingClientRect().height);
  assert.ok(header < 170, `phone header is ${header}px tall`);
  assert.deepEqual(errors, []);
  await ctx.close();
});
