'use strict';

// The browser panel's controller (row 114): when the panel opens, what its status line and header
// say, who holds the page, and that the whole feature loads only for a chat that has it on.

const test = require('node:test');
const assert = require('node:assert/strict');

const panelModule = require('../renderer/chat/renderer-browser-use-panel');
const placementModule = require('../renderer/chat/renderer-browser-use-placement');
const { createShellArtifactRails } = require('../renderer/shell/renderer-shell-artifact-rails');

const { settle, openPage, closedPage, setup, withOpenPanel } = require('./helpers/browser-use-panel-harness');

test('the chip is there only while the chat has the browser on', async () => {
  const ctx = setup();
  await ctx.sync(false);
  assert.equal(ctx.chip(), null);
  await ctx.sync(true);
  assert.equal(ctx.chip().hidden, false);
  await ctx.sync(false, 's2');
  assert.equal(ctx.chip().hidden, true);
});

test('the chip opens the panel and shows that it is open, and closing it holds back the automatic open', async () => {
  const ctx = setup();
  await ctx.sync(true);
  ctx.chip().click();
  await settle();
  assert.deepEqual(ctx.opens, [['browser', undefined]]);
  assert.equal(ctx.chip().getAttribute('aria-pressed'), 'true');
  ctx.chip().click();
  await settle();
  assert.equal(ctx.toggles, 1);
  assert.equal(ctx.chip().getAttribute('aria-pressed'), 'false');
  ctx.changed(openPage());
  await settle();
  assert.equal(ctx.opens.length, 1);
});

test('a first page opens the panel beside the chat without taking the keyboard', async () => {
  const ctx = setup();
  await ctx.sync(true);
  ctx.changed(openPage());
  await settle();
  assert.deepEqual(ctx.opens, [['browser', { focus: false }]]);
  assert.equal(ctx.panel.isOpen(), true);
  ctx.changed(openPage({ busy: true, action: 'read' }));
  await settle();
  assert.equal(ctx.opens.length, 1, 'once per page');
});

test('a first page takes the column from an open Artifacts list, without taking the keyboard', async () => {
  const ctx = setup();
  await ctx.sync(true);
  ctx.showRail('artifact');
  ctx.changed(openPage());
  await settle();
  assert.deepEqual(ctx.opens, [['browser', { focus: false }]]);
  assert.equal(ctx.panel.isOpen(), true);
});

test('the automatic open leaves another open panel and another chat alone', async () => {
  const other = setup();
  await other.sync(true);
  other.showRail('notes');
  other.changed(openPage());
  await settle();
  assert.deepEqual(other.opens, []);

  const background = setup();
  await background.sync(true);
  background.changed(openPage({ session_id: 's2' }));
  await settle();
  assert.deepEqual(background.opens, []);
});

test('Close in the header holds back the automatic open until the chip is used', async () => {
  const ctx = await withOpenPanel();
  ctx.doc.getElementById('artifactReviewCollapseButton').click();
  ctx.panelEl.classList.add('hidden');
  ctx.changed(closedPage());
  await settle();
  ctx.changed(openPage());
  await settle();
  assert.equal(ctx.opens.length, 1);
  ctx.chip().click();
  await settle();
  assert.equal(ctx.opens.length, 2);
  ctx.panelEl.classList.add('hidden');
  ctx.changed(closedPage());
  await settle();
  ctx.changed(openPage());
  await settle();
  assert.equal(ctx.opens.length, 3);
});

test('the status line is always there and says what is happening in plain words', async () => {
  const ctx = await withOpenPanel();
  assert.equal(ctx.status().dataset.quiet, 'true');
  assert.equal(ctx.statusText(), 'Cart', 'at rest it names the page');
  const cases = [
    [{ action: 'navigate', target: 'shop.example' }, 'Opening shop.example', 'work'],
    [{ action: 'click', target: 'Place order' }, 'Clicking "Place order"', 'work'],
    [{ action: 'click' }, 'Clicking', 'work'],
    [{ action: 'type', target: 'Search' }, 'Typing in "Search"', 'work'],
    [{ action: 'select', target: 'Size' }, 'Choosing in "Size"', 'work'],
    [{ action: 'press', target: 'Enter' }, 'Pressing Enter', 'work'],
    [{ action: 'scroll' }, 'Scrolling', 'work'],
    [{ action: 'find' }, 'Searching the page', 'work'],
    [{ action: 'screenshot' }, 'Looking at the page', 'work'],
    [{ action: 'read' }, 'Reading the page', 'work'],
    [{ action: 'click', target: 'Buy', asking: true }, 'Waiting for your answer in the chat', 'ask'],
  ];
  for (const [fields, text, tone] of cases) {
    ctx.changed(openPage({ busy: true, ...fields }));
    assert.equal(ctx.statusText(), text);
    assert.equal(ctx.status().dataset.tone, tone);
    assert.equal(ctx.status().dataset.quiet, 'false');
    assert.equal(ctx.visible('.bu-status'), true);
  }
  ctx.changed(openPage());
  assert.equal(ctx.visible('.bu-status'), true);
  assert.equal(ctx.status().dataset.quiet, 'true');
});

test('between steps of a running turn the line keeps the last step', async () => {
  const ctx = await withOpenPanel();
  ctx.streaming = true;
  ctx.changed(openPage({ busy: true, action: 'click', target: 'Next' }));
  ctx.changed(openPage());
  assert.equal(ctx.statusText(), 'Clicking "Next"');
  assert.equal(ctx.visible(ctx.line('take-over')), true);
  ctx.streaming = false;
  ctx.changed(openPage());
  assert.equal(ctx.statusText(), 'Cart');
  assert.equal(ctx.visible(ctx.line('take-over')), false);
});

test('what a page names stays text', async () => {
  const ctx = await withOpenPanel();
  ctx.changed(openPage({ busy: true, action: 'click', target: '<img src=x onerror=alert(1)>' }));
  assert.equal(ctx.status().querySelector('img'), null);
  assert.match(ctx.statusText(), /<img src=x/u);
});

test('Take over and Hand back trade places in the line and name the chat', async () => {
  const ctx = await withOpenPanel(openPage({ busy: true, action: 'read' }));
  assert.equal(ctx.visible(ctx.line('take-over')), true);
  assert.equal(ctx.visible(ctx.line('hand-back')), false);
  ctx.doc.querySelector(ctx.line('take-over')).click();
  await settle();
  assert.deepEqual(ctx.named('takeOver'), [['takeOver', { session_id: 's1' }]]);

  ctx.changed(openPage({ mode: 'user' }));
  assert.equal(ctx.statusText(), 'You have the page.');
  assert.equal(ctx.status().dataset.tone, 'user');
  assert.equal(ctx.visible(ctx.line('take-over')), false);
  assert.equal(ctx.visible(ctx.line('hand-back')), true);
  ctx.doc.querySelector(ctx.line('hand-back')).click();
  await settle();
  assert.deepEqual(ctx.named('handBack'), [['handBack', { session_id: 's1' }]]);
});

test('the chat says when a step is waiting on the user, and Hand back answers it', async () => {
  const ctx = await withOpenPanel();
  const line = () => ctx.doc.querySelector('.bu-chat-wait');
  assert.equal(line(), null);
  ctx.changed(openPage({ mode: 'user' }));
  assert.equal(line(), null, 'having control is not the same as Jenny waiting');
  ctx.changed(openPage({ mode: 'user', waiting: true }));
  assert.equal(line().nextElementSibling, ctx.doc.querySelector('.composer-status-notice'));
  assert.match(line().textContent, /Jenny is waiting/);
  const first = line();
  ctx.changed(openPage({ mode: 'user', waiting: true, title: 'Moved on' }));
  assert.equal(line(), first, 'a later push leaves the line alone');
  line().querySelector('.bu-hand-back').click();
  await settle();
  assert.deepEqual(ctx.named('handBack'), [['handBack', { session_id: 's1' }]]);
  ctx.changed(openPage({ mode: 'model', waiting: false }));
  assert.equal(line(), null);
});

test('the waiting line belongs to the chat that is waiting', async () => {
  const ctx = await withOpenPanel();
  ctx.changed(openPage({ session_id: 's2', mode: 'user', waiting: true }));
  assert.equal(ctx.doc.querySelector('.bu-chat-wait'), null);
  ctx.state.currentSessionId = 's2';
  ctx.answers.getState = { ok: true, ...openPage({ session_id: 's2', mode: 'user', waiting: true }) };
  await ctx.sync(true, 's2');
  assert.ok(ctx.doc.querySelector('.bu-chat-wait'));
  ctx.state.currentSessionId = 's1';
  await ctx.sync(true, 's1');
  assert.equal(ctx.doc.querySelector('.bu-chat-wait'), null);
});

test('the waiting line goes when the panel code does', async () => {
  const ctx = await withOpenPanel(openPage({ mode: 'user', waiting: true }));
  assert.ok(ctx.doc.querySelector('.bu-chat-wait'));
  ctx.panel.dispose();
  assert.equal(ctx.doc.querySelector('.bu-chat-wait'), null);
});

test('the keyboard follows the control that replaced the focused one', async () => {
  const ctx = await withOpenPanel(openPage({ busy: true, action: 'read' }));
  ctx.doc.querySelector(ctx.line('take-over')).focus();
  ctx.changed(openPage({ mode: 'user' }));
  assert.equal(ctx.doc.activeElement, ctx.doc.querySelector(ctx.line('hand-back')));
  ctx.changed(openPage({ busy: true, action: 'read' }));
  assert.equal(ctx.doc.activeElement, ctx.doc.querySelector(ctx.line('take-over')));
});

test('the controls sit before Close, and Back to chat closes the drawer', async () => {
  const ctx = await withOpenPanel();
  const close = ctx.doc.getElementById('artifactReviewCollapseButton');
  assert.equal(close.previousElementSibling, ctx.doc.querySelector('.bu-back-to-chat'));
  assert.equal(ctx.doc.querySelector('.bu-more').nextElementSibling, ctx.doc.querySelector('.bu-back-to-chat'));
  ctx.doc.querySelector('.bu-back-to-chat').click();
  assert.equal(ctx.toggles, 1);
});

test('with no page the panel says how to get one', async () => {
  const ctx = setup();
  await ctx.sync(true);
  ctx.chip().click();
  await settle();
  assert.equal(ctx.visible('.bu-message'), true);
  assert.equal(ctx.doc.querySelector('.bu-message strong').textContent, 'Nothing open yet');
  assert.match(ctx.doc.querySelector('.bu-message span').textContent, /Sign-ins and site data are gone/u);
  assert.equal(ctx.visible(ctx.line('take-over')), false);
  assert.ok(ctx.named('getState').length >= 1);
});

test('turning the row off closes the panel and the page; a chat that was never on is left alone', async () => {
  const ctx = await withOpenPanel();
  await ctx.sync(false);
  assert.equal(ctx.toggles, 1);
  assert.deepEqual(ctx.named('close'), [['close', { session_id: 's1' }]]);
  await ctx.sync(false, 's9');
  assert.equal(ctx.named('close').length, 1);
});

test('leaving a chat with its panel up brings it back on return, without taking the keyboard', async () => {
  const ctx = await withOpenPanel();
  ctx.state.currentSessionId = 's2';
  ctx.panelSession = 's2';
  ctx.panelEl.dataset.artifactReviewMode = 'artifact';
  ctx.panelEl.classList.add('hidden');
  await settle();
  assert.equal(ctx.doc.querySelector('.bu-shell'), null, 'nothing of the panel is left for the next mode');
  assert.equal(ctx.doc.querySelector('.bu-bar'), null);

  ctx.state.currentSessionId = 's1';
  ctx.panelSession = 's1';
  await ctx.sync(true);
  assert.deepEqual(ctx.opens.at(-1), ['browser', { focus: false }]);
  assert.equal(ctx.opens.length, 2);
});

test('a panel closed by hand stays closed after leaving the chat and coming back', async () => {
  const ctx = await withOpenPanel();
  ctx.panelEl.classList.add('hidden');
  await settle();
  ctx.state.currentSessionId = 's2';
  ctx.panelSession = 's2';
  ctx.panelEl.dataset.artifactReviewMode = 'artifact';
  await settle();
  ctx.state.currentSessionId = 's1';
  ctx.panelSession = 's1';
  await ctx.sync(true);
  assert.equal(ctx.opens.length, 1);
});

test('another panel taking the column in the same chat does not come back later', async () => {
  const ctx = await withOpenPanel();
  ctx.showRail('notes');
  await settle();
  ctx.panelEl.classList.add('hidden');
  await ctx.sync(true);
  assert.equal(ctx.opens.length, 1);
});

test('a chat with no state answer is asked once per request and then left alone', async () => {
  const ctx = setup();
  ctx.answers.getState = { ok: false, reason: 'nope' };
  ctx.panel.sync({ sessionId: 's1', enabled: true, chipHost: ctx.chipHost });
  ctx.panel.sync({ sessionId: 's1', enabled: true, chipHost: ctx.chipHost });
  await settle();
  await ctx.sync(true);
  assert.equal(ctx.named('getState').length, 1);
});

test('without the inventory the panel declines to paint, so the rail resets its mode', () => {
  const ctx = setup();
  delete ctx.windowRef.inventory;
  assert.equal(ctx.panel.renderRailContent(ctx.surface), false);
});

test('dispose removes everything it added', async () => {
  const ctx = await withOpenPanel();
  ctx.panel.dispose();
  assert.equal(ctx.chip(), null);
  assert.equal(ctx.doc.querySelector('.bu-shell'), null);
  assert.equal(ctx.doc.querySelector('.bu-bar'), null);
  assert.equal(ctx.doc.querySelector('.bu-more'), null);
  assert.equal(ctx.unsubscribed, 1);
  assert.equal(ctx.panelEl.dataset.browserUseBound, undefined);
  assert.equal(ctx.panel.renderRailContent(ctx.surface), false);
});

function railsHarness({ loadFails = false } = {}) {
  const loaded = [];
  const synced = [];
  const cleanups = [];
  const logs = [];
  const connected = [];
  const windowRef = {
    document: { getElementById: () => null },
    scriptLoaderUtils: {
      ensureScript: async ({ src, isReady }) => {
        loaded.push(src);
        if (loadFails) return false;
        if (src.endsWith('placement.js')) windowRef.rendererBrowserUsePlacement = placementModule;
        else if (src.endsWith('status.js')) windowRef.rendererBrowserUseStatus = {};
        else if (src.endsWith('bar.js')) windowRef.rendererBrowserUseBar = {};
        else windowRef.rendererBrowserUsePanel = { connectBrowserUsePanel: (ctx) => { connected.push(ctx); return { sync: (args) => synced.push(args) }; } };
        return isReady();
      },
    },
  };
  const rails = createShellArtifactRails({
    state: {}, windowRef, callbacks: {}, codeReviewRailDeps: {}, registerCleanup: (fn) => cleanups.push(fn),
    sidePanel: { getSessionId: () => 's1' }, appendClientLog: (...args) => logs.push(args), showToastMessage() {},
    renderAll() {}, setActiveView() {}, getSurface: () => null, ensureArtifactSurface: () => null, resolveArtifactReviewPanelEl: () => null,
  });
  return { windowRef, rails, loaded, synced, cleanups, logs, connected };
}

test('nothing loads until a chat has the browser on, then its modules load once, panel last', async () => {
  const h = railsHarness();
  h.windowRef.rendererSyncBrowserUse({ sessionId: 's1', enabled: false });
  await settle();
  assert.deepEqual(h.loaded, []);
  h.windowRef.rendererSyncBrowserUse({ sessionId: 's1', enabled: true });
  h.windowRef.rendererSyncBrowserUse({ sessionId: 's1', enabled: true, chipHost: 'newest' });
  await settle();
  assert.deepEqual(h.loaded, ['placement', 'status', 'bar', 'panel'].map((name) => `renderer/chat/renderer-browser-use-${name}.js`));
  assert.deepEqual(h.synced, [{ sessionId: 's1', enabled: true, chipHost: 'newest' }], 'the newest sync is delivered');
  assert.equal(h.connected.length, 1);
  h.windowRef.rendererSyncBrowserUse({ sessionId: 's1', enabled: false });
  assert.equal(h.synced.length, 2);
});

test('a failed load is logged once and not retried on every render', async () => {
  const h = railsHarness({ loadFails: true });
  h.windowRef.rendererSyncBrowserUse({ sessionId: 's1', enabled: true });
  await settle();
  h.windowRef.rendererSyncBrowserUse({ sessionId: 's1', enabled: true });
  await settle();
  assert.equal(h.loaded.length, 1);
  assert.equal(h.logs.filter((entry) => entry[1] === 'browser_use.panel_init_failed').length, 1);
  assert.equal(h.rails.getBrowserPanel(), null);
});

test('cleanup takes the composer hook back', () => {
  const h = railsHarness();
  for (const cleanup of h.cleanups) cleanup();
  assert.equal(h.windowRef.rendererSyncBrowserUse, undefined);
});

test('connecting drives the shared rail, publishes the header title and takes it back on cleanup', async () => {
  const ctx = setup();
  ctx.panel.dispose();
  const cleanups = [];
  const opened = [];
  const surfaceApi = { openArtifactRail: (...args) => { opened.push(args); ctx.showRail('browser'); }, renderArtifactReviewPanel() {}, toggleArtifactReview() {} };
  const controller = panelModule.connectBrowserUsePanel({
    state: ctx.state, windowRef: ctx.windowRef, sidePanel: { getSessionId: () => 's1' }, registerCleanup: (fn) => cleanups.push(fn),
    ensureArtifactSurface: () => surfaceApi, resolveArtifactReviewPanelEl: () => ctx.panelEl, appendClientLog() {},
  });
  assert.match(ctx.windowRef.rendererBrowserUseHost.glyphHtml, /^<svg/u);
  assert.equal(ctx.windowRef.rendererBrowserUseHost.panelTitle(), 'Browser');
  controller.sync({ sessionId: 's1', enabled: true, chipHost: ctx.chipHost });
  await settle();
  ctx.chip().click();
  assert.deepEqual(opened, [['browser', undefined]]);
  for (const cleanup of cleanups) cleanup();
  assert.equal(ctx.windowRef.rendererBrowserUseHost, undefined);
  assert.equal(ctx.chip(), null);
});

test('a state push that keeps the page open schedules no placement pass', async () => {
  const ctx = setup();
  const frames = [];
  ctx.windowRef.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
  const drain = () => { for (let round = 0; round < 40; round += 1) frames.splice(0).forEach((frame) => frame(0)); };
  await ctx.sync(true);
  ctx.changed(openPage());
  await settle();
  drain();
  ctx.changed(openPage({ busy: true, action: 'read' }));
  await settle();
  assert.equal(frames.length, 0);
  ctx.changed(closedPage());
  await settle();
  assert.ok(frames.length > 0, 'a page going away is a placement change');
});
