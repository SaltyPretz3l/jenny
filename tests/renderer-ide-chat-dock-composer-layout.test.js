/* global document, window, getComputedStyle */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { SKIP, withBrowser, mountComposer, measureButtons, measureControlSizes, assertControlSizes, assertOneCleanLine, isCompact } = require('./helpers/composer-layout-harness');

const HOST = '#ideChatDockBody';
const CONTROLS = ['Attach', 'Tools', 'Composer settings', 'Pause', 'Stop', 'Queue'];
const settle = (page) => page.evaluate(() => new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))));

test('S5: at 320px the streaming dock collapses and keeps every control on one line', { skip: SKIP }, async () => {
  await withBrowser(async (browser) => {
    for (const mode of ['auto', 'ask']) {
      const page = await mountComposer(browser, { paneWidth: 320, hostSelector: HOST, streaming: true, mode, waitCompact: false });
      await settle(page);
      assert.equal(await page.evaluate(isCompact), true, `${mode}: compact`);
      assertOneCleanLine(await measureButtons(page, HOST), `${mode}: 320px dock`, CONTROLS);
      assert.ok(await page.locator('.composer-settings-summary').evaluate((pill) => pill.getBoundingClientRect().width) > 0);
      await page.close();
    }
  });
});

test('S5: at 320px the open list and model submenu stay inside the dock', { skip: SKIP }, async () => {
  await withBrowser(async (browser) => {
    const page = await mountComposer(browser, { paneWidth: 320, hostSelector: HOST, waitCompact: false });
    await settle(page);
    await page.evaluate(() => window.__settings.setOpen(true));
    const boxes = await page.evaluate(() => {
      const dock = document.getElementById('ideChatDockBody').getBoundingClientRect();
      const group = document.getElementById('composerSettingsGroup');
      const menu = document.getElementById('composerModelPopover');
      menu.hidden = false;
      return [group, menu].map((node) => {
        const box = node.getBoundingClientRect();
        return { visible: box.width > 0 && box.height > 0, inside: box.left >= dock.left && box.right <= dock.right && box.top >= dock.top && box.bottom <= dock.bottom };
      });
    });
    assert.deepEqual(boxes, [{ visible: true, inside: true }, { visible: true, inside: true }]);
    await page.close();
  });
});

test('S5: a 900px idle dock stays expanded', { skip: SKIP }, async () => {
  await withBrowser(async (browser) => {
    const page = await mountComposer(browser, { paneWidth: 900, hostSelector: HOST, waitCompact: false });
    await settle(page);
    assert.equal(await page.evaluate(isCompact), false);
    await page.close();
  });
});

test('S5: a dock shortened while the list is open re-bounds it; a row menu is never clipped by the bound', { skip: SKIP }, async () => {
  await withBrowser(async (browser) => {
    const page = await mountComposer(browser, { paneWidth: 320, hostSelector: HOST, viewport: { width: 800, height: 600 }, waitCompact: false });
    await settle(page);
    await page.evaluate(() => window.__settings.setOpen(true));
    await settle(page);
    const readList = () => page.evaluate(() => {
      const group = document.getElementById('composerSettingsGroup');
      const box = group.getBoundingClientRect();
      const dock = document.getElementById('ideChatDockBody').getBoundingClientRect();
      const style = getComputedStyle(group);
      return { bound: style.maxBlockSize, overflow: style.overflowY, scroll: group.scrollHeight > group.clientHeight,
        inside: box.width > 0 && box.left >= dock.left && box.right <= dock.right && box.top >= dock.top && box.bottom <= dock.bottom };
    });
    const tall = await readList();
    assert.equal(tall.scroll, false, 'the 800px dock shows the whole list');
    // The model row's own menu covers the list from its corner and may be
    // taller and wider than the list: the scroll bound must not clip it.
    const menu = await page.evaluate(() => {
      const group = document.getElementById('composerSettingsGroup');
      const popover = document.getElementById('composerModelPopover');
      popover.hidden = false;
      popover.innerHTML = '<div style="block-size: 360px"></div>';
      const groupBox = group.getBoundingClientRect();
      const box = popover.getBoundingClientRect();
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + 4);
      const start = document.elementFromPoint(box.left + 2, box.top + box.height / 2);
      const result = { overflow: getComputedStyle(group).overflowY, taller: box.height > groupBox.height + 40,
        topVisible: popover.contains(top), startVisible: popover.contains(start) };
      popover.hidden = true;
      popover.innerHTML = '';
      return result;
    });
    assert.equal(menu.overflow, 'visible', 'the list stops clipping while a row menu is open');
    assert.equal(menu.taller, true);
    assert.equal(menu.topVisible, true, 'the top of the menu is hit-testable');
    assert.equal(menu.startVisible, true, 'the start edge of the menu is hit-testable');
    assert.equal((await readList()).overflow, 'auto', 'the bound returns when the menu closes');
    // Height-only change: the toolbar keeps its size, so only the host observer can refit.
    await page.locator(HOST).evaluate((dock) => { dock.style.blockSize = '150px'; });
    await settle(page);
    await settle(page);
    const short = await readList();
    assert.notEqual(short.bound, 'none');
    assert.ok(Number.parseFloat(short.bound) < Number.parseFloat(tall.bound), `the bound follows the host (${tall.bound} -> ${short.bound})`);
    assert.equal(short.overflow, 'auto');
    assert.equal(short.scroll, true);
    assert.equal(short.inside, true);
    await page.close();
  });
});

test('S5: rehost events refit the composer moving from Chat to the dock and back', { skip: SKIP }, async () => {
  await withBrowser(async (browser) => {
    const page = await mountComposer(browser, { paneWidth: 900, waitCompact: false });
    // Use the production shell listener, while retaining this harness's real fit.
    await page.evaluate(() => { window.rendererAppShellBindingsControllers = { bindShellEventControllers() {}, bindAttachments() {} }; });
    await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '../renderer/app/renderer-app-shell-bindings.js'), 'utf8') });
    await page.evaluate(async () => {
      const fit = window.__settings;
      window.rendererPaneComposerRail.createComposerSettingsFit = () => fit;
      window.rendererComposerV2Render = null;
      window.__cleanups = [];
      await window.rendererAppShellBindings.bindAppShell({ state: { ui: {} }, controllers: { chatShellController: { composerV2: {} } },
        callbacks: { registerCleanup: (fn) => window.__cleanups.push(fn), signalRendererReadyOnce() {} } });
    });
    await settle(page);
    assert.equal(await page.evaluate(isCompact), false);
    await page.evaluate(() => {
      const dock = document.getElementById('ideChatDockBody');
      document.body.appendChild(dock);
      Object.assign(dock.style, { position: 'fixed', insetInlineStart: '0', insetBlockStart: '0', inlineSize: '320px', blockSize: '800px' });
      dock.appendChild(document.getElementById('composerWrap'));
      document.getElementById('chatView').style.display = 'none';
      window.dispatchEvent(new window.CustomEvent('chat-surface:rehost', { detail: { surface: 'workspace' } }));
    });
    await settle(page);
    assert.equal(await page.evaluate(isCompact), true);
    await page.evaluate(() => {
      document.getElementById('chatView').style.display = '';
      document.getElementById('chatPane0').appendChild(document.getElementById('composerWrap'));
      window.dispatchEvent(new window.CustomEvent('chat-surface:rehost', { detail: { surface: 'chat' } }));
    });
    await settle(page);
    assert.equal(await page.evaluate(isCompact), false);
    await page.close();
  });
});

test('S5: pane 0 registers one rehost listener and removes it on shell cleanup', async (t) => {
  const dom = new JSDOM('<div class="composer-settings-group"><div id="composerModelPillSlot"></div></div>', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  let rechecks = 0;
  let disposed = 0;
  const cleanups = [];
  dom.window.rendererPaneComposerRail = { createComposerSettingsFit: () => ({ recheck: () => { rechecks += 1; }, dispose: () => { disposed += 1; } }) };
  dom.window.rendererAppShellBindingsControllers = { bindShellEventControllers() {}, bindAttachments() {} };
  dom.window.eval(fs.readFileSync(path.join(__dirname, '../renderer/app/renderer-app-shell-bindings.js'), 'utf8'));
  await dom.window.rendererAppShellBindings.bindAppShell({ state: { ui: {} }, controllers: { chatShellController: { composerV2: {} } },
    callbacks: { registerCleanup: (fn) => cleanups.push(fn), signalRendererReadyOnce() {} } });
  const fire = () => dom.window.dispatchEvent(new dom.window.CustomEvent('chat-surface:rehost', { detail: { surface: 'workspace' } }));
  fire();
  assert.equal(rechecks, 1);
  // Other shell cleanup callbacks need unrelated controllers; the fit owns the first one.
  cleanups[0]();
  fire();
  assert.equal(rechecks, 1, 'cleanup removes the listener');
  assert.equal(disposed, 1);
});

test('S7: the dock density is a 32px primary and a 30px secondary size', { skip: SKIP }, async () => {
  await withBrowser(async (browser) => {
    for (const streaming of [false, true]) {
      // The dock density is its container query (<= 700px); 600px also collapses the row.
      const page = await mountComposer(browser, { paneWidth: 600, hostSelector: HOST, streaming, waitCompact: false });
      await settle(page);
      const seen = assertControlSizes(await measureControlSizes(page), { primary: 32, secondary: 30 }, `dock density, streaming ${streaming}`);
      for (const name of streaming ? ['stop', 'pause', 'send', 'attach', 'chat', 'summary'] : ['send', 'attach', 'chat']) assert.ok(seen.includes(name), `${name} was measured`);
      await page.close();
    }
  });
});
