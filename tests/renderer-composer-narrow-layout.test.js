/* global document, window, getComputedStyle */
'use strict';

/* GUI gate 2026-09-27, F3 / F4 / N2 / N3: the collapsed composer laid out by
 * the REAL stylesheet (index.html + styles.css) in headless Chromium, with
 * the real UMD modules that build the summary pill, the settings list and
 * the run-mode segments injected into the page (every other app script is
 * blocked; no app, no window). jsdom cannot lay out CSS, so these are the
 * layout gates:
 *
 *   F3  at the split's minimum pane width (the divider's pixel floor, driven
 *       through renderer-chat-pane-resizer.js at the gate's view width) a
 *       streaming composer keeps every control inside the pane, one line, no
 *       overlap, nothing clipped; the open list shows the model and the
 *       context percent.
 *   F4  translated run-mode segments never break inside a word.
 *   N2  the body-level .composer-popover has a real surface; a sub-menu over
 *       the list is opaque.
 *   N3  the pane kicker's project tag stays one line.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { SKIP, withBrowser, mountComposer, measureButtons: measureToolbar, measureControlSizes, assertControlSizes, assertOneCleanLine, isCompact } = require('./helpers/composer-layout-harness');

const { createChatPaneResizer, MIN_PANE_WIDTH_PX } = require('../renderer/chat/renderer-chat-pane-resizer');

// The gate's view: the two panes plus the divider measured 870px.
const GATE_PANES_WIDTH = 870;

/* The narrowest pane the divider allows at the gate's width: twenty
   ArrowLefts on the real resizer (the gate pressed fifteen from 50). */
function splitMinimumPaneWidth() {
  const dom = new JSDOM('<div id="view"></div><div id="divider"></div>');
  const { document: doc } = dom.window;
  let ratio = 0.5;
  const resizer = createChatPaneResizer({
    resizerEl: doc.getElementById('divider'),
    chatViewEl: doc.getElementById('view'),
    getSplitRatio: () => ratio,
    setSplitRatio: (next) => { ratio = Math.min(0.8, Math.max(0.2, next)); return ratio; },
    measureWidth: () => GATE_PANES_WIDTH,
  });
  resizer.bind();
  for (let i = 0; i < 20; i += 1) {
    doc.getElementById('divider').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
  }
  resizer.dispose();
  dom.window.close();
  return Math.floor(ratio * (GATE_PANES_WIDTH - 10));
}

/* Whole words: every word of every segment label renders in one piece. */
function readSegments(page) {
  return page.evaluate(() => {
    const group = document.querySelector('#chatPane0 .composer-settings-group').getBoundingClientRect();
    return [...document.querySelectorAll('#chatPane0 .composer-run-mode-segment')].map((segment) => {
      const label = segment.querySelector('.composer-run-mode-segment-label');
      const text = label.firstChild;
      const split = [];
      const pattern = /\S+/g;
      let match;
      while ((match = pattern.exec(text.data))) {
        const range = document.createRange();
        range.setStart(text, match.index);
        range.setEnd(text, match.index + match[0].length);
        const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));
        if (lines.size > 1) split.push(match[0]);
      }
      const box = segment.getBoundingClientRect();
      return { text: text.data, split, inside: box.left >= group.left - 0.5 && box.right <= group.right + 0.5 };
    });
  });
}

test('F3: the split minimum is a pane the streaming composer can lay out (pixel floor, not 20%)', { skip: SKIP }, async () => {
  const minimum = splitMinimumPaneWidth();
  await withBrowser(async (browser) => {
    for (const mode of ['auto', 'ask']) {
      const page = await mountComposer(browser, { paneWidth: minimum, streaming: true, mode });
      assertOneCleanLine(await measureToolbar(page), `${mode}, streaming, ${minimum}px`);
      await page.close();
    }
  });
  assert.ok(minimum >= MIN_PANE_WIDTH_PX - 10, `the divider stops at ${minimum}px, within the divider's share of the floor`);
});

test('F3: a reply starting in an expanded composer collapses it; the streaming row stays clean', { skip: SKIP }, async () => {
  await withBrowser(async (browser) => {
    const page = await mountComposer(browser, { paneWidth: 900, waitCompact: false });
    await page.evaluate(() => new Promise((resolve) => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(isCompact), false, 'idle, the 900px toolbar fits expanded');
    await page.evaluate(() => window.__startStreaming());
    await page.waitForFunction(isCompact, null, { timeout: 5000 });
    assertOneCleanLine(await measureToolbar(page), 'streaming started at 900px');
    await page.close();
  });
});

test('F3: at the split minimum the open list shows the model and the context percent', { skip: SKIP }, async () => {
  const minimum = splitMinimumPaneWidth();
  await withBrowser(async (browser) => {
    const page = await mountComposer(browser, { paneWidth: minimum, streaming: true });
    await page.evaluate(() => window.__settings.setOpen(true));
    const rows = await page.evaluate(() => {
      const group = document.querySelector('#chatPane0 .composer-settings-group');
      const model = group.querySelector('[data-inv-chip="composer-model"] .inv-chip-label');
      const percent = group.querySelector('.inv-context-ring-percent');
      return { model: model.clientWidth, percent: { scroll: percent.scrollWidth, client: percent.clientWidth } };
    });
    assert.ok(rows.model >= 80, `the model label keeps room to read (${rows.model}px)`);
    assert.ok(rows.percent.client > 0 && rows.percent.scroll <= rows.percent.client + 1, `the context percent shows whole (${JSON.stringify(rows.percent)})`);
    const segments = await readSegments(page);
    for (const segment of segments) assert.deepEqual(segment.split, [], `"${segment.text}" keeps its words whole`);
    await page.close();
  });
});

test('F4: Spanish run-mode segments wrap between words, never inside one, and never clip', { skip: SKIP }, async () => {
  await withBrowser(async (browser) => {
    for (const paneWidth of [312, splitMinimumPaneWidth()]) {
      const page = await mountComposer(browser, { paneWidth, lang: 'es' });
      await page.evaluate(() => window.__settings.setOpen(true));
      const segments = await readSegments(page);
      assert.deepEqual(segments.map((segment) => segment.text), ['Preguntar', 'Ejecución automática', 'Planificar', 'Proponer']);
      for (const segment of segments) {
        assert.deepEqual(segment.split, [], `${paneWidth}px: "${segment.text}" breaks inside a word`);
        assert.equal(segment.inside, true, `${paneWidth}px: "${segment.text}" stays inside the list`);
      }
      await page.close();
    }
  });
});

test('N2: sub-menus have a real surface; over the list it is opaque (Day and Darkroom)', { skip: SKIP }, async () => {
  await withBrowser(async (browser) => {
    for (const palette of ['darkroom', 'jenny-day']) {
      const page = await mountComposer(browser, { paneWidth: 420, palette });
      await page.evaluate(() => window.__settings.setOpen(true));
      const surfaces = await page.evaluate(() => {
        const alpha = (color) => { const parts = color.match(/[\d.]+/g) || []; return parts.length === 4 ? Number(parts[3]) : (parts.length === 3 ? 1 : 0); };
        const tools = document.querySelector('#chatPane0 .composer-model-popover');
        tools.hidden = false;
        const menu = document.createElement('div');
        menu.className = 'composer-popover project-menu';
        document.body.appendChild(menu);
        const plain = getComputedStyle(menu).backgroundImage;
        menu.dataset.settingsCover = '1';
        return { menuImage: plain, menuCover: alpha(getComputedStyle(menu).backgroundColor), tools: alpha(getComputedStyle(tools).backgroundColor) };
      });
      assert.notEqual(surfaces.menuImage, 'none', `${palette}: .composer-popover draws the popover surface (it drew none)`);
      assert.equal(surfaces.menuCover, 1, `${palette}: a body-level menu covering the list is opaque`);
      assert.equal(surfaces.tools, 1, `${palette}: an in-list sub-menu is opaque`);
      await page.close();
    }
  });
});

test('N3: the pane kicker project tag is one ellipsized line', { skip: SKIP }, async () => {
  await withBrowser(async (browser) => {
    const page = await mountComposer(browser, { paneWidth: 200, projectTag: 'ui-test-b' });
    const tag = await page.evaluate(() => {
      const node = document.querySelector('#chatPane0 .chat-pane-kicker-project');
      const range = document.createRange();
      range.selectNodeContents(node);
      return { lines: new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size, overflow: getComputedStyle(node).textOverflow };
    });
    assert.equal(tag.lines, 1, 'one line, not one word per line');
    assert.equal(tag.overflow, 'ellipsis');
    await page.close();
  });
});

test('S7: Stop, Pause and Send share the primary size, every chip, icon button and ring the secondary size', { skip: SKIP }, async () => {
  const frames = (page) => page.evaluate(() => new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));
  await withBrowser(async (browser) => {
    const idle = await mountComposer(browser, { paneWidth: 1200, waitCompact: false });
    await frames(idle);
    assert.equal(await idle.evaluate(isCompact), false, 'measured expanded');
    const seenIdle = assertControlSizes(await measureControlSizes(idle), { primary: 36, secondary: 32 }, 'default density');
    for (const name of ['send', 'attach', 'commands', 'chat', 'runMode', 'model', 'ring']) assert.ok(seenIdle.includes(name), `${name} was measured`);
    await idle.close();
    const streaming = await mountComposer(browser, { paneWidth: 1200, streaming: true, waitCompact: false });
    await frames(streaming);
    const seenLive = assertControlSizes(await measureControlSizes(streaming), { primary: 36, secondary: 32 }, 'default density, streaming');
    for (const name of ['stop', 'pause', 'send', 'attach', 'chat']) assert.ok(seenLive.includes(name), `${name} was measured`);
    await streaming.setViewportSize({ width: 680, height: 914 });
    await frames(streaming);
    assertControlSizes(await measureControlSizes(streaming), { primary: 32, secondary: 30 }, 'narrow window density');
    await streaming.close();
  });
});
