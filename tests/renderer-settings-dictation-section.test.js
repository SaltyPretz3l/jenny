'use strict';

// Settings > Dictation (row 84): the switch row, the microphone picker writing
// windowUi.dictation.deviceId, and the speech model row's states and actions.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function flush() { for (let i = 0; i < 5; i += 1) await settle(); }

function harness({ model = { state: 'not_installed' }, deviceId = '', devices = [] } = {}) {
  const dom = new JSDOM(`<!doctype html><body><section id="dictationSettingsSection">
    <div id="dictationGeneralList"></div><div id="dictationModelList"></div></section></body>`);
  const { window } = dom;
  const saved = { globals: {} };
  for (const key of ['window', 'document', 'navigator', 'inventory']) saved.globals[key] = globalThis[key];
  globalThis.window = window;
  globalThis.document = window.document;
  Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: { enumerateDevices: () => Promise.resolve(devices) } }, configurable: true, writable: true });
  globalThis.inventory = {
    settingsField: require('../renderer/inventory/settings-field'),
    selectField: require('../renderer/inventory/select-field'),
    actionButton: require('../renderer/inventory/action-button').actionButton || require('../renderer/inventory/action-button'),
    toggleSwitch: require('../renderer/inventory/toggle-switch').toggleSwitch,
  };
  delete require.cache[require.resolve('../renderer/shell/renderer-settings-dictation-section')];
  const section = require('../renderer/shell/renderer-settings-dictation-section');
  const calls = { setup: 0, cancel: 0, remove: 0, updates: [], pageRenders: 0 };
  let listener = null;
  window.jennyShell = {
    dictation: {
      getState: () => Promise.resolve(model),
      onChanged: (fn) => { listener = fn; return () => { listener = null; }; },
      setup: () => { calls.setup += 1; return Promise.resolve({ ok: true }); },
      cancel: () => { calls.cancel += 1; return Promise.resolve({ ok: true }); },
      remove: () => { calls.remove += 1; return Promise.resolve({ ok: true }); },
    },
    windowUi: { updateSettings: (patch) => { calls.updates.push(patch); return Promise.resolve(patch); } },
  };
  const state = { features: { featureFlags: { dictation: true } }, ui: { dictation: { deviceId } } };
  const container = window.document.getElementById('dictationSettingsSection');
  const render = () => section.renderDictationSection({ container, state });
  const listeners = [];
  section.bindDictationSection({
    container, state, renderSettings: () => { calls.pageRenders += 1; },
    registerListener: (target, type, fn) => { target.addEventListener(type, fn); listeners.push(() => target.removeEventListener(type, fn)); },
  });
  render();
  const restore = () => {
    section.disposeDictationSection();
    listeners.forEach((fn) => fn());
    for (const [key, value] of Object.entries(saved.globals)) {
      if (value === undefined) delete globalThis[key]; else Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }
  };
  return { window, container, state, calls, restore, push: (next) => listener && listener(next), q: (s) => container.querySelector(s) };
}

test('the model row walks not installed -> downloading -> ready -> remove with a confirm', async (t) => {
  const h = harness();
  t.after(h.restore);
  await flush();
  assert.match(h.q('#dictationModelList').textContent, /Not installed/);
  h.q('#dictationModelDownload').click();
  await flush();
  assert.equal(h.calls.setup, 1);
  h.push({ state: 'downloading', downloadedBytes: 214e6, totalBytes: 672947357 });
  assert.match(h.q('#dictationModelList').textContent, /214 of 673 MB/);
  assert.equal(h.calls.pageRenders, 0, 'progress repaints the section, never the whole Settings page');
  h.q('#dictationModelCancel').click();
  await flush();
  assert.equal(h.calls.cancel, 1);
  h.push({ state: 'ready', downloadedBytes: 672947357, totalBytes: 672947357 });
  assert.match(h.q('#dictationModelList').textContent, /Ready/);
  h.q('#dictationModelRemove').click();
  assert.match(h.q('#dictationModelList').textContent, /stops working until you download/);
  assert.equal(h.calls.remove, 0, 'the first click only asks');
  h.q('#dictationModelRemoveConfirm').click();
  await flush();
  assert.equal(h.calls.remove, 1);
});

test('a failed download shows its message and offers Try again', async (t) => {
  const h = harness({ model: { state: 'failed', error: { reason: 'checksum_mismatch' } } });
  t.after(h.restore);
  await flush();
  assert.match(h.q('#dictationModelList').textContent, /Failed/);
  assert.match(h.q('#dictationModelList').textContent, /The download was damaged\. Try again\./);
  assert.equal(h.q('#dictationModelDownload').textContent.trim(), 'Try again');
});

test('the microphone picker lists inputs and saves the choice to windowUi.dictation', async (t) => {
  const h = harness({ deviceId: 'gone', devices: [
    { kind: 'audioinput', deviceId: 'default', label: 'Default' },
    { kind: 'audioinput', deviceId: 'mic-a', label: 'Headset Microphone' },
    { kind: 'audioinput', deviceId: 'mic-b', label: '' },
    { kind: 'videoinput', deviceId: 'cam', label: 'Camera' },
  ] });
  t.after(h.restore);
  await flush();
  const select = h.q('#dictationMicrophoneSelect');
  const labels = Array.from(select.options).map((o) => o.textContent);
  assert.deepEqual(labels, ['System default', 'Headset Microphone', 'Microphone 2', 'Saved microphone (not connected)']);
  select.value = 'mic-a';
  select.dispatchEvent(new h.window.Event('change', { bubbles: true }));
  await flush();
  assert.deepEqual(h.calls.updates, [{ dictation: { deviceId: 'mic-a' } }]);
  assert.equal(h.state.ui.dictation.deviceId, 'mic-a');
});

test('the shortcut row names the fixed chord', async (t) => {
  const h = harness();
  t.after(h.restore);
  assert.equal(h.q('.settings-dictation-kbd').textContent, 'Ctrl+Space');
});
