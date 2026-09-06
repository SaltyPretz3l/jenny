'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const homeSection = require('../renderer/shell/renderer-settings-home-section');
const selectField = require('../renderer/inventory/select-field');
const toggleSwitchModule = require('../renderer/inventory/toggle-switch');

function withGlobals(run) {
  const previous = { window: globalThis.window, inventory: globalThis.inventory };
  globalThis.inventory = { selectField, toggleSwitch: toggleSwitchModule.toggleSwitch };
  try { return run(); } finally { globalThis.window = previous.window; globalThis.inventory = previous.inventory; }
}
function harness() {
  const dom = new JSDOM('<div id="host"></div><div id="status"></div>');
  return { dom, container: dom.window.document.getElementById('host'), status: dom.window.document.getElementById('status') };
}
function registerListener(target, name, handler, options) { target.addEventListener(name, handler, options); }
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function completeHome(overrides = {}) {
  return {
    links: [],
    weather: {},
    widgets: {},
    scratchpad: { notes: [], activeNoteId: '', settings: {}, pins: [] },
    calendar: {},
    focusMode: false,
    showContextualTips: true,
    ...overrides,
  };
}

test('Home Settings exposes only quick capture and the single contextual tips preference', () => {
  withGlobals(() => {
    const { container } = harness();
    const state = { homeConfig: { showContextualTips: true, scratchpad: { settings: { captureMode: 'overwrite', globalCapture: false } } } };
    assert.deepEqual(homeSection.readSettings(state), { captureMode: 'overwrite', globalCapture: false, showContextualTips: true });
    homeSection.renderHomeSection({ container, state });
    assert.equal(container.querySelector('#homeScratchpadCaptureSelect').value, 'overwrite');
    assert.equal(container.querySelector('[data-inv-toggle="homeScratchpadGlobalCaptureToggle"]').getAttribute('aria-checked'), 'false');
    assert.equal(container.querySelector('[data-inv-toggle="homeContextualTipsToggle"]').getAttribute('aria-checked'), 'true');
    assert.equal(container.querySelector('#homeScratchpadFontSelect'), null);
    assert.equal(container.querySelector('[data-inv-toggle="sessionsOpenInNewTabToggle"]'), null);
  });
});

test('Home preference writes preserve Scratchpad siblings and adopt acknowledged state', async () => {
  await withGlobals(async () => {
    const { dom, container, status } = harness();
    globalThis.window = dom.window;
    const patches = [];
    const state = { homeConfig: completeHome({ showContextualTips: false, scratchpad: { notes: [], activeNoteId: '', pins: [], settings: { rows: 8, font: 'mono', captureMode: 'append', markdown: true, globalCapture: true } } }) };
    dom.window.jennyShell = { home: { async updateConfig(patch) {
      patches.push(patch);
      return {
        ...state.homeConfig,
        ...patch,
        scratchpad: patch.scratchpad
          ? { ...state.homeConfig.scratchpad, ...patch.scratchpad }
          : state.homeConfig.scratchpad,
      };
    } } };
    homeSection.bindHomeSection({ container, status, state, renderSettings() {}, registerListener });
    container.dispatchEvent(new dom.window.CustomEvent('inv-toggle-change', { bubbles: true,
      detail: { id: 'homeScratchpadGlobalCaptureToggle', checked: false } }));
    await flush();
    assert.deepEqual(patches[0].scratchpad.settings, { rows: 8, font: 'mono', captureMode: 'append', markdown: true, globalCapture: false });
    assert.equal(state.homeConfig.scratchpad.settings.globalCapture, false);
    assert.equal(status.textContent, 'Home preferences saved.');
  });
});

test('rapid writes to different Home preferences adopt both acknowledgements', async () => {
  await withGlobals(async () => {
    const { dom, container, status } = harness();
    globalThis.window = dom.window;
    const initial = completeHome({
      scratchpad: { notes: [], activeNoteId: '', pins: [], settings: { captureMode: 'append', globalCapture: true } },
    });
    const state = { homeConfig: initial };
    const writes = [];
    dom.window.jennyShell = { home: { updateConfig(patch) {
      const pending = deferred();
      writes.push({ patch, pending });
      return pending.promise;
    } } };
    homeSection.bindHomeSection({ container, status, state, renderSettings() {}, registerListener });

    container.dispatchEvent(new dom.window.CustomEvent('inv-toggle-change', { bubbles: true,
      detail: { id: 'homeScratchpadGlobalCaptureToggle', checked: false } }));
    container.dispatchEvent(new dom.window.CustomEvent('inv-toggle-change', { bubbles: true,
      detail: { id: 'homeContextualTipsToggle', checked: false } }));
    await flush();

    writes[0].pending.resolve(completeHome({
      scratchpad: { ...initial.scratchpad, settings: { ...initial.scratchpad.settings, globalCapture: false } },
    }));
    await flush();
    writes[1].pending.resolve(completeHome({
      showContextualTips: false,
      scratchpad: { ...initial.scratchpad, settings: { ...initial.scratchpad.settings, globalCapture: false } },
    }));
    await flush();

    assert.equal(state.homeConfig.scratchpad.settings.globalCapture, false);
    assert.equal(state.homeConfig.showContextualTips, false);
    assert.equal(status.textContent, 'Home preferences saved.');
  });
});

test('failed Home preference write restores state and leaves a visible error', async () => {
  await withGlobals(async () => {
    const { dom, container, status } = harness();
    globalThis.window = dom.window;
    const state = { homeConfig: completeHome({ showContextualTips: false, scratchpad: { notes: [], activeNoteId: '', pins: [], settings: { captureMode: 'append', globalCapture: true } } }) };
    dom.window.jennyShell = { home: { async updateConfig() { throw new Error('disk full'); } } };
    homeSection.bindHomeSection({ container, status, state, renderSettings() {}, registerListener });
    container.dispatchEvent(new dom.window.CustomEvent('inv-toggle-change', { bubbles: true,
      detail: { id: 'homeContextualTipsToggle', checked: true } }));
    await flush();
    assert.equal(state.homeConfig.showContextualTips, false);
    assert.equal(status.dataset.state, 'error');
    assert.match(status.textContent, /previous setting was restored/i);
  });
});

test('partial Home acknowledgement is rejected without replacing the prior snapshot', async () => {
  await withGlobals(async () => {
    const { dom, container, status } = harness();
    globalThis.window = dom.window;
    const prior = completeHome({
      links: [{ id: 'docs', name: 'Docs', tiles: [] }],
      weather: { city: 'Chicago', units: 'imperial' },
      showContextualTips: false,
    });
    const state = { homeConfig: prior };
    dom.window.jennyShell = { home: { async updateConfig() {
      return { ...prior, weather: {}, showContextualTips: true };
    } } };
    homeSection.bindHomeSection({ container, status, state, renderSettings() {}, registerListener });
    container.dispatchEvent(new dom.window.CustomEvent('inv-toggle-change', { bubbles: true,
      detail: { id: 'homeContextualTipsToggle', checked: true } }));
    await flush();
    assert.equal(state.homeConfig, prior);
    assert.equal(status.dataset.state, 'error');
    assert.match(status.textContent, /previous setting was restored/i);
  });
});

test('Home Settings lazily hydrates when Home has not opened', async () => {
  await withGlobals(async () => {
    const { dom, container } = harness();
    globalThis.window = dom.window;
    const config = completeHome({ scratchpad: { notes: [], activeNoteId: '', pins: [], settings: { captureMode: 'append', globalCapture: true } } });
    dom.window.jennyShell = { home: { async getConfig() { return config; } } };
    const state = {};
    homeSection.bindHomeSection({ container, state, renderSettings() {}, registerListener });
    await flush();
    assert.equal(state.homeConfig.showContextualTips, true);
  });
});

test('disposed Home binding cannot overwrite a newer hydration after rebind', async () => {
  await withGlobals(async () => {
    const first = harness();
    const second = harness();
    globalThis.window = first.dom.window;
    const requests = [];
    first.dom.window.jennyShell = { home: { getConfig() {
      const pending = deferred();
      requests.push(pending);
      return pending.promise;
    } } };
    const state = {};
    const firstAbort = new first.dom.window.AbortController();
    const secondAbort = new second.dom.window.AbortController();
    let firstRenders = 0;
    let secondRenders = 0;

    homeSection.bindHomeSection({ container: first.container, state,
      renderSettings() { firstRenders += 1; }, registerListener,
      listenerOptions: { signal: firstAbort.signal } });
    firstAbort.abort();
    homeSection.bindHomeSection({ container: second.container, state,
      renderSettings() { secondRenders += 1; }, registerListener,
      listenerOptions: { signal: secondAbort.signal } });

    const newer = completeHome({ showContextualTips: false });
    requests[1].resolve(newer);
    await flush();
    requests[0].resolve(completeHome({ showContextualTips: true }));
    await flush();

    assert.equal(state.homeConfig, newer);
    assert.equal(firstRenders, 0);
    assert.equal(secondRenders, 1);
    secondAbort.abort();
  });
});
