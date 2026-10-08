'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const manifest = require('../renderer/shell/renderer-settings-script-manifest');
const { createSettingsRenderer } = require('../renderer/shell/renderer-settings-chrome');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

function fakeGroup({ fail = '', hold = false } = {}) {
  const requests = [];
  const logs = [];
  let builds = 0;
  let release;
  let failure = fail;
  const gate = hold ? new Promise((resolve) => { release = resolve; }) : Promise.resolve();
  const page = { renderSettings() {}, dispose() {} };
  const windowRef = {
    rendererSettingsScriptManifest: manifest,
    scriptLoaderUtils: {
      ensureScript({ src, isReady }) {
        requests.push(src);
        return gate.then(() => {
          if (isReady()) return true;
          if (src === failure) return false;
          const name = manifest.find(([entry]) => entry === src)[1];
          windowRef[name] = name === 'rendererSettingsUtils'
            ? { createSettingsRenderer() { builds += 1; return page; } }
            : {};
          return isReady();
        });
      },
    },
  };
  const state = { ui: { activeView: 'chat' } };
  // Enough composer DOM for renderComposerCarriers, which every renderSettings call runs.
  const dom = { composerModelSelect: { dataset: {}, innerHTML: '', value: '' }, composerEffortSelect: { dataset: {}, value: '' } };
  const chrome = createSettingsRenderer({
    windowRef,
    state,
    dom,
    callbacks: {
      appendClientLog: (...args) => logs.push(args),
      getCurrentRuntimePreferences: () => ({ preferredModel: '', reasoningEffort: '' }),
      buildModelOptionMarkup: () => '<option>fake</option>',
    },
  });
  return { chrome, page, windowRef, requests, logs, release, state, dom, get builds() { return builds; }, retry() { failure = ''; } };
}

async function waitForLoads() {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('chat boot evaluates no lazy Settings module and requests none', async (t) => {
  const { window, dispose } = await loadRendererApp();
  t.after(dispose);
  for (const [src, name] of manifest) {
    assert.equal(window[name], undefined, `chat boot evaluated ${src}`);
  }
  assert.deepEqual(window.scriptLoaderUtils.requests.filter((src) => manifest.some(([entry]) => entry === src)), []);
});

test('opening Settings loads one ordered group and renders the page', async (t) => {
  const { window, dispose } = await loadRendererApp();
  t.after(dispose);
  window.document.querySelector('[data-tab-id="settings"]').click();
  window.document.querySelector('[data-tab-id="settings"]').click();
  await waitForUi(window, 100);
  assert.deepEqual(window.scriptLoaderUtils.requests.filter((src) => manifest.some(([entry]) => entry === src)), manifest.map(([src]) => src));
  assert.ok(window.document.querySelector('[data-setting-mount="appearancePaletteSelect"] select'), 'Appearance row painted after loading');
  assert.ok(window.document.getElementById('settingsSearchInput'), 'the Settings search box renders (its module stays eager: nav-utils reads it at load time)');
});

test('concurrent triggers share one flight and inject the entire group before awaiting', async (t) => {
  const h = fakeGroup({ hold: true });
  t.after(() => h.chrome.dispose());
  const callbacks = [];
  h.chrome.whenSettingsPageReady(() => callbacks.push('first'));
  h.chrome.whenSettingsPageReady(() => callbacks.push('second'));
  const first = h.chrome.ensureSettingsPage();
  const second = h.chrome.ensureSettingsPage();
  assert.equal(first, second);
  assert.deepEqual(h.requests, manifest.map(([src]) => src));
  assert.equal(h.builds, 0);
  h.release();
  assert.equal(await first, h.page);
  assert.equal(await h.chrome.ensureSettingsPage(), h.page);
  h.chrome.whenSettingsPageReady(() => callbacks.push('late'));
  assert.deepEqual(callbacks, ['first', 'second', 'late']);
  assert.equal(h.chrome.isSettingsPageLoaded(), true);
  assert.equal(h.builds, 1);
});

test('a failed script logs its src, deletes only failed globals, and the next trigger retries', async (t) => {
  const failedIndex = 2;
  const src = manifest[failedIndex][0];
  const h = fakeGroup({ fail: src });
  t.after(() => h.chrome.dispose());
  assert.equal(await h.chrome.ensureSettingsPage(), null);
  assert.equal(h.builds, 0);
  assert.ok(h.logs.some(([level, event, details]) => level === 'WARN' && event === 'settings.page_load_failed' && details.src === src));
  manifest.forEach(([, name], index) => {
    assert.equal(Boolean(h.windowRef[name]), index < failedIndex, `retained only successful global ${name}`);
  });
  const retained = h.windowRef[manifest[0][1]];
  h.retry();
  assert.equal(await h.chrome.ensureSettingsPage(), h.page);
  assert.equal(h.windowRef[manifest[0][1]], retained);
  assert.equal(h.builds, 1);
});

test('disposal during loading builds nothing and runs no queued callback', async (t) => {
  const h = fakeGroup({ hold: true });
  t.after(() => h.chrome.dispose());
  let callbacks = 0;
  h.chrome.whenSettingsPageReady(() => { callbacks += 1; });
  const loaded = h.chrome.ensureSettingsPage();
  h.chrome.dispose();
  h.release();
  assert.equal(await loaded, null);
  assert.equal(await h.chrome.ensureSettingsPage(), null);
  h.chrome.whenSettingsPageReady(() => { callbacks += 1; });
  assert.equal(h.builds, 0);
  assert.equal(callbacks, 0);
});

test('the titlebar load switch on chat loads Settings and persists before first opening', async (t) => {
  const { window, dispose } = await loadRendererApp();
  t.after(dispose);
  window.document.dispatchEvent(new window.CustomEvent('jenny:titlebar-load-toggle', { detail: { enabled: true } }));
  await waitForUi(window, 100);
  assert.equal(window.__rendererState.ui.activeView, 'chat');
  assert.equal(window.__rendererState.ui.appearance.titlebarLoad, true);
  assert.equal(JSON.parse(window.localStorage.getItem('jenny.appearance.v2')).titlebarLoad, true);
  assert.deepEqual(window.scriptLoaderUtils.requests.filter((src) => manifest.some(([entry]) => entry === src)), manifest.map(([src]) => src));
});

test('quick settings opens while the Settings group stays unloaded', async (t) => {
  const { window, dispose } = await loadRendererApp();
  t.after(dispose);
  window.rendererQuickSettingsModalController.open();
  await waitForUi(window, 50);
  assert.equal(window.rendererQuickSettingsModalController.isOpen(), true);
  for (const [, name] of manifest) assert.equal(window[name], undefined);
  assert.deepEqual(window.scriptLoaderUtils.requests.filter((src) => manifest.some(([entry]) => entry === src)), []);
});

test('the palette lists the settings items on its first query without loading the Settings group', async (t) => {
  let providers;
  const { window, dispose } = await loadRendererApp({
    shell: { features: { state: { featureFlags: { command_palette: true } } } },
    beforeRendererBoot(win) {
      const create = win.rendererCommandPaletteProviders.createPaletteProviders;
      win.rendererCommandPaletteProviders.createPaletteProviders = (deps) => {
        providers = create(deps);
        return providers;
      };
    },
  });
  t.after(dispose);
  assert.ok(providers.snapshot().some((item) => item.id === 'setting:section:appearance'));
  await waitForUi(window, 100);
  assert.deepEqual(window.scriptLoaderUtils.requests.filter((src) => manifest.some(([entry]) => entry === src)), []);
  for (const [, name] of manifest) assert.equal(window[name], undefined);
});

test('a direct renderSettings on chat rebuilds the composer carriers while the group stays unloaded', async (t) => {
  const h = fakeGroup({ hold: true });
  t.after(() => h.chrome.dispose());
  h.chrome.renderSettings();
  assert.equal(h.dom.composerModelSelect.innerHTML, '<option>fake</option>', 'the carriers were rebuilt');
  assert.equal(h.requests.length, 0, 'chat never requests the group');
  assert.equal(h.builds, 0);
});

test('a failed page load is retried on the next Settings activation, not on every render pass', async (t) => {
  const failing = manifest[1][0];
  const h = fakeGroup({ fail: failing });
  t.after(() => h.chrome.dispose());
  h.state.ui.activeView = 'settings';
  h.chrome.renderSettings();
  await waitForLoads();
  assert.equal(h.logs.filter(([, event]) => event === 'settings.page_load_failed').length, 1);
  h.chrome.renderSettings();
  h.chrome.renderSettings();
  await waitForLoads();
  assert.equal(h.logs.filter(([, event]) => event === 'settings.page_load_failed').length, 1, 'render passes on the failed view do not retry');
  h.state.ui.activeView = 'chat';
  h.chrome.renderSettings();
  h.state.ui.activeView = 'settings';
  h.retry();
  h.chrome.renderSettings();
  await waitForLoads();
  assert.equal(h.builds, 1, 'the next activation retried and built the page');
});

test('the PDF deep link from chat opens Tools and focuses the add-on group with the group unloaded', async (t) => {
  const { window, dispose } = await loadRendererApp({
    shell: { pdfAddon: { getState: async () => ({ state: 'not_installed' }) } },
  });
  t.after(dispose);
  const doc = window.document;
  assert.equal(window.__rendererState.ui.activeView, 'chat');
  doc.getElementById('chatTimeline').insertAdjacentHTML('beforeend', '<span role="link" tabindex="0" data-inv-error-action="open_pdf_addon_settings">Set up PDF reading</span>');
  const scrolled = [];
  window.HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this.id); };
  doc.querySelector('[data-inv-error-action="open_pdf_addon_settings"]').click();
  await waitForUi(window, 300);
  assert.equal(window.__rendererState.ui.activeView, 'settings');
  assert.equal(doc.querySelector('.settings-card.settings-section-active')?.dataset.settingsSection, 'tools');
  assert.ok(scrolled.includes('toolsPdfAddonHost'), 'the add-on group is scrolled into view after the page loaded (the harness group has no focusable control)');
});

test('persisted Settings launch renders before notifyBootViewReady', async (t) => {
  let ready = false;
  const { window, dispose } = await loadRendererApp({
    persistedActiveView: 'settings',
    beforeRendererBoot(win) {
      const create = win.rendererShellStatusControllerUtils.createShellStatusController;
      win.rendererShellStatusControllerUtils.createShellStatusController = (deps) => {
        const controller = create(deps);
        const notify = controller.notifyBootViewReady;
        controller.notifyBootViewReady = (...args) => {
          assert.ok(win.document.querySelector('[data-setting-mount="appearancePaletteSelect"] select'), 'Settings painted before ready');
          ready = true;
          return notify(...args);
        };
        return controller;
      };
    },
  });
  t.after(dispose);
  assert.equal(ready, true);
  assert.equal(window.__rendererState.ui.activeView, 'settings');
});
