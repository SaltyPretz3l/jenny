'use strict';

const { JSDOM } = require('jsdom');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyWindowStateToControls,
  bindWindowControlEvents,
} = require('../renderer/chat/renderer-window-controls-utils');

const MAXIMIZE_GLYPH = String.fromCodePoint(0x25a1);
const RESTORE_GLYPH = String.fromCodePoint(0x2750);

function createDom() {
  return new JSDOM(`
    <div class="window-controls">
      <button data-window-action="maximize" aria-label="Maximize" title="Maximize">${MAXIMIZE_GLYPH}</button>
    </div>
  `);
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

test('renderer window controls show restore affordance when maximized', () => {
  const dom = createDom();
  const button = dom.window.document.querySelector('[data-window-action="maximize"]');

  applyWindowStateToControls(dom.window.document, { ok: true, maximized: true });

  assert.equal(button.getAttribute('aria-label'), 'Restore window');
  assert.equal(button.getAttribute('title'), 'Restore window');
  assert.equal(button.textContent, RESTORE_GLYPH);
});

test('renderer window controls show maximize affordance when restored', () => {
  const dom = createDom();
  const button = dom.window.document.querySelector('[data-window-action="maximize"]');

  applyWindowStateToControls(dom.window.document, { ok: true, maximized: false });

  assert.equal(button.getAttribute('aria-label'), 'Maximize window');
  assert.equal(button.getAttribute('title'), 'Maximize window');
  assert.equal(button.textContent, MAXIMIZE_GLYPH);
});

test('renderer window controls log rejected control actions without escaping click handlers', async () => {
  const dom = createDom();
  const logs = [];
  const listeners = [];

  bindWindowControlEvents({
    documentRef: dom.window.document,
    windowRef: dom.window,
    shell: {
      windowControl: async () => {
        throw new Error('control failed');
      },
    },
    registerListener(target, eventName, handler) {
      if (target) {
        listeners.push({ target, eventName, handler });
      }
    },
    appendClientLog(level, event, details) {
      logs.push({ level, event, details });
    },
  });

  const clickListener = listeners.find((listener) => listener.eventName === 'click');
  assert.ok(clickListener);
  await assert.doesNotReject(() => clickListener.handler({
    target: clickListener.target,
    preventDefault() {},
  }));
  assert.equal(logs.some((entry) => entry.event === 'window.control_failed'), true);
});

function createControlsDom() {
  return new JSDOM(`
    <div class="titlebar">
      <div class="window-controls">
        <button data-window-action="minimize" aria-label="Minimize">_</button>
        <button data-window-action="maximize" aria-label="Maximize" title="Maximize">${MAXIMIZE_GLYPH}</button>
        <button data-window-action="reload" aria-label="Reload">R</button>
        <button data-window-action="close" aria-label="Close">X</button>
      </div>
    </div>
  `);
}

function bindWithPreflight({ preflightExit, windowControl }) {
  const dom = createControlsDom();
  const listeners = [];
  bindWindowControlEvents({
    documentRef: dom.window.document,
    windowRef: dom.window,
    shell: { windowControl },
    preflightExit,
    registerListener(target, eventName, handler) {
      if (target) {
        listeners.push({ target, eventName, handler });
      }
    },
    appendClientLog() {},
  });
  const clickFor = (action) => {
    const button = dom.window.document.querySelector(`[data-window-action="${action}"]`);
    const listener = listeners.find(
      (entry) => entry.eventName === 'click' && entry.target === button
    );
    return () => listener.handler({ target: button, preventDefault() {} });
  };
  return { dom, clickFor };
}

test('close routes through the exit preflight and aborts when it returns proceed:false', async () => {
  const preflightCalls = [];
  const controlCalls = [];
  const { clickFor } = bindWithPreflight({
    preflightExit: async (action) => {
      preflightCalls.push(action);
      return { proceed: false, reason: 'canceled' };
    },
    windowControl: async (action) => {
      controlCalls.push(action);
      return { ok: true };
    },
  });

  await clickFor('close')();

  assert.deepEqual(preflightCalls, ['close'], 'close must preflight first');
  assert.deepEqual(controlCalls, [], 'a canceled preflight must abort the close');
});

test('reload preflights and proceeds only when the preflight authorizes it', async () => {
  const preflightCalls = [];
  const controlCalls = [];
  const { clickFor } = bindWithPreflight({
    preflightExit: async (action) => {
      preflightCalls.push(action);
      return { proceed: true, reason: 'clean' };
    },
    windowControl: async (action) => {
      controlCalls.push(action);
      return { ok: true };
    },
  });

  await clickFor('reload')();

  assert.deepEqual(preflightCalls, ['reload'], 'reload must preflight first');
  assert.deepEqual(controlCalls, ['reload'], 'an authorized preflight proceeds to reload');
});

test('minimize and maximize never invoke the exit preflight', async () => {
  const preflightCalls = [];
  const controlCalls = [];
  const { clickFor } = bindWithPreflight({
    preflightExit: async (action) => {
      preflightCalls.push(action);
      return { proceed: true };
    },
    windowControl: async (action) => {
      controlCalls.push(action);
      return { ok: true };
    },
  });

  await clickFor('minimize')();
  await clickFor('maximize')();

  assert.deepEqual(preflightCalls, [], 'non-destructive controls skip the preflight');
  assert.deepEqual(controlCalls, ['minimize', 'maximize']);
});

test('renderer window controls ignore stale initial state after a live update', async () => {
  const dom = createDom();
  const initialState = deferred();
  let stateListener = null;

  bindWindowControlEvents({
    documentRef: dom.window.document,
    windowRef: dom.window,
    shell: {
      window: {
        getState: () => initialState.promise,
        onStateChanged(callback) {
          stateListener = callback;
          return () => {};
        },
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

  const button = dom.window.document.querySelector('[data-window-action="maximize"]');
  assert.equal(button.getAttribute('aria-label'), 'Restore window');
  assert.equal(button.textContent, RESTORE_GLYPH);
});
