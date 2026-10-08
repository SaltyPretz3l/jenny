'use strict';

/* Top chrome (area 1, 2026-09-29): the title bar's machine-load read-out and
 * the header's slimmed tick. The read-out is off unless Settings > Appearance
 * turns it on (appearance.titlebarLoad); it is a non-interactive group of two
 * fixed slots (GPU or CPU, VRAM or RAM); the 2 s stats push updates only its
 * text nodes, only while it is shown and the document is visible. The header
 * owns its stats subscription, so the tick never runs the full renderHeader
 * (no session scan, no New Chat gating, no token display, no dead
 * sessionActionButton write). */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createHeaderController } = require('../renderer/shell/renderer-header-utils');

const GPU_STATS = {
  cpuPercent: 21.4,
  ramPercent: 40.2,
  arch: 'x64',
  platform: 'win32',
  gpuMemory: { available: true, usedMb: 13926, totalMb: 16282, utilAvailable: true, utilPercent: 93.2 },
};

function createShellStub() {
  const listeners = new Set();
  const shell = {
    watches: [],
    system: {
      onStats(callback) {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
      async setStatsWatch(payload) { shell.watches.push(payload); return { watched: payload.watched }; },
    },
    push(payload) { for (const listener of [...listeners]) listener(payload); },
    listenerCount() { return listeners.size; },
  };
  return shell;
}

function createHarness(t, {
  titlebarLoad = false,
  systemStats = GPU_STATS,
  callbacks = {},
  sessionActionButton = null,
} = {}) {
  const dom = new JSDOM('<div class="titlebar-status"><div class="metric-list" id="metricList" role="group" aria-label="System load" hidden></div></div>', { pretendToBeVisual: true });
  const doc = dom.window.document;
  const metricList = doc.getElementById('metricList');
  let innerHtmlWrites = 0;
  const descriptor = Object.getOwnPropertyDescriptor(dom.window.Element.prototype, 'innerHTML');
  Object.defineProperty(metricList, 'innerHTML', {
    get() { return descriptor.get.call(this); },
    set(value) { innerHtmlWrites += 1; descriptor.set.call(this, value); },
  });
  const state = {
    ui: { activeView: 'chat', appearance: { titlebarLoad } },
    auth: { authenticated: true },
    backend: { phase: 'ready' },
    currentSessionId: 'session-1',
    sessions: [],
    systemStats,
  };
  const shell = createShellStub();
  const controller = createHeaderController({
    state,
    dom: { metricList, sessionActionButton, newChatButton: null },
    callbacks,
    documentRef: doc,
    shell,
  });
  t.after(() => {
    controller.dispose();
    dom.window.close();
  });
  const mutations = [];
  const observer = new dom.window.MutationObserver((records) => mutations.push(...records));
  return {
    dom, doc, metricList, state, shell, controller,
    innerHtmlWrites: () => innerHtmlWrites,
    observe() {
      observer.observe(metricList, { attributes: true, childList: true, characterData: true, subtree: true });
    },
    takeMutations() { mutations.push(...observer.takeRecords()); return mutations.splice(0); },
    readout() {
      return [...metricList.querySelectorAll('.metric-item')].map((item) => item.textContent.replace(/\s+/g, ' ').trim());
    },
  };
}

test('off by default: no read-out, hidden, empty', (t) => {
  const h = createHarness(t, { titlebarLoad: false });
  h.controller.renderHeader();
  assert.equal(h.metricList.hidden, true);
  assert.equal(h.metricList.children.length, 0);
});

test('a stats push with titlebarLoad=false renders no read-out and touches no DOM', (t) => {
  const h = createHarness(t, { titlebarLoad: false });
  h.controller.renderHeader();
  h.observe();
  h.shell.push({ ...GPU_STATS, cpuPercent: 80 });
  h.shell.push({ ...GPU_STATS, cpuPercent: 81 });
  assert.deepEqual(h.takeMutations(), [], 'no DOM mutation at all');
  assert.equal(h.innerHtmlWrites(), 0);
  assert.equal(h.state.systemStats.cpuPercent, 81, 'the stats still land in state (the popover reads them)');
});

test('on: one group with two fixed slots, GPU and VRAM when the sampler has them', (t) => {
  const h = createHarness(t, { titlebarLoad: true });
  h.controller.renderHeader();
  assert.equal(h.metricList.hidden, false);
  assert.equal(h.metricList.getAttribute('role'), 'group');
  assert.equal(h.metricList.getAttribute('tabindex'), null, 'not a button, no refresh affordance');
  assert.deepEqual(h.readout(), ['GPU 93%', 'VRAM 13.6 GB']);
  const slots = [...h.metricList.querySelectorAll('.metric-item-value')].map((node) => node.dataset.slot);
  assert.deepEqual(slots, ['percent', 'memory']);
});

test('the tick updates text nodes only: no innerHTML write, stable nodes', (t) => {
  const h = createHarness(t, { titlebarLoad: true });
  h.controller.renderHeader();
  const writesAfterBuild = h.innerHtmlWrites();
  const valueNodes = [...h.metricList.querySelectorAll('.metric-item-value')];
  h.observe();
  h.shell.push({ ...GPU_STATS, gpuMemory: { ...GPU_STATS.gpuMemory, utilPercent: 41, usedMb: 2048 } });
  assert.deepEqual(h.readout(), ['GPU 41%', 'VRAM 2.0 GB']);
  assert.equal(h.innerHtmlWrites(), writesAfterBuild, 'no innerHTML rebuild on the tick');
  assert.deepEqual([...h.metricList.querySelectorAll('.metric-item-value')], valueNodes, 'same nodes');
  const kinds = new Set(h.takeMutations().map((record) => record.type));
  assert.equal(kinds.has('childList') && ![...kinds].includes('attributes'), true, 'only text content changed');

  h.observe();
  h.shell.push({ ...GPU_STATS, gpuMemory: { ...GPU_STATS.gpuMemory, utilPercent: 41, usedMb: 2048 } });
  assert.deepEqual(h.takeMutations(), [], 'an unchanged tick writes nothing');
});

test('fallbacks: CPU without GPU utilization, RAM without a VRAM sample, both on Windows ARM', (t) => {
  const noUtil = createHarness(t, { titlebarLoad: true, systemStats: { ...GPU_STATS, gpuMemory: { ...GPU_STATS.gpuMemory, utilAvailable: false } } });
  noUtil.controller.renderHeader();
  assert.deepEqual(noUtil.readout(), ['CPU 21%', 'VRAM 13.6 GB']);

  const noVram = createHarness(t, { titlebarLoad: true, systemStats: { ...GPU_STATS, gpuMemory: { available: false, utilAvailable: true, utilPercent: 55 } } });
  noVram.controller.renderHeader();
  assert.deepEqual(noVram.readout(), ['GPU 55%', 'RAM 40%']);

  const winArm = createHarness(t, { titlebarLoad: true, systemStats: { ...GPU_STATS, arch: 'arm64', platform: 'win32' } });
  winArm.controller.renderHeader();
  assert.deepEqual(winArm.readout(), ['CPU 21%', 'RAM 40%']);

  const macArm = createHarness(t, { titlebarLoad: true, systemStats: { ...GPU_STATS, arch: 'arm64', platform: 'darwin', gpuMemory: { available: false, utilAvailable: true, utilPercent: 41.2 } } });
  macArm.controller.renderHeader();
  assert.deepEqual(macArm.readout(), ['GPU 41%', 'RAM 40%']);
});

test('unknown values read as a dash, never a fabricated 0.0%', (t) => {
  const h = createHarness(t, { titlebarLoad: true, systemStats: { arch: 'x64' } });
  h.controller.renderHeader();
  assert.deepEqual(h.readout(), ['CPU –', 'RAM –']);
});

test('stale GPU-derived slots dim with a bucketed age; fresh ones clear it', (t) => {
  const h = createHarness(t, { titlebarLoad: true, systemStats: { ...GPU_STATS, gpuMemory: { ...GPU_STATS.gpuMemory, stale: true, ageMs: 14900 } } });
  h.controller.renderHeader();
  const items = [...h.metricList.querySelectorAll('.metric-item')];
  assert.deepEqual(items.map((item) => item.dataset.stale), ['true', 'true']);
  assert.equal(items[0].getAttribute('title'), 'GPU sample is 10s old');

  h.shell.push({ ...GPU_STATS, gpuMemory: { ...GPU_STATS.gpuMemory, stale: true, ageMs: 2000 } });
  assert.equal(items[0].getAttribute('title'), 'GPU sample may be stale', 'no contradictory "0s old"');

  h.shell.push(GPU_STATS);
  assert.deepEqual(items.map((item) => item.dataset.stale), [undefined, undefined]);
  assert.equal(items[0].getAttribute('title'), null);

  const ram = createHarness(t, { titlebarLoad: true, systemStats: { ...GPU_STATS, arch: 'arm64', platform: 'win32', gpuMemory: { ...GPU_STATS.gpuMemory, stale: true } } });
  ram.controller.renderHeader();
  assert.equal(ram.metricList.querySelector('[data-stale]'), null, 'CPU and RAM are never marked stale');
});

test('a hidden document skips the update; the next visible tick catches up', (t) => {
  const h = createHarness(t, { titlebarLoad: true });
  h.controller.renderHeader();
  Object.defineProperty(h.doc, 'hidden', { configurable: true, get: () => true });
  h.observe();
  h.shell.push({ ...GPU_STATS, gpuMemory: { ...GPU_STATS.gpuMemory, utilPercent: 12 } });
  assert.deepEqual(h.takeMutations(), []);
  Object.defineProperty(h.doc, 'hidden', { configurable: true, get: () => false });
  h.shell.push({ ...GPU_STATS, gpuMemory: { ...GPU_STATS.gpuMemory, utilPercent: 13 } });
  assert.deepEqual(h.readout(), ['GPU 13%', 'VRAM 13.6 GB']);
});

test('turning the read-out off hides it once; turning it on again rebuilds it', (t) => {
  const h = createHarness(t, { titlebarLoad: true });
  h.controller.renderHeader();
  h.state.ui.appearance = { titlebarLoad: false };
  h.controller.renderHeader();
  assert.equal(h.metricList.hidden, true);
  h.observe();
  h.controller.renderHeader();
  h.shell.push(GPU_STATS);
  assert.deepEqual(h.takeMutations(), [], 'already hidden: nothing more to write');
  h.state.ui.appearance = { titlebarLoad: true };
  h.controller.renderHeader();
  assert.equal(h.metricList.hidden, false);
  assert.deepEqual(h.readout(), ['GPU 93%', 'VRAM 13.6 GB']);
});

test('the tick never writes sessionActionButton and never calls updateTokenDisplay', (t) => {
  let tokenCalls = 0;
  const sessionActionButton = { textContent: 'untouched', disabled: false };
  const h = createHarness(t, {
    titlebarLoad: true,
    sessionActionButton,
    callbacks: { updateTokenDisplay: () => { tokenCalls += 1; } },
  });
  h.controller.renderHeader();
  h.shell.push(GPU_STATS);
  h.shell.push({ ...GPU_STATS, cpuPercent: 3 });
  assert.equal(tokenCalls, 0, 'the token display runs on its own triggers');
  assert.equal(sessionActionButton.textContent, 'untouched');
  assert.equal(sessionActionButton.disabled, false);
});

test('the header owns its stats subscription and drops it on dispose', (t) => {
  const h = createHarness(t, { titlebarLoad: true });
  assert.equal(h.shell.listenerCount(), 1);
  h.shell.push({ ...GPU_STATS, cpuPercent: 64 });
  assert.equal(h.state.systemStats.cpuPercent, 64);
  h.controller.dispose();
  assert.equal(h.shell.listenerCount(), 0);
});

// F37: a plugin/config refresh re-initializes the sidecar (ready ->
// sidecar_spawned "Preparing model" -> ready). Session creation is owned by
// Electron main and never touches the sidecar, so New Chat must not lock for
// that window: a disabled #newChatButton silently swallows real clicks and the
// strip/palette/IDE New Chat paths that call newChatButton.click().
test('New Chat stays usable while the backend re-initializes and locks only when offline', () => {
  const state = {
    ui: { activeView: 'chat' },
    auth: { authenticated: true },
    backend: { phase: 'ready' },
    features: { featureFlags: {} },
    currentSessionId: 'session-1',
    systemStats: null,
  };
  const newChatButton = { disabled: false };
  const controller = createHeaderController({
    state,
    dom: { metricList: null, newChatButton },
  });
  for (const phase of ['ready', 'model_unavailable', 'sidecar_spawned', 'model_acquiring', 'model_loading', 'starting', 'retrying']) {
    state.backend = { phase };
    controller.renderHeader();
    assert.equal(newChatButton.disabled, false, `New Chat stays enabled at ${phase}`);
  }
  for (const phase of ['failed', 'stopped', '']) {
    state.backend = { phase };
    controller.renderHeader();
    assert.equal(newChatButton.disabled, true, `New Chat locks while the backend is offline (${phase || 'unknown'})`);
  }
  state.backend = { phase: 'sidecar_spawned' };
  state.auth = { authenticated: false };
  controller.renderHeader();
  assert.equal(newChatButton.disabled, true, 'New Chat still requires an authenticated profile');
});

test('the header tells main whether the read-out is watched, once per change, and releases it on dispose', (t) => {
  const h = createHarness(t, { titlebarLoad: false });
  h.controller.renderHeader();
  h.controller.renderHeader();
  assert.deepEqual(h.shell.watches, [{ source: 'titlebar', watched: false }], 'off: one idle notice, not one per render');
  h.state.ui.appearance.titlebarLoad = true;
  h.controller.renderHeader();
  h.shell.push({ ...GPU_STATS, cpuPercent: 50 });
  assert.deepEqual(h.shell.watches.slice(1), [{ source: 'titlebar', watched: true }], 'on: watched, and the tick does not repeat it');
  h.controller.dispose();
  assert.deepEqual(h.shell.watches.slice(2), [{ source: 'titlebar', watched: false }], 'dispose releases the watch');
});
