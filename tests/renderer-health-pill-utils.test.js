const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  combineHealthSignal,
  createHealthPillController,
  resolveLifecycleTone,
} = require('../renderer/shell/renderer-health-pill-utils');
const { buildPopoverMarkup } = require('../renderer/shell/renderer-health-pill-markup-utils');
const {
  deriveRuntimeHealthState,
} = require('../renderer/shell/renderer-runtime-health-utils');

function readyProfile(overrides = {}) {
  return {
    model_id: 'qwen3:8b',
    probe_status: 'ready',
    selected_route: 'native_tools',
    reliability_counters: {
      tool_call_parse_success_count: 0,
      tool_call_parse_failure_count: 0,
    },
    ...overrides,
  };
}

function makeSnapshot(overrides = {}) {
  return {
    runtime: {
      lifecycle: { available: true, state: 'ready', phase: 'ready' },
      provider_capability_profiles: [readyProfile()],
      recent_tool_observations: [],
      ...overrides.runtime,
    },
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('health pill combines lifecycle with full runtime-health severity', () => {
  const snapshot = makeSnapshot({
    runtime: {
      lifecycle: { available: true, state: 'ready' },
      provider_capability_profiles: [
        readyProfile({ model_id: 'blocked-model', selected_route: 'fail_closed' }),
      ],
    },
  });

  const result = combineHealthSignal(snapshot, { deriveRuntimeHealthState });

  assert.equal(result.tone, 'danger');
  assert.equal(result.label, 'Blocked');
  assert.match(result.summary, /blocked-model/);
});

test('health pill hides the ready label while preserving an accessible name', async (t) => {
  const dom = new JSDOM('<!doctype html><body><div id="slot"></div></body>');
  const { window } = dom;
  const slot = window.document.getElementById('slot');
  let snapshot = makeSnapshot();
  window.jennyShell = {
    diagnostics: { getJennyStatus: async () => snapshot },
  };
  const controller = createHealthPillController({
    window,
    document: window.document,
    slot,
    deriveRuntimeHealthState,
  });
  t.after(() => controller.dispose());

  await controller.refresh({ silent: true });
  let readyButton = slot.querySelector('#workbenchHealthPillButton');
  assert.equal(Boolean(readyButton.querySelector('.workbench-health-pill-label')), false);
  assert.equal(readyButton.getAttribute('aria-label'), 'Engine ready — runtime health');

  snapshot = makeSnapshot({
    runtime: {
      lifecycle: { available: true, state: 'starting' },
      provider_capability_profiles: [],
    },
  });
  await controller.refresh({ silent: true });
  readyButton = slot.querySelector('#workbenchHealthPillButton');
  assert.ok(readyButton.querySelector('.workbench-health-pill-label'));
});

test('health pill includes active model acquisition percent in the busy label', () => {
  const acquiring = {
    runtime: {
      lifecycle: {
        state: 'model_acquiring',
        model_acquisition: { stage: 'acquiring', percent: 43 },
      },
    },
  };
  assert.equal(combineHealthSignal(acquiring, {}).label, 'Downloading model · 43%');
  acquiring.runtime.lifecycle.model_acquisition.stage = 'resolving';
  assert.equal(combineHealthSignal(acquiring, {}).label, 'Downloading model');
  acquiring.runtime.lifecycle.model_acquisition.stage = 'acquiring';
  acquiring.runtime.lifecycle.model_acquisition.percent = 0;
  assert.equal(combineHealthSignal(acquiring, {}).label, 'Downloading model');
});

test('health pill dispose removes open-popover listeners', () => {
  const dom = new JSDOM('<!doctype html><body><div id="slot"></div></body>');
  const { window } = dom;
  const slot = window.document.getElementById('slot');
  const removed = [];
  const originalRemove = window.document.removeEventListener.bind(window.document);
  window.document.removeEventListener = function removeEventListener(type, listener, options) {
    removed.push({ type, listener, options });
    return originalRemove(type, listener, options);
  };
  window.jennyShell = {
    diagnostics: {
      getJennyStatus: async () => makeSnapshot(),
    },
  };

  const controller = createHealthPillController({
    window,
    document: window.document,
    slot,
    deriveRuntimeHealthState,
  });

  slot.querySelector('button').click();
  controller.dispose();

  assert.ok(removed.some((entry) => entry.type === 'click'));
  assert.ok(removed.some((entry) => entry.type === 'keydown'));
});

test('health pill does not mutate DOM after disposed in-flight refresh resolves', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="slot"></div></body>');
  const { window } = dom;
  const slot = window.document.getElementById('slot');
  const request = deferred();
  window.jennyShell = {
    diagnostics: {
      getJennyStatus: () => request.promise,
    },
  };
  const controller = createHealthPillController({
    window,
    document: window.document,
    slot,
    deriveRuntimeHealthState,
  });

  const refreshPromise = controller.refresh({ silent: true });
  controller.dispose();
  request.resolve(makeSnapshot({
    runtime: {
      lifecycle: { available: true, state: 'error' },
      provider_capability_profiles: [],
    },
  }));
  await refreshPromise;

  assert.equal(slot.innerHTML, '');
});

test('health pill poll failures route to intake once per failure episode (EH-W10)', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="slot"></div></body>');
  const { window } = dom;
  const slot = window.document.getElementById('slot');
  let failing = true;
  window.jennyShell = {
    diagnostics: {
      getJennyStatus: async () => {
        if (failing) throw new Error('status request failed');
        return makeSnapshot();
      },
    },
  };
  const reports = [];
  const controller = createHealthPillController({
    window,
    document: window.document,
    slot,
    deriveRuntimeHealthState,
    reportError(input, context) {
      reports.push({ input, context });
      return { route: { ruleId: 6, surface: 'none' }, toastId: '' };
    },
  });

  await controller.refresh({ silent: true });
  await controller.refresh({ silent: true });
  assert.equal(reports.length, 1, 'repeat failures in one episode do not stack');
  assert.equal(reports[0].context.origin, 'health-poll');
  assert.equal(reports[0].input.dedupeKey, 'health-poll:status');
  assert.equal(reports[0].input.message, 'status request failed');

  failing = false;
  await controller.refresh({ silent: true });
  failing = true;
  await controller.refresh({ silent: true });
  assert.equal(reports.length, 2, 'a recovery starts a new failure episode');
  controller.dispose();
});

test('health pill degrades after consecutive silent refresh failures and resets on success', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="slot"></div></body>');
  const { window } = dom;
  const slot = window.document.getElementById('slot');
  let failing = false;
  window.jennyShell = {
    diagnostics: {
      getJennyStatus: async () => {
        if (failing) throw new Error('status request failed');
        return makeSnapshot();
      },
    },
  };
  const controller = createHealthPillController({
    window,
    document: window.document,
    slot,
    deriveRuntimeHealthState,
  });

  await controller.refresh({ silent: true });
  failing = true;
  await controller.refresh({ silent: true });
  assert.equal(controller.getState().tone, 'success', 'one silent failure preserves the displayed tone');
  await controller.refresh({ silent: true });
  assert.deepEqual(
    { tone: controller.getState().tone, label: controller.getState().label },
    { tone: 'muted', label: 'Unknown' }
  );

  failing = false;
  await controller.refresh({ silent: true });
  failing = true;
  await controller.refresh({ silent: true });
  assert.equal(controller.getState().tone, 'success', 'success resets the consecutive-failure counter');
  controller.dispose();
});

test('health pill degrades to Unknown when the diagnostics bridge disappears', async (t) => {
  const dom = new JSDOM('<!doctype html><body><div id="slot"></div></body>');
  const { window } = dom;
  const slot = window.document.getElementById('slot');
  window.jennyShell = {
    diagnostics: { getJennyStatus: async () => makeSnapshot() },
  };
  const reports = [];
  const controller = createHealthPillController({
    window,
    document: window.document,
    slot,
    deriveRuntimeHealthState,
    reportError(input, context) {
      reports.push({ input, context });
      return { route: { ruleId: 6, surface: 'none' }, toastId: '' };
    },
  });
  t.after(() => controller.dispose());

  await controller.refresh({ silent: true });
  assert.equal(controller.getState().tone, 'success');

  delete window.jennyShell.diagnostics;
  await controller.refresh({ silent: true });
  assert.equal(controller.getState().tone, 'success', 'one missing-bridge refresh preserves the displayed tone');
  await controller.refresh({ silent: true });
  assert.deepEqual(
    { tone: controller.getState().tone, label: controller.getState().label },
    { tone: 'muted', label: 'Unknown' },
    'a persistently missing bridge must not leave a stale green dot'
  );
  assert.equal(reports.length, 1, 'missing bridge reports once per failure episode');
  assert.equal(reports[0].input.dedupeKey, 'health-poll:status');
});

test('health pill popover omits the acquisition row when no acquisition is active', () => {
  const idleAcquisition = makeSnapshot({
    runtime: {
      engine: 'ollama',
      model: 'qwen3:8b',
      model_loaded: true,
      lifecycle: {
        available: true,
        state: 'ready',
        phase: 'ready',
        model_acquisition: { requested_model: 'qwen3:8b', stage: 'unloaded', percent: 0 },
      },
      provider_capability_profiles: [readyProfile()],
    },
  });
  const idleHtml = buildPopoverMarkup(
    { error: '', toneLabel: { tone: 'success', label: 'Ready', summary: '' } },
    idleAcquisition,
    {}
  );
  assert.equal(
    (idleHtml.match(/workbench-health-popover-fact[ "]/g) || []).length,
    2,
    'ready snapshots show engine + lifecycle facts only'
  );

  const emptyAcquisition = makeSnapshot({
    runtime: {
      lifecycle: { available: true, state: 'ready', phase: 'ready', model_acquisition: {} },
      provider_capability_profiles: [readyProfile()],
    },
  });
  const emptyHtml = buildPopoverMarkup(
    { error: '', toneLabel: { tone: 'success', label: 'Ready', summary: '' } },
    emptyAcquisition,
    {}
  );
  assert.doesNotMatch(emptyHtml, /no model requested/, 'empty acquisition object renders no filler row');

  const activeAcquisition = makeSnapshot({
    runtime: {
      lifecycle: {
        available: true,
        state: 'model_acquiring',
        model_acquisition: { requested_model: 'ornith:9b', stage: 'acquiring', percent: 43 },
      },
      provider_capability_profiles: [],
    },
  });
  const activeHtml = buildPopoverMarkup(
    { error: '', toneLabel: { tone: 'pending', label: 'Downloading model · 43%', summary: '' } },
    activeAcquisition,
    {}
  );
  assert.match(activeHtml, /ornith:9b/, 'active acquisition renders its row');
  assert.match(activeHtml, /43%/);
});

test('health pill moves focus into the popover when opened', async (t) => {
  const dom = new JSDOM('<!doctype html><body><div id="slot"></div></body>');
  const { window } = dom;
  const slot = window.document.getElementById('slot');
  window.jennyShell = {
    diagnostics: { getJennyStatus: async () => makeSnapshot() },
  };
  const controller = createHealthPillController({
    window,
    document: window.document,
    slot,
    deriveRuntimeHealthState,
  });
  t.after(() => controller.dispose());
  await controller.refresh({ silent: true });

  slot.querySelector('button').click();
  const popover = window.document.getElementById('workbenchHealthPopover');
  assert.ok(popover);
  assert.ok(popover === window.document.activeElement || popover.contains(window.document.activeElement));
});

test('health pill distinguishes acquisition, loading, ready, and unavailable', () => {
  assert.deepEqual(resolveLifecycleTone('model_acquiring'), {
    tone: 'pending', label: 'Downloading model',
  });
  assert.deepEqual(resolveLifecycleTone('model_loading'), {
    tone: 'pending', label: 'Loading model',
  });
  assert.equal(resolveLifecycleTone('ready').tone, 'success');
  assert.equal(resolveLifecycleTone('model_unavailable').tone, 'danger');
  assert.equal(combineHealthSignal({
    runtime: { lifecycle: { state: 'stopped', model_state: 'unloaded' } },
  }, {}).label, 'Offline');

  const snapshot = makeSnapshot({
    runtime: {
      engine: 'ollama',
      model: '',
      model_loaded: false,
      lifecycle: {
        available: true,
        state: 'model_unavailable',
        model_state: 'unavailable',
        model_acquisition: {
          requested_model: 'ornith:9b',
          stage: 'unavailable',
          percent: 42,
          completed_bytes: 1024,
          total_bytes: 2048,
        },
      },
      provider_capability_profiles: [],
    },
  });
  const html = buildPopoverMarkup(
    { error: '', toneLabel: { tone: 'danger', label: 'Model unavailable' } },
    snapshot,
    {}
  );
  assert.match(html, /ornith:9b/);
  assert.match(html, /unavailable/);
  assert.match(html, /Retry/);
  assert.match(html, /Models/);
  assert.doesNotMatch(html, /Open Models/);
  assert.doesNotMatch(html, /Â·/, 'acquisition separators must not contain mojibake');
});

test('health pill unavailable actions retry and navigate to Settings Models', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="slot"></div></body>');
  const { window } = dom;
  const slot = window.document.getElementById('slot');
  let retries = 0;
  const navigation = [];
  const snapshot = makeSnapshot({
    runtime: {
      lifecycle: {
        available: true,
        state: 'model_unavailable',
        model_state: 'unavailable',
        model_acquisition: { requested_model: 'ornith:9b', stage: 'unavailable' },
      },
      provider_capability_profiles: [],
    },
  });
  window.jennyShell = {
    diagnostics: { getJennyStatus: async () => snapshot },
    backend: { retryStart: async () => { retries += 1; } },
  };
  const controller = createHealthPillController({
    window,
    document: window.document,
    slot,
    deriveRuntimeHealthState,
    setActiveView(view) { navigation.push(['view', view]); },
    setActiveSettingsSection(section) { navigation.push(['section', section]); },
  });
  await controller.refresh({ silent: true });
  slot.querySelector('button').click();
  window.document.querySelector('[data-health-pill-action="retry-model"]').click();
  await Promise.resolve();
  assert.equal(retries, 1);

  slot.querySelector('button').click();
  window.document.querySelector('[data-health-pill-action="open-models"]').click();
  assert.deepEqual(navigation, [['section', 'models'], ['view', 'settings']]);
  controller.dispose();
});

test('health pill popover shows the managed llama-server row and a Restart action only when crashed', () => {
  const baseState = { error: '', toneLabel: { tone: 'success', label: 'Healthy' } };
  const ready = buildPopoverMarkup(baseState, makeSnapshot({
    runtime: { llama_server: { state: 'ready', alias: 'gemma4:12b', port: 8033, acceleration_mode: 'mtp' } },
  }), {});
  assert.match(ready, /llama-server · <em>serving gemma4:12b on :8033 · mtp<\/em>/);
  assert.match(ready, /workbench-health-popover-row-value-success">llama-server/);
  assert.doesNotMatch(ready, /restart-llama-server/);

  const crashed = buildPopoverMarkup(baseState, makeSnapshot({
    runtime: { llama_server: { state: 'crashed', alias: 'gemma4:12b', port: 8033, acceleration_mode: 'off' } },
  }), {});
  assert.match(crashed, /workbench-health-popover-row-value-danger">llama-server · <em>stopped unexpectedly \(gemma4:12b\)<\/em>/);
  assert.match(crashed, /data-health-pill-action="restart-llama-server"/);
  assert.match(crashed, /Restart llama-server/);

  const stopped = buildPopoverMarkup(baseState, makeSnapshot({
    runtime: { llama_server: { state: 'stopped', alias: '', port: 8033 } },
  }), {});
  assert.doesNotMatch(stopped, /llama-server/);
  // A failed (re)launch parks the manager in 'stopped' with the error: still actionable.
  const failed = buildPopoverMarkup(baseState, makeSnapshot({
    runtime: { llama_server: { state: 'stopped', alias: 'gemma4:12b', port: 8033, last_error: 'llama_server_binary_not_found' } },
  }), {});
  assert.match(failed, /workbench-health-popover-row-value-danger">llama-server · <em>failed to start \(gemma4:12b\): llama_server_binary_not_found<\/em>/);
  assert.match(failed, /data-health-pill-action="restart-llama-server"/);
  const absent = buildPopoverMarkup(baseState, makeSnapshot(), {});
  assert.doesNotMatch(absent, /llama-server/);
});

test('health pill Restart action calls llamaServer.restart once and refreshes', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="slot"></div></body>');
  const { window } = dom;
  const slot = window.document.getElementById('slot');
  let restarts = 0;
  let fetches = 0;
  const snapshot = makeSnapshot({
    runtime: { llama_server: { state: 'crashed', alias: 'gemma4:12b', port: 8033 } },
  });
  window.jennyShell = {
    diagnostics: { getJennyStatus: async () => { fetches += 1; return snapshot; } },
    llamaServer: { restart: async () => { restarts += 1; return { ok: true, state: 'ready' }; } },
  };
  const controller = createHealthPillController({
    window,
    document: window.document,
    slot,
    deriveRuntimeHealthState,
    setActiveView() {},
    setActiveSettingsSection() {},
  });
  await controller.refresh({ silent: true });
  const fetchesAfterRefresh = fetches;
  slot.querySelector('button').click();
  const button = window.document.querySelector('[data-health-pill-action="restart-llama-server"]');
  assert.ok(button, 'crashed server renders the Restart row');
  button.click();
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(restarts, 1, 'second click while in flight is ignored');
  assert.ok(fetches > fetchesAfterRefresh, 'status is re-polled after the restart settles');
  controller.dispose();
});
