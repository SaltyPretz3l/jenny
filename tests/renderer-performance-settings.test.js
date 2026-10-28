'use strict';

/* Row 59 checkpoint 6 (renderer): Settings > Appearance performance rows. "Show performance in the
   session rail" (show_counter) and "GPU memory warnings" (gpu_warnings_enabled) are descriptor rows bound
   to window.jennyShell.performance through the "performance" adapter: one updateSettings call carrying
   exactly the changed boolean(s), acknowledged only by a matching echo, rolled back otherwise. */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const descriptors = require('../renderer/shell/renderer-settings-field-descriptors.js');
const fieldCopy = require('../renderer/shell/renderer-settings-field-copy.js');
const fieldBinding = require('../renderer/shell/renderer-settings-field-binding.js');
const settingsModule = require('../renderer/shell/renderer-performance-settings.js');
const fx = require('./helpers/performance-snapshot-fixture.js');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

const flush = async (rounds = 6) => { for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const plain = (value) => JSON.parse(JSON.stringify(value)); // the page runs in its own realm
const confirmError = () => new Error('The saved setting could not be confirmed.');

function storeWith(bridge) {
  const win = { jennyShell: bridge ? { performance: bridge } : {} };
  return { win, store: settingsModule.createStore(win) };
}

test('descriptors: two Appearance rows on the performance adapter with the wire names as keys', () => {
  const counter = descriptors.getSettingDescriptor('performanceShowCounterToggle');
  const warnings = descriptors.getSettingDescriptor('performanceGpuWarningsToggle');
  assert.deepEqual([counter.sectionId, counter.adapterId, counter.key, counter.kind, counter.default], ['appearance', 'performance', 'show_counter', 'boolean', false]);
  assert.deepEqual([warnings.sectionId, warnings.adapterId, warnings.key, warnings.kind, warnings.default], ['appearance', 'performance', 'gpu_warnings_enabled', 'boolean', true]);
  assert.equal(counter.control, 'toggle');
  assert.deepEqual(descriptors.listSettingDescriptors({ adapterId: 'performance' }).map((entry) => entry.id), ['performanceShowCounterToggle', 'performanceGpuWarningsToggle']);
});

test('copy: the PO labels, in the settings search index with the Appearance section', () => {
  assert.equal(fieldCopy.getSettingsFieldCopy('performanceShowCounterToggle').label, 'Show performance in the session rail');
  assert.equal(fieldCopy.getSettingsFieldCopy('performanceGpuWarningsToggle').label, 'GPU memory warnings');
  const entries = fieldCopy.listSettingsSearchEntries();
  ['performanceShowCounterToggle', 'performanceGpuWarningsToggle'].forEach((id) => {
    const entry = entries.find((candidate) => candidate.id === id);
    assert.ok(entry, `${id} is searchable`);
    assert.equal(entry.sectionId, 'appearance');
  });
  assert.match(fieldCopy.getSettingsFieldCopy('performanceGpuWarningsToggle').description, /only observes/i);
});

test('adapter: a write is ONE updateSettings call carrying exactly the changed boolean, acknowledged by the echo', async () => {
  const bridge = fx.createPerformanceBridge();
  const { store } = storeWith(bridge);
  const adapter = settingsModule.createAdapter({ store, confirmError });
  assert.equal(adapter.mode, 'patch');
  assert.deepEqual(adapter.read(), { show_counter: false, gpu_warnings_enabled: true }, 'defaults before hydration');
  const result = await adapter.write({ show_counter: true });
  assert.deepEqual(bridge.updateCalls, [{ schema_version: 1, show_counter: true }]);
  const accepted = adapter.ack(result, { show_counter: true });
  assert.deepEqual(accepted, { show_counter: true, gpu_warnings_enabled: true });
  assert.deepEqual(store.get(), { show_counter: true, gpu_warnings_enabled: true });
});

test('adapter: a refusal, a mismatched echo, a malformed echo and a missing bridge are not acknowledged', async () => {
  const bridge = fx.createPerformanceBridge();
  const { store } = storeWith(bridge);
  const adapter = settingsModule.createAdapter({ store, confirmError });
  assert.throws(() => adapter.ack({ ok: false, code: 'CMP-PERFORMANCE-0001', reason: 'invalid_request' }, { show_counter: true }), /could not be confirmed/);
  assert.throws(() => adapter.ack({ ok: true, settings: fx.settings({ show_counter: false }) }, { show_counter: true }), /could not be confirmed/);
  assert.throws(() => adapter.ack(undefined, { show_counter: true }), /could not be confirmed/);
  assert.throws(() => adapter.write({}), /could not be confirmed/);
  const none = settingsModule.createAdapter({ store: storeWith(null).store, confirmError });
  assert.throws(() => none.write({ show_counter: true }), /could not be confirmed/);
});

test('registry: a toggle edit goes through the shared binding to updateSettings; a failed write rolls the value back', async () => {
  const bridge = fx.createPerformanceBridge();
  const { store } = storeWith(bridge);
  const registry = fieldBinding.createSettingsAdapterRegistry();
  registry.register(settingsModule.createAdapter({ store, confirmError }));
  const counter = descriptors.getSettingDescriptor('performanceShowCounterToggle');
  const warnings = descriptors.getSettingDescriptor('performanceGpuWarningsToggle');

  await registry.write(counter, true);
  assert.deepEqual(bridge.updateCalls, [{ schema_version: 1, show_counter: true }]);
  assert.equal(registry.read(counter), true);
  assert.equal(registry.read(warnings), true, 'the other row is untouched');

  bridge.respondUpdate = () => ({ ok: false, code: 'CMP-PERFORMANCE-0003', reason: 'collection_unavailable' });
  await assert.rejects(registry.write(warnings, false));
  assert.equal(bridge.updateCalls.at(-1).gpu_warnings_enabled, false);
  assert.equal(Object.keys(bridge.updateCalls.at(-1)).length, 2, 'schema_version plus exactly one boolean');
  assert.equal(registry.read(warnings), true, 'rolled back to the acknowledged value');
  assert.equal(store.get().gpu_warnings_enabled, true);
});

function deferredSnapshots(bridge) {
  const pending = [];
  bridge.getSnapshot = (request) => {
    bridge.snapshotCalls.push(request);
    return new Promise((resolve) => pending.push(resolve));
  };
  return pending;
}

test('store: a snapshot requested before an acknowledgement never overwrites it; the refresh asks again', async () => {
  const bridge = fx.createPerformanceBridge();
  const pending = deferredSnapshots(bridge);
  const { store } = storeWith(bridge);
  const adapter = settingsModule.createAdapter({ store, confirmError });
  const refreshed = store.refresh();
  assert.equal(bridge.snapshotCalls.length, 1);
  // An edit is acknowledged while the snapshot is in flight.
  adapter.ack({ ok: true, settings: fx.settings({ show_counter: true }) }, { show_counter: true });
  pending[0](fx.snapshot({ settings: fx.settings({ show_counter: false, gpu_warnings_enabled: false }) }));
  await flush();
  assert.equal(store.get().show_counter, true, 'the stale snapshot is dropped');
  assert.equal(bridge.snapshotCalls.length, 2, 'and asked again');
  pending[1](fx.snapshot({ settings: fx.settings({ show_counter: true, gpu_warnings_enabled: false }) }));
  await refreshed;
  assert.deepEqual(store.get(), { show_counter: true, gpu_warnings_enabled: false });
});

test('store: an invalidation while a snapshot is in flight re-runs the refresh once it lands', async () => {
  const bridge = fx.createPerformanceBridge();
  const pending = deferredSnapshots(bridge);
  const { store } = storeWith(bridge);
  const first = store.refresh();
  void store.refresh();
  void store.refresh();
  assert.equal(bridge.snapshotCalls.length, 1, 'one snapshot in flight at a time');
  pending[0](fx.snapshot({ settings: fx.settings({ show_counter: false }) }));
  await flush();
  assert.equal(bridge.snapshotCalls.length, 2, 'the dropped invalidations ask once more');
  pending[1](fx.snapshot({ settings: fx.settings({ show_counter: true }) }));
  await first;
  assert.equal(store.get().show_counter, true, 'the newer snapshot wins');
  assert.equal(bridge.snapshotCalls.length, 2);
});

function sectionDom() {
  const dom = new JSDOM('<!doctype html><body><section id="section"><div id="appearancePerformanceGroup" hidden>'
    + '<div data-setting-mount="performanceShowCounterToggle"></div><div data-setting-mount="performanceGpuWarningsToggle"></div></div></section></body>');
  return { dom, section: dom.window.document.getElementById('section'), group: dom.window.document.getElementById('appearancePerformanceGroup') };
}

test('mountRows: no bridge keeps the group hidden and mounts nothing', async () => {
  const { section, group } = sectionDom();
  const mounted = [];
  const win = { jennyShell: {} };
  assert.equal(settingsModule.mountRows(section, (...args) => mounted.push(args), win), false);
  assert.equal(group.hidden, true);
  assert.deepEqual(mounted, []);
});

test('mountRows: reveals the group, hydrates once from getSnapshot, and re-mounts on a settings invalidation', async () => {
  const bridge = fx.createPerformanceBridge({ settings: fx.settings({ show_counter: true, gpu_warnings_enabled: false }) });
  const win = { jennyShell: { performance: bridge } };
  const { section, group } = sectionDom();
  const mounted = [];
  const mount = (target, id, value) => mounted.push([id, value]);
  assert.equal(settingsModule.mountRows(section, mount, win), true);
  assert.equal(group.hidden, false);
  assert.deepEqual(mounted, [['performanceShowCounterToggle', false], ['performanceGpuWarningsToggle', true]], 'defaults until the snapshot lands');
  await flush();
  assert.deepEqual(bridge.snapshotCalls, [{ schema_version: 1, session_id: settingsModule.HOST_SESSION_ID }]);
  assert.deepEqual(mounted.slice(-2), [['performanceShowCounterToggle', true], ['performanceGpuWarningsToggle', false]]);

  settingsModule.mountRows(section, mount, win);
  await flush();
  assert.equal(bridge.snapshotCalls.length, 1, 'hydrates once per window');

  bridge.current = fx.snapshot({ settings: fx.settings({ show_counter: false, gpu_warnings_enabled: false }) });
  bridge.emit({ session_id: null, terminal: false, scope: 'settings' });
  await flush();
  assert.deepEqual(mounted.slice(-2), [['performanceShowCounterToggle', false], ['performanceGpuWarningsToggle', false]]);
  const before = bridge.snapshotCalls.length;
  bridge.emit({ session_id: 'sess_a', terminal: false, scope: 'inference' });
  await flush();
  assert.equal(bridge.snapshotCalls.length, before, 'only settings invalidations matter here');
  settingsModule.storeFor(win).dispose();
});

test('index.html: the group, its two mounts and the script order', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const doc = new JSDOM(html).window.document;
  const group = doc.getElementById('appearancePerformanceGroup');
  assert.ok(group && group.hidden, 'hidden until the bridge exists');
  assert.ok(doc.querySelector('[data-settings-section="appearance"] #appearancePerformanceGroup'));
  assert.deepEqual([...group.querySelectorAll('[data-setting-mount]')].map((node) => node.dataset.settingMount), ['performanceShowCounterToggle', 'performanceGpuWarningsToggle']);
  const scripts = [...doc.querySelectorAll('script[src]')].map((node) => node.getAttribute('src'));
  const at = (name) => scripts.indexOf(name);
  assert.ok(at('renderer/shell/renderer-performance-settings.js') > at('renderer/shell/renderer-settings-field-binding.js'));
  assert.ok(at('renderer/shell/renderer-performance-settings.js') < at('renderer/shell/renderer-settings-event-utils.js'));
  assert.ok(at('renderer/chat/renderer-session-rail-performance.js') > at('renderer/chat/renderer-session-rail-render.js'));
  assert.ok(at('renderer/chat/renderer-session-rail-performance.js') < at('renderer/chat/renderer-session-rail.js'));
  assert.ok(at('renderer/shell/renderer-health-pill-gpu.js') < at('renderer/shell/renderer-health-pill-utils.js'));
});

async function loadSettings(t, bridge) {
  const app = await loadRendererApp();
  t.after(async () => { await app.dispose(); });
  if (bridge) app.window.jennyShell.performance = bridge;
  app.window.document.querySelector('[data-tab-id="settings"]').click();
  await waitForUi(app.window, 100);
  return app;
}

test('in the real Settings page: the rows render hidden without a bridge and bound with one', async (t) => {
  const bare = await loadSettings(t, null);
  assert.equal(bare.window.document.getElementById('appearancePerformanceGroup').hidden, true);
  assert.equal(bare.window.document.querySelector('[data-inv-toggle="performanceShowCounterToggle"]'), null);
});

test('in the real Settings page: toggling "Show performance in the session rail" calls updateSettings with one boolean', async (t) => {
  const bridge = fx.createPerformanceBridge({ settings: fx.settings({ show_counter: false, gpu_warnings_enabled: true }) });
  const { window } = await loadSettings(t, bridge);
  const doc = window.document;
  assert.equal(doc.getElementById('appearancePerformanceGroup').hidden, false);
  const counter = () => doc.querySelector('[data-inv-toggle="performanceShowCounterToggle"]');
  const warnings = () => doc.querySelector('[data-inv-toggle="performanceGpuWarningsToggle"]');
  assert.ok(counter() && warnings(), 'both rows are mounted');
  assert.equal(counter().getAttribute('aria-checked'), 'false');
  assert.equal(warnings().getAttribute('aria-checked'), 'true');
  assert.match(doc.querySelector('[data-settings-field="performanceShowCounterToggle"]').textContent, /Show performance in the session rail/);

  counter().click();
  await waitForUi(window, 30);
  assert.deepEqual(plain(bridge.updateCalls), [{ schema_version: 1, show_counter: true }]);
  assert.equal(counter().getAttribute('aria-checked'), 'true');

  bridge.respondUpdate = () => ({ ok: false, code: 'CMP-PERFORMANCE-0003', reason: 'collection_unavailable' });
  warnings().click();
  await waitForUi(window, 30);
  assert.deepEqual(plain(bridge.updateCalls.at(-1)), { schema_version: 1, gpu_warnings_enabled: false });
  assert.equal(warnings().getAttribute('aria-checked'), 'true', 'the control keeps the acknowledged value');
  assert.notEqual(doc.querySelector('[data-settings-field="performanceGpuWarningsToggle"] .settings-field-error')?.textContent || '', '', 'a refused write shows the row error');
});
