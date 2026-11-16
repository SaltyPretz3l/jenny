'use strict';

// Top chrome (area 1, 2026-09-29): the "Show machine load in the title bar"
// appearance field. Default off, persisted with appearance, a lossless
// migration for records written before it existed, and never part of a theme
// bundle.
const test = require('node:test');
const assert = require('node:assert/strict');

const appearance = require('../renderer/shared/appearance-utils.js');
const { loadRendererApp, waitForUi, openSettingsView } = require('./helpers/renderer-shell-harness');

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

test('titlebarLoad defaults off for fresh, partial and garbled records', () => {
  assert.equal(appearance.getDefaultAppearancePreferences().titlebarLoad, false);
  assert.equal(appearance.normalizeAppearancePreferences({}).titlebarLoad, false);
  assert.equal(appearance.normalizeAppearancePreferences({ titlebarLoad: 'yes' }).titlebarLoad, false);
  assert.equal(appearance.normalizeAppearancePreferences({ titlebarLoad: 1 }).titlebarLoad, false);
  assert.equal(appearance.normalizeAppearancePreferences({ titlebarLoad: true }).titlebarLoad, true);
});

test('titlebarLoad persists through save and load', () => {
  const storage = createStorage();
  const saved = appearance.saveAppearancePreferences(storage, {
    ...appearance.getDefaultAppearancePreferences(),
    titlebarLoad: true,
  });
  assert.equal(saved.titlebarLoad, true);
  assert.equal(JSON.parse(storage.getItem(appearance.STORAGE_KEY)).titlebarLoad, true);
  assert.equal(appearance.loadAppearancePreferences(storage).titlebarLoad, true);
});

test('theme bundles never touch the title-bar read-out choice', () => {
  const picked = appearance.pickThemeBundleAxes({ titlebarLoad: true, paletteId: 'pewter' });
  assert.equal(Object.prototype.hasOwnProperty.call(picked, 'titlebarLoad'), false);
});

test('Settings > General › Machine status offers "Show machine load in the title bar" and persists it', async (t) => {
  const app = await loadRendererApp();
  t.after(async () => app.dispose());
  await openSettingsView(app.window);
  const { window } = app;
  // Row 133: the switch is stored with the appearance but drawn on General, under Machine status.
  const list = window.document.getElementById('generalTitlebarLoadList');
  assert.ok(list.closest('.settings-card[data-settings-section="general"]'));
  const toggle = list.querySelector('[data-inv-toggle="appearanceTitlebarLoadToggle"]');
  assert.ok(toggle, 'the toggle renders in the General list');
  assert.equal(window.document.querySelector('#appearanceHoloList [data-inv-toggle="appearanceTitlebarLoadToggle"]'), null, 'never on two pages');
  assert.match(list.textContent, /Show machine load in the title bar/);
  assert.match(list.textContent, /GPU and VRAM as a small read-out next to the health dot\. CPU, GPU and VRAM are always in the health popover\./);
  const metricList = window.document.getElementById('metricList');
  assert.equal(metricList.hidden, true, 'off by default: no read-out');

  list.dispatchEvent(new window.CustomEvent('inv-toggle-change', {
    bubbles: true, detail: { id: 'appearanceTitlebarLoadToggle', checked: true },
  }));
  await waitForUi(window);
  assert.equal(window.__rendererState.ui.appearance.titlebarLoad, true);
  assert.equal(JSON.parse(window.localStorage.getItem('jenny.appearance.v2')).titlebarLoad, true);
  assert.equal(metricList.hidden, false, 'the read-out appears without a restart');
  assert.equal(metricList.getAttribute('role'), 'group');

  list.dispatchEvent(new window.CustomEvent('inv-toggle-change', {
    bubbles: true, detail: { id: 'appearanceTitlebarLoadToggle', checked: false },
  }));
  await waitForUi(window);
  assert.equal(metricList.hidden, true);
});

test('a system stats push through the booted app updates the title-bar read-out', async (t) => {
  const app = await loadRendererApp();
  t.after(async () => app.dispose());
  await openSettingsView(app.window);
  const { window } = app;
  const readout = () => [...window.document.querySelectorAll('#metricList .metric-item')]
    .map((item) => item.textContent.replace(/\s+/g, ' ').trim());
  window.document.getElementById('generalTitlebarLoadList').dispatchEvent(new window.CustomEvent('inv-toggle-change', {
    bubbles: true, detail: { id: 'appearanceTitlebarLoadToggle', checked: true },
  }));
  await waitForUi(window);

  await window.jennyShell.__emitSystemStats({ cpuPercent: 37.4, ramPercent: 55.1, arch: 'x64', platform: 'win32', gpuMemory: { available: false } });
  await waitForUi(window);
  assert.deepEqual(readout(), ['CPU 37%', 'RAM 55%']);
  assert.equal(window.__rendererState.systemStats.cpuPercent, 37.4, 'the push lands in state for the health popover');

  await window.jennyShell.__emitSystemStats({ cpuPercent: 64, ramPercent: 58, arch: 'x64', platform: 'win32', gpuMemory: { available: false } });
  await waitForUi(window);
  assert.deepEqual(readout(), ['CPU 64%', 'RAM 58%'], 'the next tick rewrites the read-out');
});
