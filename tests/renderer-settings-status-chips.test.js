'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  applyStatusChip,
  resolveAvailabilityChipState,
  STATUS_CHIP_CLASS,
} = require('../renderer/shell/renderer-status-chip-utils.js');

// ── applyStatusChip / resolveAvailabilityChipState (pure logic) ───────────

test('resolveAvailabilityChipState maps unresolved -> loading, resolved+ok -> live, resolved+!ok -> error', () => {
  assert.equal(resolveAvailabilityChipState({ resolved: false, ok: true }), 'loading');
  assert.equal(resolveAvailabilityChipState({ resolved: undefined, ok: true }), 'loading');
  assert.equal(resolveAvailabilityChipState({ resolved: true, ok: true }), 'live');
  assert.equal(resolveAvailabilityChipState({ resolved: true, ok: false }), 'error');
  // ok must not leak through while unresolved — it's still describing the
  // optimistic seed, not a real reading.
  assert.equal(resolveAvailabilityChipState({ resolved: false, ok: false }), 'loading');
  assert.equal(resolveAvailabilityChipState(), 'loading');
});

test('applyStatusChip sets data-state, textContent, the class hook, and optional title across transitions', () => {
  const dom = new JSDOM('<div><span id="chip" class="settings-badge"></span></div>');
  const el = dom.window.document.getElementById('chip');

  applyStatusChip(el, { state: 'loading', label: 'Checking...' });
  assert.equal(el.getAttribute('data-state'), 'loading');
  assert.equal(el.textContent, 'Checking...');
  assert.equal(el.classList.contains(STATUS_CHIP_CLASS), true);
  assert.equal(el.classList.contains('settings-badge'), true, 'existing classes are preserved, not replaced');
  assert.equal(el.hasAttribute('title'), false);

  applyStatusChip(el, { state: 'live', label: 'Ready', title: 'All tools available' });
  assert.equal(el.getAttribute('data-state'), 'live');
  assert.equal(el.textContent, 'Ready');
  assert.equal(el.getAttribute('title'), 'All tools available');

  applyStatusChip(el, { state: 'error', label: 'Blocked' });
  assert.equal(el.getAttribute('data-state'), 'error');
  assert.equal(el.textContent, 'Blocked');
  assert.equal(el.hasAttribute('title'), false, 'a dropped title is removed, not left stale');

  // Unknown state normalizes to loading instead of leaking a raw token onto data-state.
  applyStatusChip(el, { state: 'bogus', label: 'x' });
  assert.equal(el.getAttribute('data-state'), 'loading');

  // Non-element input is a safe no-op.
  assert.equal(applyStatusChip(null, { state: 'live' }), null);
});

// ── state.features.availabilityResolved via applyFeatureStatePayload ──────

const { createShellStateRuntimeUtils } = require('../renderer/shell/renderer-shell-state-runtime-utils.js');

test('applyFeatureStatePayload flips availabilityResolved false -> true without altering gating fields', () => {
  const state = {
    features: {
      loaded: false,
      availabilityResolved: false,
      tools: { web: false },
      featureFlags: {},
      featureOverrides: {},
      availability: { runtime: { managedSidecarActive: true }, tools: {}, featureFlags: {} },
    },
  };
  const runtime = createShellStateRuntimeUtils({
    state,
    windowRef: { document: { documentElement: { dataset: {} } } },
  });

  assert.equal(state.features.availabilityResolved, false);

  const features = runtime.applyFeatureStatePayload({
    tools: { web: true },
    availability: { tools: { web: { enabled: true } } },
  });

  assert.equal(features.availabilityResolved, true);
  // The flag is display-only: gating fields merge exactly as before.
  assert.equal(features.tools.web, true);
  assert.deepEqual(features.availability.tools.web, { enabled: true });
});

// ── normalizeFeatureState (settings support) ──────

const {
  normalizeFeatureState,
} = require('../renderer/shell/renderer-settings-support.js');

test('normalizeFeatureState carries availabilityResolved through a render-time normalize pass', () => {
  assert.equal(normalizeFeatureState({ availabilityResolved: true }).availabilityResolved, true);
  assert.equal(normalizeFeatureState({ availabilityResolved: false }).availabilityResolved, false);
  assert.equal(normalizeFeatureState({}).availabilityResolved, false);
  assert.equal(normalizeFeatureState(null).availabilityResolved, false);
});

// ── Offline surface: loading before the first payload, live/error after ──

const offlineDom = new JSDOM('<!doctype html><body></body>');
global.window = offlineDom.window;
global.document = offlineDom.window.document;

const { createOfflineManager } = require('../renderer/features/renderer-offline-utils.js');

test.after(() => {
  delete global.window;
  delete global.document;
});

test('offline posture renders loading then live/error without a header badge', () => {
  const document = offlineDom.window.document;
  document.body.innerHTML = `
    <div id="offlineSummary"></div>
    <div id="offlineStatus"></div>
    <div id="offlineLocalOnlyList"></div>
    <div id="offlineModelStatus"></div>
    <div id="offlineModelActions"></div>
    <span class="status-dot" id="composerChatPostureDot" data-posture="local" aria-hidden="true"></span>
    <div id="composerChatPosture" hidden></div><span id="composerChatPostureText"></span>
  `;

  // Mirrors the bootstrap seed in renderer-bootstrap-utils.js: resolved: false,
  // optimistic-permissive readiness fields.
  const state = {
    offline: {
      resolved: false,
      mode: 'disabled',
      preferredLocalModel: '',
      localCatalog: { available: false, reason: '', models: [] },
      managedSidecar: { mode: '', phase: 'stopped', ready: false },
      currentEngine: '',
      currentModel: '',
      engineFallback: null,
      selectedLocalModelInstalled: false,
      localChatReady: false,
      localVisionReady: false,
      unavailableReason: 'Managed sidecar is not ready yet.',
      visionUnavailableReason: '',
      summary: 'Checking local offline readiness...',
    },
  };

  const manager = createOfflineManager({
    state,
    dom: {},
    getDom: () => ({
      offlineSummary: document.getElementById('offlineSummary'),
      offlineStatus: document.getElementById('offlineStatus'),
      offlineLocalOnlyList: document.getElementById('offlineLocalOnlyList'),
      offlineModelStatus: document.getElementById('offlineModelStatus'),
      offlineModelActions: document.getElementById('offlineModelActions'),
    }),
    callbacks: {
      escapeHtml: (value) => String(value || ''),
      appendClientLog: () => {},
      renderSettings: () => {},
    },
  });

  assert.equal(document.getElementById('offlineBadge'), null);
  const dot = document.getElementById('composerChatPostureDot');

  manager.renderOfflineManager();
  assert.equal(dot.getAttribute('data-state'), 'loading');
  // Pre-resolution, the flash-stale bug this ticket fixes was the dot silently
  // reading as "off" (no --active/--error class) instead of loading.
  assert.equal(dot.classList.contains('status-dot--active'), false);
  assert.equal(dot.classList.contains('status-dot--error'), false);

  manager.applyOfflinePayload({
    mode: 'local_only',
    preferredLocalModel: 'llava:7b',
    localCatalog: { available: true, reason: '', models: ['llava:7b'] },
    managedSidecar: { mode: 'managed-dev', phase: 'ready', ready: true },
    selectedLocalModelInstalled: true,
    localChatReady: true,
    localVisionReady: true,
    summary: 'Cloud inference is disabled for chat. Jenny will use llava:7b.',
  });
  manager.renderOfflineManager();

  assert.equal(state.offline.resolved, true);
  assert.equal(dot.getAttribute('data-state'), 'live');

  manager.applyOfflinePayload({
    mode: 'local_only',
    preferredLocalModel: 'llava:7b',
    localCatalog: { available: true, reason: '', models: [] },
    managedSidecar: { mode: 'managed-dev', phase: 'ready', ready: true },
    selectedLocalModelInstalled: false,
    localChatReady: false,
    localVisionReady: false,
    unavailableReason: 'Selected model is not installed.',
  });
  manager.renderOfflineManager();

  assert.equal(dot.getAttribute('data-state'), 'error');
});

test('a late offline refresh cannot overwrite a newer acknowledged settings update', async (t) => {
  let releaseRefresh;
  const base = {
    localCatalog: { available: true, reason: '', models: [] },
    managedSidecar: { mode: 'managed-dev', phase: 'ready', ready: true },
    localChatReady: true,
  };
  const stale = { ...base, mode: 'disabled' };
  const updated = { ...base, mode: 'local_only' };
  const previousShell = globalThis.jennyShell;
  globalThis.jennyShell = {
    offline: {
      getState() { return new Promise((resolve) => { releaseRefresh = resolve; }); },
      async updateSettings() { return updated; },
    },
  };
  t.after(() => { globalThis.jennyShell = previousShell; });

  const state = { offline: null };
  const manager = createOfflineManager({
    state,
    callbacks: { appendClientLog() {}, renderSettings() {} },
  });

  const pendingRefresh = manager.refreshOfflineState();
  await manager.handleOfflineModeChange(true);
  assert.equal(state.offline.mode, 'local_only');

  releaseRefresh(stale);
  await pendingRefresh;

  assert.equal(state.offline.mode, 'local_only');
});

test('model badge keeps the tag, shortens paths and exposes the full id; idle status lines stay hidden', async (t) => {
  const { loadRendererApp } = require('./helpers/renderer-shell-harness');
  for (const model of ['organization/path/model:tag', 'model:tag']) {
    const app = await loadRendererApp({ shell: { status: { async get() { return { model, model_loaded: true }; } } } });
    t.after(() => app.dispose());
    const doc = app.window.document;
    assert.equal(doc.getElementById('modelBadge').textContent, 'model:tag');
    assert.equal(doc.getElementById('modelBadge').title, model);
    for (const id of ['contextStatus', 'editorStatus', 'homeStatus']) {
      assert.equal(doc.getElementById(id).textContent, '', id);
      assert.equal(doc.getElementById(id).hidden, true, id);
    }
    await app.dispose();
  }
});

test('data lifecycle status is hidden when idle and visible when the summary is unavailable', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const code = fs.readFileSync(path.join(__dirname, '../renderer/features/renderer-data-lifecycle.js'), 'utf8');
  for (const ok of [true, false]) {
    const dom = new JSDOM('<div id="dataLifecycleSettingsMount"></div>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const window = dom.window;
    window.inventoryActionButton = require('../renderer/inventory/action-button');
    window.inventoryTextField = require('../renderer/inventory/text-field');
    window.inventoryToggleSwitch = require('../renderer/inventory/toggle-switch');
    window.inventoryProgressBar = require('../renderer/inventory/progress-bar');
    window.stringUtils = require('../renderer/shared/string-utils');
    window.dataLifecycleUtils = require('../renderer/features/renderer-data-lifecycle-utils');
    window.jennyShell = { dataLifecycle: {
      async getOverview() { return { ok }; }, async findRestoreCandidates() { return { ok: true }; },
      async syncPortablePreferences() {}, onProgress() { return () => {}; },
    } };
    try {
      window.eval(code);
      await new Promise(resolve => window.setTimeout(resolve, 0));
      const status = window.document.getElementById('dataLifecycleSettingsStatus');
      assert.ok(status);
      assert.equal(status.hidden, ok);
      assert.equal(status.textContent, ok ? '' : 'Data summary is temporarily unavailable.');
    } finally { window.close(); }
  }
});
