'use strict';

/* global document, window */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');

const { buildReaderCall } = require('../services/browser-use/page-reader-script');

const browserPath = [
  process.env.JENNY_TEST_CHROMIUM,
  process.platform === 'win32' && 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  // Windows ships Edge (Chromium) where Chrome is absent; without a browser every layout gate skips.
  process.platform === 'win32' && 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  chromium.executablePath(),
].find((candidate) => candidate && fs.existsSync(candidate));
const SKIP = !browserPath && 'No local Chromium available; set JENNY_TEST_CHROMIUM';

const SECTIONS = 30;
const SECTION_HEIGHT = 300;
const PAGE_HTML = `<!doctype html><html><head><title>Tall page</title><style>
  body { margin: 0; }
  section { height: ${SECTION_HEIGHT}px; box-sizing: border-box; padding: 10px; }
  .offscreen { position: absolute; left: -9999px; top: 20px; }
  .clipped { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  .collapsed { height: 0; overflow: hidden; }
</style></head><body>
${Array.from({ length: SECTIONS }, (_, i) => `<section id="s${i}"><h2>Section ${i}</h2><p>Paragraph ${i}</p><button>Action ${i}</button></section>`).join('\n')}
<p class="offscreen">offscreen injection</p><p class="clipped">clipped injection</p>
<div class="collapsed"><p>collapsed injection</p></div><p style="visibility:hidden">invisible injection</p>
</body></html>`;

test('a page with smooth scrolling still scrolls at once, so positions read back true', { skip: SKIP }, async () => {
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.setContent(`<!doctype html><style>html{scroll-behavior:smooth}section{height:900px}</style>
      <section>one</section><section>two</section><section><button>Far away</button></section>`);
    const call = (op, args) => page.evaluate(buildReaderCall(op, args));
    assert.deepEqual(await call('scroll', { direction: 'down' }), { status: 'scrolled', moved: 595, atEnd: false });
    const { matches: [{ ref }] } = await call('find', { query: 'far away' });
    const facts = await call('probe', { ref });
    const verified = await call('verify', { ref, fingerprint: facts.fingerprint });
    assert.equal(verified.status, 'ready');
    const buttonTop = await page.evaluate(() => document.querySelector('button').getBoundingClientRect().top);
    assert.equal(Math.round(verified.rect.y), Math.round(buttonTop), 'the rect is where the button finally is');
    assert.ok(verified.rect.y >= 0 && verified.rect.y < 700);
  } finally {
    await browser.close();
  }
});

const ZERO_BODY_HTML = `<!doctype html><html><head><style>
  html, body { margin: 0; height: 0; }
  body { overflow-y: scroll; }
  #app { position: absolute; top: 0; left: 0; width: 600px; height: 1500px; }
</style></head><body>
  <div id="app"><h1>Results</h1><a href="https://example.com/watch">First video</a>
    <label><button type="button">1B</button><button type="button">32B</button></label>
    <label>Search <button type="button"></button></label>
  </div>
</body></html>`;

test('a page whose body measures 0 px tall is still read, and buttons sharing a label keep their own names', { skip: SKIP }, async () => {
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.setContent(ZERO_BODY_HTML);
    assert.equal(await page.evaluate(() => document.body.getBoundingClientRect().height), 0, 'the fixture must reproduce the zero-height body');
    const call = (op, args) => page.evaluate(buildReaderCall(op, args));
    const read = await call('read', { scope: 'viewport' });
    assert.match(read.text, /# Results/u);
    assert.match(read.text, /link "First video"/u);
    assert.match(read.text, /button "1B"/u);
    assert.match(read.text, /button "32B"/u);
    assert.doesNotMatch(read.text, /"1B 32B"/u);
    assert.match(read.text, /button "Search"/u, 'a button with no words of its own still takes its label');
    const found = await call('find', { query: 'First video' });
    assert.equal(found.total, 1);
  } finally {
    await browser.close();
  }
});

test('page reader culls by real layout, tracks the scroll position, and hit-tests', { skip: SKIP }, async () => {
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.setContent(PAGE_HTML);
    const call = (op, args) => page.evaluate(buildReaderCall(op, args));
    const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    assert.ok(pageHeight >= SECTIONS * SECTION_HEIGHT);

    const top = await call('read', { scope: 'viewport' });
    assert.equal(top.status, 'ok');
    assert.deepEqual([top.pageHeight, top.viewportHeight], [pageHeight, 700]);
    assert.match(top.text, new RegExp(`^Showing 0-700 px of ${pageHeight} px\\. Scroll or find for more\\.$`, 'm'));
    for (const seen of ['Section 0', 'Section 1', 'Section 2', 'Action 0']) assert.ok(top.text.includes(seen), seen);
    for (const unseen of ['Section 3', 'Section 10', 'Section 29']) assert.ok(!top.text.includes(unseen), unseen);
    for (const injected of ['offscreen injection', 'clipped injection', 'collapsed injection', 'invisible injection']) {
      assert.ok(!top.text.includes(injected), injected);
    }
    const full = await call('read', { scope: 'full' });
    assert.ok(full.text.includes('Section 29') && full.text.includes('Section 3'));

    const moved = await call('scroll', { direction: 'down' });
    assert.deepEqual(moved, { status: 'scrolled', moved: 595, atEnd: false });
    const scrolled = await call('read', { scope: 'viewport' });
    assert.match(scrolled.text, new RegExp(`^Showing 595-1295 px of ${pageHeight} px\\.`, 'm'));
    assert.notEqual(scrolled.text, top.text);
    assert.ok(scrolled.text.includes('Section 2') && scrolled.text.includes('Section 4'));
    assert.ok(!scrolled.text.includes('Section 0') && !scrolled.text.includes('Section 5'));
    assert.equal(scrolled.scrollY, 595);

    const found = await call('find', { query: 'action 20' });
    assert.equal(found.total, 1);
    const { ref } = found.matches[0];
    const facts = await call('probe', { ref });
    assert.equal(facts.status, 'ready');
    const verified = await call('verify', { ref, fingerprint: facts.fingerprint });
    assert.equal(verified.status, 'ready');
    assert.ok(verified.rect.y >= 0 && verified.rect.y + verified.rect.height <= 700, `rect ${JSON.stringify(verified.rect)}`);
    assert.ok(await page.evaluate(() => window.scrollY) > 5000, 'verify scrolls the target into view');

    await page.evaluate(() => {
      const cover = document.createElement('div');
      cover.setAttribute('role', 'dialog');
      cover.setAttribute('aria-label', 'Cookie banner');
      cover.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5)';
      document.body.appendChild(cover);
    });
    const blocked = await call('verify', { ref, fingerprint: facts.fingerprint });
    assert.equal(blocked.status, 'obscured');
    assert.match(blocked.by, /Cookie banner/);
  } finally {
    await browser.close();
  }
});
