const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createContextPanelController } = require('../renderer/features/renderer-context-panel-utils.js');

test('dispose cancels the delayed composer layout update after a panel toggle', () => {
  const dom = new JSDOM('<button id="toggle"></button><aside id="panel"></aside>');
  const documentRef = dom.window.document;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const timers = new Map();
  let nextTimerId = 0;
  let updates = 0;
  global.setTimeout = (callback) => {
    nextTimerId += 1;
    timers.set(nextTimerId, callback);
    return nextTimerId;
  };
  global.clearTimeout = (timerId) => timers.delete(timerId);

  try {
    const controller = createContextPanelController({
      state: { ui: { activeView: 'chat' } },
      dom: {
        chatContextPanel: documentRef.getElementById('panel'),
        contextPanelToggle: documentRef.getElementById('toggle'),
      },
      callbacks: {
        updateComposerSafeOffset() { updates += 1; },
        escapeHtml: String,
      },
      constants: {},
    });
    controller.bind();
    documentRef.getElementById('toggle').click();
    assert.equal(updates, 1);

    controller.dispose();
    for (const callback of timers.values()) callback();

    assert.equal(updates, 1);
    assert.equal(timers.size, 0);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

function bindWithStoredPreference(stored) {
  const dom = new JSDOM('<button id="toggle"></button><aside id="panel"></aside>');
  const documentRef = dom.window.document;
  const originalLocalStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => (stored === undefined ? null : JSON.stringify(stored)),
      setItem() {},
    },
  });
  try {
    const controller = createContextPanelController({
      state: { ui: { activeView: 'chat' } },
      dom: {
        chatContextPanel: documentRef.getElementById('panel'),
        contextPanelToggle: documentRef.getElementById('toggle'),
      },
      callbacks: { updateComposerSafeOffset() {}, escapeHtml: String },
      constants: {},
    });
    controller.bind();
    const collapsed = documentRef.getElementById('panel').classList.contains('collapsed');
    controller.dispose();
    return collapsed;
  } finally {
    if (originalLocalStorage === undefined) {
      delete globalThis.localStorage;
    } else {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage });
    }
  }
}

test('the context panel starts collapsed unless the user explicitly expanded it', () => {
  assert.equal(bindWithStoredPreference(undefined), true, 'fresh profile collapses');
  assert.equal(bindWithStoredPreference({}), true, 'stored prefs without the key collapse');
  assert.equal(bindWithStoredPreference({ collapsed: true }), true);
  assert.equal(bindWithStoredPreference({ collapsed: false }), false, 'an explicit expand is honored');
});
