'use strict';

// Renders the Diagnostics Overview modules into the real #logsView markup from index.html (JSDOM, no
// scripts run), so the tests assert the DOM the page paints without loading the whole app. The
// Performance section is owned by another module and is stubbed out here.
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..', '..');
const OVERVIEW_MODULES = ['renderer-diagnostics-overview', 'renderer-diagnostics-runtime-facts', 'renderer-diagnostics-issue-card']
  .map((name) => require.resolve(path.join(ROOT, 'renderer', 'shell', `${name}.js`)));
const PERFORMANCE_MODULE = require.resolve(path.join(ROOT, 'renderer', 'shell', 'renderer-diagnostics-performance-utils.js'));
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const MB = 1024 * 1024;
const GB = 1024 * MB;
const NOW = Date.now();
const LAUNCH_START = new Date(NOW - 3 * 3600 * 1000).toISOString();
const OBSERVED = (count, lastSeen, extra) => ({ state: 'observed', capture_state: 'capturing', count, last_seen: lastSeen || new Date(NOW - 60000).toISOString(), ...extra });

function readyBackend(extra) {
  return { phase: 'ready', ...extra };
}

function harnessSnapshot(overrides) {
  return {
    runtime: { active_engine: 'ollama', active_model: 'gemma3:latest', active_mode: 'chat' },
    tools: { items: [], counts: { total: 20, enabled: 18, disabled: 2 } },
    memories: { approved: [], pending: [], counts: { approved: 12, pending: 3 }, status: { available: true } },
    skills: { counts: { total: 18 }, scopes: [{ scope: 'bundled', status: 'ready' }, { scope: 'project', status: 'ready' }] },
    workspace: { root: 'C:/dev/jenny', exists: true, blockers: [], workspace_blocked_tools: [] },
    shell: { tools_preferences: {}, companion: {}, proactive: {}, offline: {} },
    ...overrides,
  };
}

// A complete, healthy view state; each test overrides only what it is about.
function makeState(overrides) {
  const run = { run_id: 'run-1', started_at: LAUNCH_START, sources: { electron: OBSERVED(120), renderer: OBSERVED(40), sidecar: OBSERVED(8) }, integrity: { complete: true, partial_reasons: [] } };
  return {
    ui: { logs: {} },
    logs: [],
    backend: readyBackend(),
    diagnosticsRefreshedAt: NOW - 8000,
    diagnosticsSnapshot: { active_run: run, prior_run: null },
    diagnosticsStatus: {
      backend: readyBackend(),
      budgets: {
        available: true, inputs: { usage: true },
        resources: { app_memory_bytes: 412 * MB, model_memory: { models: [{ name: 'gemma3:latest' }], ram_bytes: 0, vram_bytes: 4 * GB, vram_total_bytes: 32 * GB }, system_memory: { percent: 41, pressure: 'normal' } },
        usage: { session_total_tokens: 1200, cumulative_total_tokens: 98000 },
      },
    },
    harness: { snapshot: harnessSnapshot(), error: '', loadedAt: NOW - 8000 },
    schedulerDiagnostics: { lifecycle: { phase: 'idle', qualifyingTaskCount: 2 } },
    ...overrides,
  };
}

function entry(overrides) {
  return {
    entry_id: overrides.entry_id || `e-${Math.random().toString(36).slice(2)}`, run_id: 'run-1', sequence: 1,
    ts: new Date(NOW - 5 * 60000).toISOString(), level: 'WARN', layer: 'electron', component: 'electron.main',
    event: 'ipc.handler_slow', message: 'ipc.handler_slow', data: {}, ...overrides,
  };
}

function createOverviewHarness(t, options) {
  const settings = options || {};
  const dom = new JSDOM(INDEX_HTML, { pretendToBeVisual: true });
  const previous = { document: global.document, window: global.window, actions: global.rendererDiagnosticsActions };
  global.document = dom.window.document;
  global.window = dom.window;
  if (settings.actions) global.rendererDiagnosticsActions = settings.actions;
  const performanceCalls = [];
  const saved = [...OVERVIEW_MODULES, PERFORMANCE_MODULE].map((file) => [file, require.cache[file]]);
  OVERVIEW_MODULES.forEach((file) => { delete require.cache[file]; });
  require.cache[PERFORMANCE_MODULE] = { id: PERFORMANCE_MODULE, filename: PERFORMANCE_MODULE, loaded: true, exports: { renderPerformanceSection(state, context) { performanceCalls.push(context); } } };
  const overview = require(OVERVIEW_MODULES[0]);
  t.after(() => {
    saved.forEach(([file, cached]) => { if (cached) require.cache[file] = cached; else delete require.cache[file]; });
    Object.assign(global, { document: previous.document, window: previous.window });
    if (previous.actions) global.rendererDiagnosticsActions = previous.actions; else delete global.rendererDiagnosticsActions;
    dom.window.close();
  });
  const doc = dom.window.document;
  return {
    doc,
    window: dom.window,
    performanceCalls,
    render(state, entries) { overview.renderOverview(state, entries || state.logs || []); },
    text(id) { return doc.getElementById(id).textContent.replace(/\s+/g, ' ').trim(); },
    status() { return doc.getElementById('diagnosticsOverall'); },
    runtime() { return doc.getElementById('diagnosticsRuntimeInventory'); },
    group(title) {
      return Array.from(doc.querySelectorAll('#diagnosticsRuntimeInventory .diagnostics-group'))
        .find((node) => node.querySelector('h4')?.textContent === title) || null;
    },
    fact(label) {
      const term = Array.from(doc.querySelectorAll('#diagnosticsRuntimeInventory dt')).find((node) => node.textContent === label);
      return term ? term.nextElementSibling : null;
    },
  };
}

module.exports = { createOverviewHarness, makeState, entry, harnessSnapshot, readyBackend, MB, GB, NOW, LAUNCH_START, OBSERVED };
