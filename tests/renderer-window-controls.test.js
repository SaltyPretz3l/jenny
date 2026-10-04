'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyWindowStateToControls,
  bindShellWindowControls,
  bindWindowControlEvents,
} = require('../renderer/chat/renderer-window-controls-utils');

const ROOT = path.resolve(__dirname, '..');

// The real cluster markup from index.html, inside a bare title bar.
function realClusterMarkup() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const doc = new JSDOM(html).window.document;
  return doc.querySelector('.window-controls').outerHTML;
}

function createDom() {
  return new JSDOM(`<header class="titlebar">
    <div class="titlebar-center"><div class="titlebar-status-text" id="titlebarStatusText" role="status">Loading</div></div>
    ${realClusterMarkup()}
  </header>`);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('the cluster is three tiles (minimize, maximize, close), no reload tile, none a tab stop', () => {
  const doc = createDom().window.document;
  const tiles = [...doc.querySelectorAll('.window-controls .window-button')];
  assert.deepEqual(tiles.map((tile) => tile.dataset.windowAction), ['minimize', 'maximize', 'close']);
  assert.equal(doc.querySelector('[data-window-action="reload"]'), null);
  for (const tile of tiles) {
    assert.equal(tile.getAttribute('tabindex'), '-1', `${tile.dataset.windowAction} is not a tab stop`);
    assert.ok(tile.querySelector('svg.window-glyph[viewBox="0 0 10 10"]'), 'inline 10x10 SVG glyph');
    assert.equal(tile.textContent.trim(), '', 'no text glyphs');
  }
  assert.equal(doc.querySelector('[data-window-action="close"]').getAttribute('aria-label'), 'Close Jenny');
});

test('after the static i18n pass at DOMContentLoaded the shell re-applies the state-owned label', async () => {
  const dom = createDom();
  const doc = dom.window.document;
  let stateListener = null;
  dom.window.jennyShell = {
    window: {
      getState: async () => ({ ok: true, maximized: true }),
      onStateChanged(callback) { stateListener = callback; return () => {}; },
    },
    windowControl: async () => ({ ok: true }),
  };
  bindShellWindowControls({ documentRef: doc, windowRef: dom.window });
  stateListener({ ok: true, maximized: true });
  const button = doc.querySelector('[data-window-action="maximize"]');
  assert.equal(button.getAttribute('aria-label'), 'Restore');

  // i18n-bootstrap's DOMContentLoaded pass writes the static (restored) label.
  button.setAttribute('aria-label', 'Maximize');
  button.setAttribute('title', 'Maximize');
  doc.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  assert.equal(button.getAttribute('aria-label'), 'Restore');
  assert.equal(button.getAttribute('title'), 'Restore');
});

test('maximized shows the two-square restore SVG and the "Restore" label', () => {
  const doc = createDom().window.document;
  const button = doc.querySelector('[data-window-action="maximize"]');

  applyWindowStateToControls(doc, { ok: true, maximized: true });

  assert.equal(button.dataset.maximized, 'true');
  assert.equal(button.getAttribute('aria-label'), 'Restore');
  assert.equal(button.getAttribute('title'), 'Restore');
  const restore = button.querySelector('svg.window-glyph--restore');
  assert.ok(restore, 'restore glyph present');
  assert.equal(restore.querySelectorAll('rect, path').length, 2, 'two overlapping squares');
  assert.ok(button.querySelector('svg.window-glyph--maximize'), 'the SVG glyphs survive (no textContent write)');
  const css = fs.readFileSync(path.join(ROOT, 'styles', 'shell-chrome.css'), 'utf8');
  assert.match(css, /\[data-maximized="true"\]\s*\.window-glyph--maximize\s*\{[^}]*display:\s*none;/);
});

test('restored shows the single-square maximize SVG and the "Maximize" label', () => {
  const doc = createDom().window.document;
  const button = doc.querySelector('[data-window-action="maximize"]');

  applyWindowStateToControls(doc, { ok: true, maximized: true });
  applyWindowStateToControls(doc, { ok: true, maximized: false });

  assert.equal(button.dataset.maximized, 'false');
  assert.equal(button.getAttribute('aria-label'), 'Maximize');
  assert.equal(button.getAttribute('title'), 'Maximize');
  assert.ok(button.querySelector('svg.window-glyph--maximize'));
});

test('the label re-syncs after an i18n re-apply rewrites it under an unchanged state', async () => {
  const doc = createDom().window.document;
  let stateListener = null;
  const controls = bindWindowControlEvents({
    documentRef: doc,
    windowRef: {},
    shell: {
      window: {
        getState: async () => ({ ok: true, maximized: true, minimized: false }),
        onStateChanged(callback) { stateListener = callback; return () => {}; },
      },
      windowControl: async () => ({ ok: true }),
    },
    registerListener() {},
    addCleanup() {},
  });
  stateListener({ ok: true, maximized: true, minimized: false });
  const button = doc.querySelector('[data-window-action="maximize"]');
  assert.equal(button.getAttribute('aria-label'), 'Restore');

  // A static i18n pass (or any stale writer) rewrites the label in place.
  button.setAttribute('aria-label', 'Maximize');
  button.setAttribute('title', 'Maximize');
  stateListener({ ok: true, maximized: true, minimized: false });
  assert.equal(button.getAttribute('aria-label'), 'Restore', 'same state, stale DOM: re-applied');
  assert.equal(button.getAttribute('title'), 'Restore');

  button.setAttribute('aria-label', 'Maximize');
  controls.resync();
  await tick();
  assert.equal(button.getAttribute('aria-label'), 'Restore', 'resync() re-reads the state');
});

test('binding localizes the state-owned label at once, before any state arrives', () => {
  const doc = createDom().window.document;
  const button = doc.querySelector('[data-window-action="maximize"]');
  button.removeAttribute('aria-label');
  bindWindowControlEvents({
    documentRef: doc,
    windowRef: {},
    shell: { windowControl: async () => ({ ok: true }) },
    registerListener() {},
  });
  assert.equal(button.getAttribute('aria-label'), 'Maximize');
  assert.equal(button.dataset.maximized, 'false');
});

function bindCollecting(doc, shell, extra = {}) {
  const listeners = [];
  const controls = bindWindowControlEvents({
    documentRef: doc,
    windowRef: {},
    shell,
    registerListener(target, eventName, handler) {
      if (target) listeners.push({ target, eventName, handler });
    },
    appendClientLog() {},
    ...extra,
  });
  return { listeners, controls };
}

test('double-click on a role="status" node (or a control) does not maximize; on the gutter it does', async () => {
  const doc = createDom().window.document;
  const calls = [];
  const { listeners } = bindCollecting(doc, { windowControl: async (action) => { calls.push(action); return { ok: true }; } });
  const dblclick = listeners.find((entry) => entry.eventName === 'dblclick');
  assert.ok(dblclick, 'title bar double-click is bound');
  const fire = (target) => dblclick.handler({ target, preventDefault() {} });

  await fire(doc.getElementById('titlebarStatusText'));
  await fire(doc.querySelector('[data-window-action="close"] svg'));
  await tick();
  assert.deepEqual(calls, [], 'status text and controls own their double-clicks');

  await fire(doc.querySelector('.titlebar-center'));
  await tick();
  assert.deepEqual(calls, ['maximize'], 'the drag gutter maximizes');
});

test('rejected control actions are logged without escaping the click handler', async () => {
  const doc = createDom().window.document;
  const logs = [];
  const { listeners } = bindCollecting(doc, {
    windowControl: async () => { throw new Error('control failed'); },
  }, { appendClientLog(level, event, details) { logs.push({ level, event, details }); } });

  const clickListener = listeners.find((listener) => listener.eventName === 'click');
  assert.ok(clickListener);
  await assert.doesNotReject(() => clickListener.handler({ target: clickListener.target, preventDefault() {} }));
  assert.equal(logs.some((entry) => entry.event === 'window.control_failed'), true);
});

function bindWithPreflight({ preflightExit, windowControl }) {
  const doc = createDom().window.document;
  const { listeners } = bindCollecting(doc, { windowControl }, { preflightExit });
  const clickFor = (action) => {
    const button = doc.querySelector(`[data-window-action="${action}"]`);
    const listener = listeners.find((entry) => entry.eventName === 'click' && entry.target === button);
    return () => listener.handler({ target: button, preventDefault() {} });
  };
  return { clickFor };
}

test('close routes through the exit preflight and aborts when it returns proceed:false', async () => {
  const preflightCalls = [];
  const controlCalls = [];
  const { clickFor } = bindWithPreflight({
    preflightExit: async (action) => { preflightCalls.push(action); return { proceed: false, reason: 'canceled' }; },
    windowControl: async (action) => { controlCalls.push(action); return { ok: true }; },
  });

  await clickFor('close')();

  assert.deepEqual(preflightCalls, ['close'], 'close must preflight first');
  assert.deepEqual(controlCalls, [], 'a canceled preflight must abort the close');
});

test('close proceeds only when the preflight authorizes it', async () => {
  const controlCalls = [];
  const { clickFor } = bindWithPreflight({
    preflightExit: async () => ({ proceed: true, reason: 'clean' }),
    windowControl: async (action) => { controlCalls.push(action); return { ok: true }; },
  });

  await clickFor('close')();

  assert.deepEqual(controlCalls, ['close']);
});

test('minimize and maximize never invoke the exit preflight', async () => {
  const preflightCalls = [];
  const controlCalls = [];
  const { clickFor } = bindWithPreflight({
    preflightExit: async (action) => { preflightCalls.push(action); return { proceed: true }; },
    windowControl: async (action) => { controlCalls.push(action); return { ok: true }; },
  });

  await clickFor('minimize')();
  await clickFor('maximize')();

  assert.deepEqual(preflightCalls, [], 'non-destructive controls skip the preflight');
  assert.deepEqual(controlCalls, ['minimize', 'maximize']);
});

test('a stale initial state never overrides a live update', async () => {
  const doc = createDom().window.document;
  const initialState = deferred();
  let stateListener = null;

  bindWindowControlEvents({
    documentRef: doc,
    windowRef: {},
    shell: {
      window: {
        getState: () => initialState.promise,
        onStateChanged(callback) { stateListener = callback; return () => {}; },
      },
      windowControl: async () => ({ ok: true, maximized: false, minimized: false }),
    },
    registerListener() {},
    addCleanup() {},
  });

  stateListener({ ok: true, maximized: true, minimized: false });
  initialState.resolve({ ok: true, maximized: false, minimized: false });
  await initialState.promise;
  await Promise.resolve();

  const button = doc.querySelector('[data-window-action="maximize"]');
  assert.equal(button.getAttribute('aria-label'), 'Restore');
  assert.equal(button.dataset.maximized, 'true');
});

test('the shell binds the cluster once per document, independent of the chat controllers', async () => {
  const dom = createDom();
  const doc = dom.window.document;
  const calls = [];
  const logs = [];
  dom.window.jennyShell = {
    windowControl: async (action) => {
      calls.push(action);
      if (action === 'minimize') throw new Error('nope');
      return { ok: true };
    },
  };

  const first = bindShellWindowControls({ documentRef: doc, windowRef: dom.window });
  const second = bindShellWindowControls({
    documentRef: doc,
    windowRef: dom.window,
    appendClientLog: (level, event) => logs.push(event),
  });
  assert.ok(first);
  assert.equal(second, first, 'idempotent');

  doc.querySelector('[data-window-action="maximize"]').click();
  doc.querySelector('[data-window-action="minimize"]').click();
  await tick();
  assert.deepEqual(calls, ['maximize', 'minimize'], 'one listener per tile, not two');
  assert.deepEqual(logs, ['window.control_failed'], 'the logger handed over later is used');
});

// The booted app: one listener per tile (the chat event layer no longer binds
// the cluster a second time) and the app shell's client logger is the one the
// cluster and the guarded reload log through.
test('in the booted app a tile runs once and window failures reach the client log', async (t) => {
  const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
  const app = await loadRendererApp();
  t.after(async () => app.dispose());
  const { window } = app;
  const calls = [];
  window.jennyShell.windowControl = async (action) => {
    calls.push(action);
    if (action === 'minimize') throw new Error('minimize refused');
    return { ok: true, maximized: false, minimized: false };
  };
  const loggedEvents = () => window.__rendererState.logs.map((entry) => entry.event);

  window.document.querySelector('[data-window-action="minimize"]').click();
  await waitForUi(window);
  assert.deepEqual(calls, ['minimize'], 'one listener per tile, not two');
  assert.ok(loggedEvents().includes('window.control_failed'), 'the app shell handed the cluster its logger');

  window.jennyWindowExitPreflight = { preflightExit: async () => { throw new Error('dirty-state probe failed'); } };
  const composer = window.document.getElementById('composerInput') || window.document.querySelector('textarea');
  composer.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'R', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  await waitForUi(window);
  assert.deepEqual(calls, ['minimize'], 'a failed preflight never reloads');
  assert.ok(loggedEvents().includes('window.exit_preflight_failed'), 'Ctrl+Shift+R from the composer logs a thrown preflight');
});
