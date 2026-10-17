'use strict';

// Row 54 N2: the managed NInfer server in the status snapshot (runtime.managed_server)
// and on the health pill (row, Restart NInfer, the power-watchdog stop), plus the
// engine label NInfer earns on the tune drawer. llama-server stays byte-identical.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { getJennyStatus } = require('../services/backend/jenny-status-composer');
const { createHealthPillController } = require('../renderer/shell/renderer-health-pill-utils');
const { buildPopoverMarkup } = require('../renderer/shell/renderer-health-pill-markup-utils');
const { deriveRuntimeHealthState } = require('../renderer/shell/renderer-runtime-health-utils');
const drawerFactory = require('../renderer/inventory/drawer');
const selectField = require('../renderer/inventory/select-field');
const textField = require('../renderer/inventory/text-field');
const actionButton = require('../renderer/inventory/action-button');
const { createModelTuningDrawerController } = require('../renderer/shell/renderer-model-tuning-drawer');

const ALIAS = 'qwen3.8-27b-nvfp4';
const BASE_STATE = { error: '', toneLabel: { tone: 'success', label: 'Healthy' } };

function pillSnapshot(runtime) {
  return {
    runtime: {
      lifecycle: { available: true, state: 'ready', phase: 'ready' },
      provider_capability_profiles: [],
      recent_tool_observations: [],
      ...runtime,
    },
  };
}

function ninfer(overrides = {}) {
  return {
    kind: 'ninfer', state: 'ready', alias: ALIAS, port: 8034, acceleration_mode: 'mtp', last_error: '',
    runtime_label: '0.9.1', stopped_by: '', watchdog_watts: 0, changed_at: 1, ...overrides,
  };
}

function rowText(markup) {
  const dom = new JSDOM('<!doctype html><body>' + markup + '</body>');
  const rows = Array.from(dom.window.document.querySelectorAll('.workbench-health-popover-fact'), (node) => node.textContent);
  // The managed-server row follows the engine row, which may also read NInfer (F19).
  return rows.reverse().find((text) => text.startsWith('NInfer') || text.startsWith('llama-server')) || '';
}

// Captured from the pre-row-54 renderer (HEAD f49310cdc) for these llama-server facets.
const LLAMA_FACETS = [
  { state: 'ready', alias: 'gemma4:12b', port: 8033, acceleration_mode: 'mtp', runtime_label: 'build 10683' },
  { state: 'crashed', alias: 'gemma4:12b', port: 8033, acceleration_mode: 'off' },
  { state: 'stopped', alias: 'gemma4:12b', port: 8033, last_error: 'llama_server_binary_not_found' },
  { state: 'stopped', alias: '', port: 8033 },
];
const LLAMA_BASELINE_MARKUP = [
  '<div class="workbench-health-popover" id="workbenchHealthPopover" role="dialog" tabindex="-1" aria-label="Runtime health" data-health-tone="success"><div class="workbench-health-popover-status"><span class="workbench-health-pill-dot" aria-hidden="true"></span><span>Healthy</span></div><div class="workbench-health-popover-facts"><div class="workbench-health-popover-fact workbench-health-popover-row-value-muted">no engine · no model · <em>unloaded</em></div><div class="workbench-health-popover-fact">phase ready</div><div class="workbench-health-popover-fact workbench-health-popover-row-value-success">llama-server · <em>serving gemma4:12b on :8033 · mtp · build 10683</em></div></div><div class="workbench-health-popover-actions"><button type="button" class="workbench-health-popover-action" data-health-pill-action="open-runtime-health">Diagnostics</button><button type="button" class="workbench-health-popover-action" data-health-pill-action="open-logs">Logs</button><button type="button" class="workbench-health-popover-action" data-health-pill-action="toggle-titlebar-load">Show load in title bar</button></div></div>',
  '<div class="workbench-health-popover" id="workbenchHealthPopover" role="dialog" tabindex="-1" aria-label="Runtime health" data-health-tone="success"><div class="workbench-health-popover-status"><span class="workbench-health-pill-dot" aria-hidden="true"></span><span>Healthy</span></div><div class="workbench-health-popover-facts"><div class="workbench-health-popover-fact workbench-health-popover-row-value-muted">no engine · no model · <em>unloaded</em></div><div class="workbench-health-popover-fact">phase ready</div><div class="workbench-health-popover-fact workbench-health-popover-row-value-danger">llama-server · <em>stopped unexpectedly (gemma4:12b)</em></div></div><div class="workbench-health-popover-actions"><button type="button" class="workbench-health-popover-action" data-health-pill-action="restart-llama-server">Restart llama-server</button><button type="button" class="workbench-health-popover-action" data-health-pill-action="open-runtime-health">Diagnostics</button><button type="button" class="workbench-health-popover-action" data-health-pill-action="open-logs">Logs</button><button type="button" class="workbench-health-popover-action" data-health-pill-action="toggle-titlebar-load">Show load in title bar</button></div></div>',
  '<div class="workbench-health-popover" id="workbenchHealthPopover" role="dialog" tabindex="-1" aria-label="Runtime health" data-health-tone="success"><div class="workbench-health-popover-status"><span class="workbench-health-pill-dot" aria-hidden="true"></span><span>Healthy</span></div><div class="workbench-health-popover-facts"><div class="workbench-health-popover-fact workbench-health-popover-row-value-muted">no engine · no model · <em>unloaded</em></div><div class="workbench-health-popover-fact">phase ready</div><div class="workbench-health-popover-fact workbench-health-popover-row-value-danger">llama-server · <em>failed to start (gemma4:12b): llama_server_binary_not_found</em></div></div><div class="workbench-health-popover-actions"><button type="button" class="workbench-health-popover-action" data-health-pill-action="restart-llama-server">Restart llama-server</button><button type="button" class="workbench-health-popover-action" data-health-pill-action="open-runtime-health">Diagnostics</button><button type="button" class="workbench-health-popover-action" data-health-pill-action="open-logs">Logs</button><button type="button" class="workbench-health-popover-action" data-health-pill-action="toggle-titlebar-load">Show load in title bar</button></div></div>',
  '<div class="workbench-health-popover" id="workbenchHealthPopover" role="dialog" tabindex="-1" aria-label="Runtime health" data-health-tone="success"><div class="workbench-health-popover-status"><span class="workbench-health-pill-dot" aria-hidden="true"></span><span>Healthy</span></div><div class="workbench-health-popover-facts"><div class="workbench-health-popover-fact workbench-health-popover-row-value-muted">no engine · no model · <em>unloaded</em></div><div class="workbench-health-popover-fact">phase ready</div></div><div class="workbench-health-popover-actions"><button type="button" class="workbench-health-popover-action" data-health-pill-action="open-runtime-health">Diagnostics</button><button type="button" class="workbench-health-popover-action" data-health-pill-action="open-logs">Logs</button><button type="button" class="workbench-health-popover-action" data-health-pill-action="toggle-titlebar-load">Show load in title bar</button></div></div>',
];

test('a llama-server snapshot renders byte-identical markup, with or without managed_server', () => {
  LLAMA_FACETS.forEach((facet, index) => {
    const legacy = buildPopoverMarkup(BASE_STATE, pillSnapshot({ llama_server: facet }), {});
    assert.equal(legacy, LLAMA_BASELINE_MARKUP[index], 'legacy snapshot ' + index);
    const managed = {
      kind: 'llama-server', state: facet.state, alias: facet.alias, port: facet.port,
      acceleration_mode: facet.acceleration_mode || '', last_error: facet.last_error || '',
      runtime_label: facet.runtime_label || '', stopped_by: '', watchdog_watts: 0, changed_at: 0,
    };
    const current = buildPopoverMarkup(BASE_STATE, pillSnapshot({ llama_server: facet, managed_server: managed }), {});
    assert.equal(current, LLAMA_BASELINE_MARKUP[index], 'managed snapshot ' + index);
  });
});

test('the NInfer row: serving, stopped unexpectedly, failed to start, and the watchdog stop', () => {
  const serving = buildPopoverMarkup(BASE_STATE, pillSnapshot({ managed_server: ninfer() }), {});
  assert.equal(rowText(serving), 'NInfer · serving qwen3.8-27b-nvfp4 on :8034 · mtp');
  assert.match(serving, /workbench-health-popover-row-value-success">NInfer · <em>/);
  assert.doesNotMatch(serving, /restart-ninfer|restart-llama-server/);
  const plain = buildPopoverMarkup(BASE_STATE, pillSnapshot({ managed_server: ninfer({ acceleration_mode: 'off' }) }), {});
  assert.equal(rowText(plain), 'NInfer · serving qwen3.8-27b-nvfp4 on :8034');

  const crashed = buildPopoverMarkup(BASE_STATE, pillSnapshot({
    managed_server: ninfer({ state: 'crashed', last_error: 'ninfer_exited:1' }),
  }), {});
  assert.equal(rowText(crashed), 'NInfer · stopped unexpectedly (qwen3.8-27b-nvfp4)');
  assert.match(crashed, /workbench-health-popover-row-value-danger">NInfer/);
  assert.match(crashed, /data-health-pill-action="restart-ninfer">Restart NInfer<\/button>/);
  assert.doesNotMatch(crashed, /restart-llama-server/);

  const failed = buildPopoverMarkup(BASE_STATE, pillSnapshot({
    managed_server: ninfer({ state: 'stopped', last_error: 'ninfer_artifact_missing' }),
  }), {});
  assert.equal(rowText(failed), 'NInfer · failed to start (qwen3.8-27b-nvfp4): ninfer_artifact_missing');
  assert.match(failed, /data-health-pill-action="restart-ninfer"/);

  const watchdog = buildPopoverMarkup(BASE_STATE, pillSnapshot({
    managed_server: ninfer({ state: 'crashed', last_error: 'ninfer_watchdog_tripped', stopped_by: 'watchdog', watchdog_watts: 595 }),
  }), {});
  assert.equal(rowText(watchdog), 'NInfer · stopped by the power watchdog (595 W)');
  assert.match(watchdog, /workbench-health-popover-row-value-danger">NInfer/);
  assert.match(watchdog, /data-health-pill-action="restart-ninfer">Restart NInfer/);

  // A clean stop renders nothing, and managed_server wins over a stale llama_server.
  const clean = buildPopoverMarkup(BASE_STATE, pillSnapshot({
    llama_server: { state: 'crashed', alias: 'old' }, managed_server: ninfer({ state: 'stopped' }),
  }), {});
  assert.equal(rowText(clean), '');
  assert.doesNotMatch(clean, /restart-/);
});

function pillHarness(snapshot, shell) {
  const dom = new JSDOM('<!doctype html><body><div id="slot"></div></body>');
  const { window } = dom;
  const slot = window.document.getElementById('slot');
  const counters = { fetches: 0 };
  window.jennyShell = {
    diagnostics: { getJennyStatus: async () => { counters.fetches += 1; return snapshot; } },
    ...shell,
  };
  const controller = createHealthPillController({
    window, document: window.document, slot, deriveRuntimeHealthState,
    setActiveView() {}, setActiveSettingsSection() {},
  });
  return { window, slot, counters, controller };
}

test('Restart NInfer dispatches to jennyShell.ninfer.restart exactly once and re-polls', async () => {
  let ninferRestarts = 0;
  let llamaRestarts = 0;
  const { window, slot, counters, controller } = pillHarness(pillSnapshot({
    llama_server: { state: 'stopped', alias: '', port: 0 },
    managed_server: ninfer({ state: 'crashed', last_error: 'ninfer_exited:1' }),
  }), {
    ninfer: { restart: async () => { ninferRestarts += 1; return { ok: true, state: 'ready' }; } },
    llamaServer: { restart: async () => { llamaRestarts += 1; return { ok: true }; } },
  });
  await controller.refresh({ silent: true });
  const fetchesAfterRefresh = counters.fetches;
  slot.querySelector('button').click();
  const button = window.document.querySelector('[data-health-pill-action="restart-ninfer"]');
  assert.ok(button, 'a crashed NInfer renders the Restart NInfer action');
  assert.equal(button.textContent, 'Restart NInfer');
  button.click();
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(ninferRestarts, 1, 'second click while in flight is ignored');
  assert.equal(llamaRestarts, 0, 'never the llama-server bridge');
  assert.ok(counters.fetches > fetchesAfterRefresh, 'status is re-polled after the restart settles');
  controller.dispose();
});

test('Restart NInfer without the bridge is a quiet no-op', async () => {
  const { window, slot, controller } = pillHarness(pillSnapshot({ managed_server: ninfer({ state: 'crashed' }) }), {});
  await controller.refresh({ silent: true });
  slot.querySelector('button').click();
  assert.doesNotThrow(() => window.document.querySelector('[data-health-pill-action="restart-ninfer"]').click());
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.dispose();
});

// --- runtime.managed_server in the status snapshot (jenny-status-composer) ---
// tests/jenny-status-composer.test.js sits at the file-size ceiling, so these live here.

const MANAGED_KEYS = [
  'kind', 'state', 'alias', 'port', 'acceleration_mode', 'last_error', 'runtime_label',
  'stopped_by', 'watchdog_watts', 'changed_at',
];

function statusService({ ninferStatus, llamaStatus, userDataPath } = {}) {
  return {
    getBackendStatus: () => ({ phase: 'ready', detail: '', error: '', appVersion: '1.0.0-test' }),
    currentStatus: { engine: 'openai-compatible', model: ALIAS, model_loaded: true, tools_status: {} },
    shellLogStore: {
      list: () => [],
      getCurrentDiagnosticsMetadata: () => ({ sources: {}, integrity: { complete: true, partial_reasons: [] } }),
    },
    toolPermissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) },
    options: {
      userDataPath,
      getLlamaServerManager: () => (llamaStatus ? { getStatus: () => llamaStatus } : null),
      getNinferManager: () => (ninferStatus ? { getStatus: () => ninferStatus } : null),
    },
  };
}

test('managed_server exposes only allowlisted snake_case NInfer fields and redacts paths', async () => {
  const userDataPath = 'C:\\Users\\example';
  const status = await getJennyStatus(statusService({
    userDataPath,
    llamaStatus: { state: 'stopped' },
    ninferStatus: {
      state: 'CRASHED', pid: 4242, port: '8034', alias: ALIAS, displayName: 'Qwen 3.8', artifactId: 'pin-1',
      contextSize: 32768, mtp: true, runtimeLabel: '0.9.1', lastError: `ninfer_exited:1 under ${userDataPath}\\ninfer`,
      hostMemoryGb: 64, stoppedBy: 'watchdog', watchdogWatts: 595.4, watchdogTempC: 81, changedAt: '789',
      apiKey: 'secret-key', binaryPath: `${userDataPath}\\ninfer\\ninfer-serve.exe`,
    },
  }));
  const facet = status.runtime.managed_server;
  assert.deepEqual(Object.keys(facet), MANAGED_KEYS);
  assert.deepEqual(facet, {
    kind: 'ninfer', state: 'crashed', alias: ALIAS, port: 8034, acceleration_mode: 'mtp',
    last_error: 'ninfer_exited:1 under [redacted:path]\\ninfer', runtime_label: '0.9.1',
    stopped_by: 'watchdog', watchdog_watts: 595, changed_at: 789,
  });
  const wire = JSON.stringify(facet);
  for (const leak of ['secret-key', 'example', 'ninfer-serve.exe', 'pin-1', '4242', 'Qwen 3.8']) {
    assert.equal(wire.includes(leak), false, leak);
  }
  assert.equal(status.runtime.llama_server.state, 'stopped', 'llama_server keeps its own facet beside it');
});

test('managed_server coerces odd NInfer values to bounded tokens', async () => {
  const status = await getJennyStatus(statusService({
    ninferStatus: {
      state: 'exploded', port: -1, alias: 7, mtp: 'yes', runtimeLabel: 'C:\\ninfer\\bin', lastError: '',
      stoppedBy: 'user', watchdogWatts: 'hot', changedAt: 1.5,
    },
  }));
  assert.deepEqual(status.runtime.managed_server, {
    kind: 'ninfer', state: 'unknown', alias: '7', port: 0, acceleration_mode: 'off', last_error: '',
    runtime_label: '', stopped_by: '', watchdog_watts: 0, changed_at: 0,
  });
});

test('managed_server prefers NInfer only when it is not cleanly stopped', async () => {
  const llamaStatus = {
    state: 'ready', port: 8033, alias: 'gemma4:12b', accelerationMode: 'mtp', runtimeLabel: 'bundled', changedAt: 5, apiKey: 'k',
  };
  const llamaFacet = {
    kind: 'llama-server', state: 'ready', alias: 'gemma4:12b', port: 8033, acceleration_mode: 'mtp', last_error: '',
    runtime_label: 'bundled', stopped_by: '', watchdog_watts: 0, changed_at: 5,
  };
  const cleanStop = await getJennyStatus(statusService({ llamaStatus, ninferStatus: { state: 'stopped', lastError: '', port: 8034 } }));
  assert.deepEqual(cleanStop.runtime.managed_server, llamaFacet);
  assert.deepEqual(Object.keys(cleanStop.runtime.managed_server), MANAGED_KEYS);
  assert.deepEqual((await getJennyStatus(statusService({ llamaStatus }))).runtime.managed_server, llamaFacet);

  // A retained NInfer failure never hides a live llama-server (Astra b2b F4): it shows only while nothing else serves.
  const idleLlama = { ...llamaStatus, state: 'stopped' };
  const failedBehindLlama = await getJennyStatus(statusService({
    llamaStatus, ninferStatus: { state: 'stopped', lastError: 'exclusivity_refused' },
  }));
  assert.deepEqual(failedBehindLlama.runtime.managed_server, llamaFacet);
  const failedStart = await getJennyStatus(statusService({
    llamaStatus: idleLlama, ninferStatus: { state: 'stopped', lastError: 'exclusivity_refused' },
  }));
  assert.equal(failedStart.runtime.managed_server.kind, 'ninfer');
  assert.equal(failedStart.runtime.managed_server.last_error, 'exclusivity_refused');
  for (const state of ['starting', 'ready', 'stopping']) {
    const status = await getJennyStatus(statusService({ llamaStatus, ninferStatus: { state, alias: ALIAS } }));
    assert.equal(status.runtime.managed_server.kind, 'ninfer', state);
    assert.equal(status.runtime.managed_server.state, state);
  }
  const crashedBehindLlama = await getJennyStatus(statusService({ llamaStatus, ninferStatus: { state: 'crashed', alias: ALIAS } }));
  assert.deepEqual(crashedBehindLlama.runtime.managed_server, llamaFacet);
  const crashedAlone = await getJennyStatus(statusService({ llamaStatus: idleLlama, ninferStatus: { state: 'crashed', alias: ALIAS } }));
  assert.deepEqual([crashedAlone.runtime.managed_server.kind, crashedAlone.runtime.managed_server.state], ['ninfer', 'crashed']);
});

test('managed_server is null when neither manager exists, and in the unavailable facet', async () => {
  assert.equal((await getJennyStatus(statusService())).runtime.managed_server, null);
  const throwing = statusService();
  throwing.options.getNinferManager = () => ({ getStatus() { throw new Error('boom'); } });
  assert.equal((await getJennyStatus(throwing)).runtime.managed_server, null);
  const unavailable = statusService();
  Object.defineProperty(unavailable, 'currentStatus', { get() { throw new Error('runtime unavailable'); } });
  const status = await getJennyStatus(unavailable);
  assert.equal(status.runtime.available, false);
  assert.equal(status.runtime.managed_server, null);
});

test('the composed snapshot feeds the pill end to end', async () => {
  const status = await getJennyStatus(statusService({ ninferStatus: { state: 'ready', alias: ALIAS, port: 8034, mtp: true } }));
  assert.equal(rowText(buildPopoverMarkup(BASE_STATE, status, {})), 'NInfer · serving qwen3.8-27b-nvfp4 on :8034 · mtp');
});

// Gate 2026-10-14 F19: the engine row read the raw "openai-compatible" for
// NInfer, and a crashed NInfer still said "loaded".
function engineRowText(runtime) {
  const dom = new JSDOM('<!doctype html><body>' + buildPopoverMarkup(BASE_STATE, pillSnapshot(runtime), {}) + '</body>');
  return dom.window.document.querySelector('.workbench-health-popover-fact').textContent;
}

test('the engine row names NInfer for the model it serves and drops "loaded" once it crashes', () => {
  const base = { engine: 'openai-compatible', model: ALIAS, model_loaded: true };
  assert.equal(engineRowText({ ...base, managed_server: ninfer() }), `NInfer · ${ALIAS} · loaded`);
  assert.equal(engineRowText({ ...base, managed_server: ninfer({ state: 'crashed' }) }), `NInfer · ${ALIAS} · unloaded`);
  // Another model on the endpoint, or llama-server, keeps the raw engine name.
  assert.equal(engineRowText({ ...base, model: 'other', managed_server: ninfer() }), 'openai-compatible · other · loaded');
  assert.equal(engineRowText({ ...base, managed_server: { ...ninfer(), kind: 'llama-server' } }), `openai-compatible · ${ALIAS} · loaded`);
});

// --- F1: the tune drawer names NInfer when it serves the openai-compatible engine ---

async function drawerSubtitle(diagnosticsSnapshot) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  dom.window.jennyShell = {
    modelTuning: { async getState() { return { contextLengthSteps: [4096], contextLengthByModel: {} }; } },
  };
  const controller = createModelTuningDrawerController({
    state: { modelList: { data: [{ id: ALIAS, engine_type: 'openai-compatible' }] }, diagnosticsSnapshot },
    windowRef: dom.window, documentRef: dom.window.document, drawerFactory,
    inventory: { selectField, textField, actionButton },
  });
  await controller.open(ALIAS);
  const text = dom.window.document.querySelector('.model-tuning-drawer-subtitle').textContent;
  controller.dispose();
  return text;
}

test('the tune drawer labels the openai-compatible engine NInfer only when NInfer is the managed server', async () => {
  assert.match(await drawerSubtitle({ runtime: { managed_server: { kind: 'ninfer', state: 'ready', alias: ALIAS } } }), / · NInfer · applies/);
  // NInfer serving another model does not relabel this llama-server row (Astra b2b F6).
  assert.match(await drawerSubtitle({ runtime: { managed_server: { kind: 'ninfer', state: 'ready', alias: 'other-model' } } }), / · llama-server · applies/);
  assert.match(await drawerSubtitle({ runtime: { managed_server: { kind: 'llama-server', state: 'ready' } } }), / · llama-server · applies/);
  assert.match(await drawerSubtitle(undefined), / · llama-server · applies/);
});
