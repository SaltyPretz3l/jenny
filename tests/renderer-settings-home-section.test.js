'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const homeSection = require('../renderer/shell/renderer-settings-home-section');
const selectField = require('../renderer/inventory/select-field');
const toggleSwitchModule = require('../renderer/inventory/toggle-switch');

// Awaits the callback so an async test keeps its window/inventory globals
// until it finishes (a sync finally would restore them at the first await,
// and a queued write reads the bridge when the coordinator flushes it).
async function withGlobals(run) {
  const previous = { window: globalThis.window, inventory: globalThis.inventory };
  globalThis.inventory = { selectField, toggleSwitch: toggleSwitchModule.toggleSwitch };
  try { return await run(); } finally { globalThis.window = previous.window; globalThis.inventory = previous.inventory; }
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
    widgets: {},
    scratchpad: { notes: [], activeNoteId: '', settings: {}, pins: [] },
    calendar: {},
    focusMode: false,
    showContextualTips: true,
    ...overrides,
  };
}

function captureOption(container, value) {
  return container.querySelector(`[data-inv-segmented="homeScratchpadCaptureSelect"] [data-value="${value}"]`);
}
function pickCaptureMode(dom, container, value) {
  container.dispatchEvent(new dom.window.CustomEvent('inv-segmented-change', { bubbles: true,
    detail: { id: 'homeScratchpadCaptureSelect', value } }));
}

test('Home Settings exposes only quick capture: a two-option segmented mode and the shortcut switch', () => {
  return withGlobals(() => {
    const { container, status } = harness();
    const state = { homeConfig: { showContextualTips: true, scratchpad: { settings: { captureMode: 'overwrite', globalCapture: false } } } };
    homeSection.renderHomeSection({ container, status, state });
    assert.equal(captureOption(container, 'overwrite').getAttribute('aria-checked'), 'true');
    assert.equal(captureOption(container, 'append').getAttribute('aria-checked'), 'false');
    assert.equal(container.querySelector('[data-settings-field="homeScratchpadCaptureSelect"] .settings-field-meta-modified').hidden, false);
    assert.equal(container.querySelector('[data-inv-toggle="homeScratchpadGlobalCaptureToggle"]').getAttribute('aria-checked'), 'false');
    // Owner decision D2: the contextual-tips switch is gone from Settings.
    assert.equal(container.querySelector('[data-inv-toggle="homeContextualTipsToggle"]'), null);
    assert.equal(container.querySelectorAll('[data-inv-toggle]').length, 1);
    assert.equal(status.hidden, true);
    assert.equal(status.textContent, '');
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
    assert.equal(status.textContent, '');
    assert.equal(status.hidden, true);
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
    pickCaptureMode(dom, container, 'overwrite');
    await flush();

    writes[0].pending.resolve(completeHome({
      scratchpad: { ...initial.scratchpad, settings: { ...initial.scratchpad.settings, globalCapture: false } },
    }));
    await flush();
    assert.deepEqual(writes[1].patch, { scratchpad: { settings: { captureMode: 'overwrite', globalCapture: false } } });
    writes[1].pending.resolve(completeHome({
      scratchpad: { ...initial.scratchpad, settings: { captureMode: 'overwrite', globalCapture: false } },
    }));
    await flush();

    assert.equal(state.homeConfig.scratchpad.settings.globalCapture, false);
    assert.equal(state.homeConfig.scratchpad.settings.captureMode, 'overwrite');
    assert.equal(status.textContent, '');
    assert.equal(status.hidden, true);
  });
});

test('failed Home preference write restores state and the control and leaves a visible error', async () => {
  await withGlobals(async () => {
    const { dom, container, status } = harness();
    globalThis.window = dom.window;
    const prior = completeHome({ scratchpad: { notes: [], activeNoteId: '', pins: [], settings: { captureMode: 'append', globalCapture: true } } });
    const state = { homeConfig: prior };
    dom.window.jennyShell = { home: { async updateConfig() { throw new Error('disk full'); } } };
    const render = () => homeSection.renderHomeSection({ container, status, state });
    render();
    homeSection.bindHomeSection({ container, status, state, renderSettings: render, registerListener });
    container.dispatchEvent(new dom.window.CustomEvent('inv-toggle-change', { bubbles: true,
      detail: { id: 'homeScratchpadGlobalCaptureToggle', checked: false } }));
    await flush();
    assert.equal(state.homeConfig, prior);
    assert.equal(container.querySelector('[data-inv-toggle="homeScratchpadGlobalCaptureToggle"]').getAttribute('aria-checked'), 'true');
    assert.equal(status.dataset.state, 'error');
    assert.match(status.textContent, /previous setting was restored/i);
    assert.equal(status.hidden, false);
  });
});

test('partial Home acknowledgement is rejected without replacing the prior snapshot', async () => {
  await withGlobals(async () => {
    const { dom, container, status } = harness();
    globalThis.window = dom.window;
    const prior = completeHome({
      links: [{ id: 'docs', name: 'Docs', tiles: [] }],
      showContextualTips: false,
    });
    const state = { homeConfig: prior };
    dom.window.jennyShell = { home: { async updateConfig(patch) {
      return { ...prior, links: [], scratchpad: { ...prior.scratchpad, ...patch.scratchpad } };
    } } };
    const render = () => homeSection.renderHomeSection({ container, status, state });
    render();
    homeSection.bindHomeSection({ container, status, state, renderSettings: render, registerListener });
    pickCaptureMode(dom, container, 'overwrite');
    await flush();
    assert.equal(state.homeConfig, prior);
    assert.equal(captureOption(container, 'append').getAttribute('aria-checked'), 'true', 'the control is rolled back');
    assert.equal(status.dataset.state, 'error');
    assert.match(status.textContent, /previous setting was restored/i);
    assert.equal(status.hidden, false);
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

test('picking a capture mode writes only scratchpad.settings through home.updateConfig and adopts the acknowledgement', async () => {
  await withGlobals(async () => {
    const { dom, container, status } = harness();
    globalThis.window = dom.window;
    const patches = [];
    const state = { homeConfig: completeHome({ scratchpad: { notes: [], activeNoteId: '', pins: [], settings: { captureMode: 'append', globalCapture: true } } }) };
    dom.window.jennyShell = { home: { async updateConfig(patch) {
      patches.push(patch);
      return { ...state.homeConfig, scratchpad: { ...state.homeConfig.scratchpad, ...patch.scratchpad } };
    } } };
    const render = () => homeSection.renderHomeSection({ container, status, state });
    render();
    homeSection.bindHomeSection({ container, status, state, renderSettings: render, registerListener });
    pickCaptureMode(dom, container, 'overwrite');
    await flush();
    assert.deepEqual(patches, [{ scratchpad: { settings: { captureMode: 'overwrite', globalCapture: true } } }]);
    assert.equal(state.homeConfig.scratchpad.settings.captureMode, 'overwrite');
    assert.equal(captureOption(container, 'overwrite').getAttribute('aria-checked'), 'true');
    assert.equal(status.textContent, '');
    assert.equal(status.hidden, true);
  });
});

test('a Home write in flight when Settings reopens is the baseline of the next binding\'s write', async () => {
  await withGlobals(async () => {
    const first = harness();
    const second = harness();
    globalThis.window = first.dom.window;
    const state = { homeConfig: completeHome({ scratchpad: { notes: [], activeNoteId: '', pins: [], settings: { captureMode: 'append', globalCapture: true } } }) };
    const writes = [];
    const bridge = { home: { updateConfig(patch) {
      const pending = deferred();
      writes.push({ patch, pending });
      return pending.promise;
    } } };
    first.dom.window.jennyShell = bridge;
    second.dom.window.jennyShell = bridge;
    homeSection.bindHomeSection({ container: first.container, status: first.status, state, renderSettings() {}, registerListener });
    pickCaptureMode(first.dom, first.container, 'overwrite');
    await flush();
    assert.equal(writes.length, 1);
    globalThis.window = second.dom.window;
    homeSection.bindHomeSection({ container: second.container, status: second.status, state, renderSettings() {}, registerListener });
    second.container.dispatchEvent(new second.dom.window.CustomEvent('inv-toggle-change', { bubbles: true,
      detail: { id: 'homeScratchpadGlobalCaptureToggle', checked: false } }));
    await flush();
    assert.equal(writes.length, 1, 'queued behind the first binding\'s write');
    const ack = (write) => ({ ...state.homeConfig, scratchpad: { ...state.homeConfig.scratchpad, ...write.patch.scratchpad } });
    writes[0].pending.resolve(ack(writes[0]));
    await flush();
    assert.equal(state.homeConfig.scratchpad.settings.captureMode, 'overwrite');
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[1].patch.scratchpad.settings, { captureMode: 'overwrite', globalCapture: false }, 'composed on the acknowledged value');
    writes[1].pending.resolve(ack(writes[1]));
    await flush();
    assert.equal(state.homeConfig.scratchpad.settings.globalCapture, false);
    assert.equal(second.status.textContent, '');
    assert.equal(second.status.hidden, true);
  });
});
