'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const drawerFactory = require('../renderer/inventory/drawer');
const selectField = require('../renderer/inventory/select-field');
const textField = require('../renderer/inventory/text-field');
const actionButton = require('../renderer/inventory/action-button');
const segmentedControl = require('../renderer/inventory/segmented-control');
const toggleSwitch = require('../renderer/inventory/toggle-switch');
const { createModelTuningDrawerController } = require('../renderer/shell/renderer-model-tuning-drawer');
const engineUtils = require('../renderer/shell/renderer-model-tuning-engine-utils');
const { normalizeLocalEngines } = require('../services/shell-config-engines');

function tuningState() {
  return {
    contextLengthSteps: [4096, 8192],
    contextLengthByModel: { 'gemma3:latest': 4096 },
    ratioByModel: { 'gemma3:latest': 0.8 },
    generationProfilesByModel: { 'gemma3:latest': { temperature: 0.6 } },
  };
}

function emptySettings(overrides = {}) {
  return {
    localEngines: { openaiCompatible: { managed: { enabled: true, perModel: {} } } },
    accelerationCatalog: { defaults: { vramHeadroomMb: 2048 }, families: [] },
    ...overrides,
  };
}

function createHarness(options = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  const calls = [];
  const settings = options.settings || emptySettings();
  const engineType = options.engineType || 'ollama';
  const state = {
    features: { featureFlags: { llama_server_acceleration: options.flag !== false } },
    modelList: { data: [{ id: 'gemma3:latest', engine_type: engineType }] },
  };
  const engineUpdates = options.engineUpdates || (async (payload) => {
    const localEngines = { openaiCompatible: { managed: payload.managed } };
    return { ok: true, localEngines };
  });
  dom.window.jennyShell = {
    modelTuning: {
      async getState() { return tuningState(); },
      async update(payload) {
        calls.push(['tuning', payload]);
        return { status: 'applied', state: tuningState() };
      },
    },
    engines: {
      async getSettings() { return settings; },
      async updateSettings(payload) {
        calls.push(['engine', payload]);
        return engineUpdates(payload);
      },
    },
    llamaServer: {
      async listLocalGgufs() { return { ok: true, entries: options.ggufs || [] }; },
      async getStatus() { return { ok: true, state: 'stopped', ...(options.status || {}) }; },
      chooseGguf: options.chooseGguf || (async () => ({ ok: true, path: '' })),
    },
  };
  const changed = [];
  const controller = createModelTuningDrawerController({
    state, windowRef: dom.window, documentRef: dom.window.document, drawerFactory,
    inventory: { selectField, textField, actionButton, segmentedControl, toggleSwitch },
    onEngineSettingsChanged(localEngines) { changed.push(localEngines); },
  });
  return { dom, state, calls, changed, controller };
}

function engineEvent(windowRef, id, value) {
  return new windowRef.CustomEvent('inv-segmented-change', { bubbles: true, detail: { id, value } });
}

function toggleEvent(windowRef, id, checked) {
  return new windowRef.CustomEvent('inv-toggle-change', { bubbles: true, detail: { id, checked } });
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const gguf = {
  tag: 'gemma3:latest', dir: 'G:\\models\\gemma3-latest', mainGguf: 'gemma3.gguf',
  drafterGguf: 'mtp-gemma3.gguf', source: 'library', sizeBytes: 1,
};
const eligibleCatalog = {
  defaults: { vramHeadroomMb: 2048 },
  families: [{ family: 'gemma3', matchPrefixes: ['gemma3'], mtp: 'yes', vramHeadroomMb: 512 }],
};

test('engine section obeys the feature and engine gates', async () => {
  const off = createHarness({ flag: false });
  await off.controller.open('gemma3:latest');
  assert.equal(off.dom.window.document.querySelector('[data-model-tuning-engine]'), null);
  off.controller.dispose();

  const plugin = createHarness({ engineType: 'plugin_host' });
  await plugin.controller.open('gemma3:latest');
  assert.equal(plugin.dom.window.document.querySelector('[data-model-tuning-engine]'), null);
  plugin.controller.dispose();

  const ollama = createHarness();
  await ollama.controller.open('gemma3:latest');
  const host = ollama.dom.window.document.getElementById('modelTuningDrawer');
  assert.ok(host.querySelector('[data-model-tuning-engine]'));
  assert.equal(host.querySelector('[data-value="ollama"]').getAttribute('aria-checked'), 'true');
  assert.equal(host.querySelector('[data-model-tuning-row="mtp"]').hidden, true);
  assert.equal(host.querySelector('[data-model-tuning-gguf]').textContent, 'Not found for this tag');
  // A greyed-out llama-server option must say what unlocks it.
  assert.equal(host.querySelector('[data-value="llama-server"]').disabled, true);
  assert.equal(host.querySelector('[data-model-tuning-row="engine"] .model-tuning-row-range').textContent,
    'Choose… the .gguf for this model, then Apply, then Use');
  ollama.controller.dispose();
});

test('pickerDefaultDir follows persisted, scanned, last-pick, and library-root precedence', () => {
  const view = {
    ggufEntry: { dir: 'G:\\models\\scanned' },
    lastPickDir: 'D:\\models\\picked',
    libraryRoots: ['E:\\models\\library'],
  };
  assert.equal(engineUtils.pickerDefaultDir(view, { modelPath: 'C:\\models\\persisted\\model.gguf' }),
    'C:\\models\\persisted');
  assert.equal(engineUtils.pickerDefaultDir(view, { modelPath: '' }), 'G:\\models\\scanned');
  assert.equal(engineUtils.pickerDefaultDir({
    ...view,
    ggufEntry: { dir: 'G:\\ollama\\blobs', source: 'ollama' },
  }, { modelPath: '' }), 'D:\\models\\picked');
  assert.equal(engineUtils.pickerDefaultDir({ ...view, ggufEntry: null }, { modelPath: '' }), 'D:\\models\\picked');
  assert.equal(engineUtils.pickerDefaultDir({ ...view, ggufEntry: null, lastPickDir: '' }, { modelPath: '' }),
    'E:\\models\\library');
  assert.equal(engineUtils.pickerDefaultDir({ ggufEntry: null, lastPickDir: '', libraryRoots: [] }, { modelPath: '' }), '');
  assert.equal(engineUtils.pickerDefaultDir(null, { modelPath: '' }), '');
  assert.equal(engineUtils.pickerDefaultDir(view, null), '');
});

test('an Ollama blob copy enables llama-server and explains the missing adjacent drafter', async () => {
  const path = 'C:\\ollama\\models\\blobs\\sha256-abc';
  const harness = createHarness({
    ggufs: [{
      tag: 'gemma3:latest',
      dir: 'C:\\ollama\\models\\blobs',
      mainGguf: 'sha256-abc',
      drafterGguf: '',
      source: 'ollama',
    }],
    settings: emptySettings({ accelerationCatalog: eligibleCatalog }),
  });
  await harness.controller.open('gemma3:latest');
  const host = harness.dom.window.document.getElementById('modelTuningDrawer');

  assert.equal(host.querySelector('[data-value="llama-server"]').disabled, false);
  assert.equal(host.querySelector('[data-model-tuning-gguf]').textContent, "Ollama's copy");
  assert.equal(host.querySelector('[data-model-tuning-gguf]').title, path);
  host.querySelector('[data-inv-segmented="modelTuningEngine"]')
    .dispatchEvent(engineEvent(harness.dom.window, 'modelTuningEngine', 'llama-server'));
  assert.equal(
    host.querySelector('[data-model-tuning-row="mtp"] .model-tuning-row-range').textContent,
    "MTP drafter not found beside Ollama's copy · add its folder under GGUF folders"
  );
  harness.controller.dispose();
});

test('GGUF picker opens in the scanned entry directory', async () => {
  const pickerCalls = [];
  const harness = createHarness({
    ggufs: [gguf],
    chooseGguf: async (options) => {
      pickerCalls.push(options);
      return { ok: true, path: '' };
    },
  });
  await harness.controller.open('gemma3:latest');
  const host = harness.dom.window.document.getElementById('modelTuningDrawer');
  host.querySelector('[data-action="choose-model-gguf"]').click();
  await flush();
  assert.deepEqual(pickerCalls, [{ defaultPath: 'G:\\models\\gemma3-latest' }]);
  harness.controller.dispose();
});

test('engine selection updates the drawer in place and exposes eligible MTP', async () => {
  const harness = createHarness({ ggufs: [gguf], settings: emptySettings({ accelerationCatalog: eligibleCatalog }) });
  await harness.controller.open('gemma3:latest');
  const host = harness.dom.window.document.getElementById('modelTuningDrawer');
  const group = host.querySelector('[data-inv-segmented="modelTuningEngine"]');
  const focused = host.querySelector('[data-value="ollama"]');
  focused.focus();
  const active = harness.dom.window.document.activeElement;
  group.dispatchEvent(engineEvent(harness.dom.window, 'modelTuningEngine', 'llama-server'));
  assert.equal(harness.dom.window.document.getElementById('modelTuningDrawer'), host);
  assert.equal(harness.dom.window.document.activeElement, active);
  assert.equal(host.querySelector('[data-model-tuning-row="mtp"]').hidden, false);
  assert.equal(host.querySelector('[data-model-tuning-row="engine"] .model-tuning-row-range').textContent, 'Starts when you press Use');
  assert.equal(host.querySelector('[data-model-tuning-row="mtp"] .model-tuning-row-range').textContent, 'MTP uses about 0.5 GB more VRAM');
  assert.equal(host.querySelector('[data-action="save-model-tuning"]').textContent, 'Apply 1 change');
  harness.controller.dispose();
});

test('MTP save persists managed settings without writing model tuning', async () => {
  const harness = createHarness({ ggufs: [gguf], settings: emptySettings({ accelerationCatalog: eligibleCatalog }) });
  await harness.controller.open('gemma3:latest');
  const host = harness.dom.window.document.getElementById('modelTuningDrawer');
  host.querySelector('[data-inv-segmented="modelTuningEngine"]')
    .dispatchEvent(engineEvent(harness.dom.window, 'modelTuningEngine', 'llama-server'));
  host.querySelector('[data-inv-toggle="modelTuningMtp"]')
    .dispatchEvent(toggleEvent(harness.dom.window, 'modelTuningMtp', true));
  assert.equal(host.querySelector('[data-action="save-model-tuning"]').textContent, 'Apply 2 changes');
  host.querySelector('[data-action="save-model-tuning"]').click();
  await flush();
  assert.deepEqual(harness.calls, [['engine', { managed: { enabled: true, perModel: {
    'gemma3-latest': {
      engine: 'llama-server', tag: 'gemma3:latest',
      modelPath: 'G:\\models\\gemma3-latest\\gemma3.gguf', mtp: { mode: 'mtp' },
    },
  } } }]]);
  assert.equal(harness.changed.length, 1);
  assert.deepEqual(harness.changed[0], { openaiCompatible: { managed: harness.calls[0][1].managed } });
  assert.match(host.textContent, /Applied\. Press Use on this model to run it with these settings\./);
  harness.controller.dispose();
});

test('ineligible family notes distinguish unverified MTP from unsupported MTP', async () => {
  const notes = [
    ['unverified', 'MTP not verified for this family yet (no separate file needed)'],
    ['no', 'MTP not supported for this family'],
  ];
  for (const [mtp, expected] of notes) {
    const settings = emptySettings({ accelerationCatalog: {
      defaults: { vramHeadroomMb: 2048 },
      families: [{ family: 'gemma3', matchPrefixes: ['gemma3'], mtp }],
    } });
    const harness = createHarness({ ggufs: [gguf], settings });
    await harness.controller.open('gemma3:latest');
    const host = harness.dom.window.document.getElementById('modelTuningDrawer');
    assert.equal(host.querySelector('[data-inv-toggle="modelTuningMtp"]').disabled, true);
    assert.equal(host.querySelector('[data-model-tuning-row="mtp"] .model-tuning-row-range').textContent, expected);
    harness.controller.dispose();
  }
});

test('unsupported MTP persists off', async () => {
  const harness = createHarness({ ggufs: [gguf], settings: emptySettings({ accelerationCatalog: {
    defaults: { vramHeadroomMb: 2048 },
    families: [{ family: 'gemma3', matchPrefixes: ['gemma3'], mtp: 'no' }],
  } }) });
  await harness.controller.open('gemma3:latest');
  const host = harness.dom.window.document.getElementById('modelTuningDrawer');
  host.querySelector('[data-inv-segmented="modelTuningEngine"]')
    .dispatchEvent(engineEvent(harness.dom.window, 'modelTuningEngine', 'llama-server'));
  host.querySelector('[data-action="save-model-tuning"]').click();
  await flush();
  assert.equal(harness.calls[0][1].managed.perModel['gemma3-latest'].mtp.mode, 'off');
  harness.controller.dispose();
});

test('GGUF picker enables llama-server and cancellation is a no-op', async () => {
  const picks = [
    { ok: true, path: 'D:\\x\\m.gguf', dir: 'D:\\x', drafterGguf: '' },
    { ok: true, path: '', dir: '', drafterGguf: '' },
  ];
  const harness = createHarness({
    chooseGguf: async () => picks.shift(),
    settings: emptySettings({ accelerationCatalog: eligibleCatalog }),
  });
  await harness.controller.open('gemma3:latest');
  const host = harness.dom.window.document.getElementById('modelTuningDrawer');
  assert.equal(host.querySelector('[data-value="llama-server"]').disabled, true);
  host.querySelector('[data-action="choose-model-gguf"]').click();
  await flush();
  assert.equal(host.querySelector('[data-value="llama-server"]').disabled, false);
  assert.equal(host.querySelector('[data-model-tuning-gguf]').textContent, 'm.gguf');
  // The pick selects llama-server: option checked, MTP row shown, status flips
  // from the "Choose a GGUF" hint to the Use hint, and Apply counts the change.
  assert.equal(host.querySelector('[data-value="llama-server"]').getAttribute('aria-checked'), 'true');
  assert.equal(host.querySelector('[data-model-tuning-row="mtp"]').hidden, false);
  assert.equal(host.querySelector('[data-model-tuning-row="engine"] .model-tuning-row-range').textContent,
    'Starts when you press Use');
  assert.equal(host.querySelector('[data-action="save-model-tuning"]').textContent, 'Apply 2 changes');
  // The picked folder has no mtp-* drafter: the MTP note must say so now.
  assert.equal(host.querySelector('[data-model-tuning-row="mtp"] .model-tuning-row-range').textContent,
    'Drafter file missing \u00b7 falls back to plain decoding');
  host.querySelector('[data-action="choose-model-gguf"]').click();
  await flush();
  assert.equal(host.querySelector('[data-model-tuning-gguf]').title, 'D:\\x\\m.gguf');
  harness.controller.dispose();
});

test('a picked GGUF persists its directory after Apply', async () => {
  const harness = createHarness({
    chooseGguf: async () => ({ ok: true, path: 'D:\\x\\m.gguf', dir: 'D:\\x', drafterGguf: '' }),
    settings: emptySettings({ accelerationCatalog: eligibleCatalog }),
  });
  await harness.controller.open('gemma3:latest');
  const host = harness.dom.window.document.getElementById('modelTuningDrawer');
  host.querySelector('[data-action="choose-model-gguf"]').click();
  await flush();
  host.querySelector('[data-action="save-model-tuning"]').click();
  await flush();
  assert.equal(harness.calls[0][0], 'engine');
  assert.equal(harness.calls[0][1].managed.lastPickDir, 'D:\\x');
  harness.controller.dispose();
});

test('persisted serving engine state renders selected and clean', async () => {
  const modelPath = 'G:\\models\\gemma3-latest\\gemma3.gguf';
  const settings = emptySettings({
    localEngines: { openaiCompatible: { managed: { enabled: true, perModel: {
      'gemma3-latest': { engine: 'llama-server', tag: 'gemma3:latest', modelPath, mtp: { mode: 'mtp' } },
    } } } },
    accelerationCatalog: eligibleCatalog,
  });
  const harness = createHarness({ settings, status: { state: 'ready', alias: 'gemma3:latest', port: 8033, accelerationMode: 'mtp' } });
  await harness.controller.open('gemma3:latest');
  const host = harness.dom.window.document.getElementById('modelTuningDrawer');
  assert.equal(host.querySelector('[data-value="llama-server"]').getAttribute('aria-checked'), 'true');
  assert.equal(host.querySelector('[data-inv-toggle="modelTuningMtp"]').getAttribute('aria-checked'), 'true');
  assert.equal(host.querySelector('[data-model-tuning-row="engine"] .model-tuning-row-range').textContent, 'Serving on :8033 · MTP on');
  assert.equal(host.querySelector('[data-action="save-model-tuning"]').textContent, 'Apply 0 changes');
  assert.equal(host.querySelector('[data-action="save-model-tuning"]').disabled, true);
  harness.controller.dispose();
});

test('a persisted Ollama blob path still labels the GGUF row as Ollama\'s copy', async () => {
  // After Apply the path is a bare `sha256-<64 hex>` blob name; the row must
  // not degrade into a hash the owner cannot recognise.
  const modelPath = 'G:\\Ollama\\blobs\\sha256-' + 'c'.repeat(64);
  const settings = emptySettings({
    localEngines: { openaiCompatible: { managed: { enabled: true, perModel: {
      'gemma3-latest': { engine: 'llama-server', tag: 'gemma3:latest', modelPath, mtp: { mode: 'off' } },
    } } } },
    accelerationCatalog: eligibleCatalog,
  });
  const harness = createHarness({ settings });
  await harness.controller.open('gemma3:latest');
  const host = harness.dom.window.document.getElementById('modelTuningDrawer');

  assert.equal(host.querySelector('[data-model-tuning-gguf]').textContent, "Ollama's copy");
  assert.equal(host.querySelector('[data-model-tuning-gguf]').title, modelPath);
  harness.controller.dispose();
});

test('engine notes distinguish blob-backed, normal missing, and present drafters', () => {
  const modelPath = 'C:\\ollama\\models\\blobs\\sha256-abc';
  const view = engineUtils.deriveEngineView({
    activeModelId: 'gemma3:latest', engineType: 'openai-compatible', shellState: {},
    engineSettings: emptySettings({
      localEngines: { openaiCompatible: { managed: { enabled: true, perModel: {
        'gemma3-latest': { engine: 'llama-server', modelPath, mtp: { mode: 'mtp' } },
      } } } }, accelerationCatalog: eligibleCatalog,
    }),
    localGgufs: { entries: [{
      tag: 'gemma3:latest', dir: 'C:\\ollama\\models\\blobs', mainGguf: 'sha256-abc',
      drafterGguf: '', source: 'persisted', ollamaBlob: true,
    }] }, serverStatus: null,
  });
  assert.equal(view.ggufEntry.ollamaBlob, true);
  assert.equal(engineUtils.engineNote(view),
    "MTP drafter not found beside Ollama's copy \u00b7 add its folder under GGUF folders");
  const base = { eligible: true, headroomMb: 512 };
  assert.equal(engineUtils.engineNote({
    ...base, ggufEntry: { source: 'persisted', mainGguf: 'model.gguf', drafterGguf: '' },
  }), 'Drafter file missing \u00b7 falls back to plain decoding');
  assert.equal(engineUtils.engineNote({
    ...base, ggufEntry: { source: 'persisted', ollamaBlob: true, drafterGguf: 'mtp-model.gguf' },
  }), 'MTP uses about 0.5 GB more VRAM');
});

test('serving status explains requested MTP acceleration without exposing reason codes', () => {
  const view = { serving: true };
  const mtpDraft = { mtp: true };
  assert.equal(engineUtils.engineStatusText(view, mtpDraft, {
    port: 8033, accelerationMode: 'mtp', accelerationReason: 'mtp',
  }), 'Serving on :8033 \u00b7 MTP on');
  const missing = engineUtils.engineStatusText(view, mtpDraft, {
    port: 8033, accelerationMode: 'ngram', accelerationReason: 'drafter_missing',
  });
  assert.equal(missing, 'Serving on :8033 \u00b7 MTP off: no drafter file beside this model');
  assert.doesNotMatch(missing, /drafter_missing/);
  assert.equal(engineUtils.engineStatusText(view, mtpDraft, {
    port: 8033, accelerationMode: 'unknown', accelerationReason: 'unknown',
  }), 'Serving on :8033 \u00b7 MTP state unknown');
  assert.equal(engineUtils.engineStatusText(view, { mtp: false }, {
    port: 8033, accelerationMode: 'ngram', accelerationReason: 'drafter_missing',
  }), 'Serving on :8033');
  assert.equal(engineUtils.engineStatusText(view, mtpDraft, {
    port: 8033, accelerationMode: 'ngram',
  }), 'Serving on :8033');
});

test('serving status maps only the supported MTP degradation reasons', () => {
  const view = { serving: true };
  const draft = { mtp: true };
  assert.equal(engineUtils.engineStatusText(view, draft, {
    port: 8033, accelerationMode: 'off', accelerationReason: 'spawn_failed',
  }), 'Serving on :8033 \u00b7 MTP off: the server would not start with it');
  assert.equal(engineUtils.engineStatusText(view, draft, {
    port: 8033, accelerationMode: 'ngram', accelerationReason: 'mtp_ineligible:binary',
  }), 'Serving on :8033 \u00b7 MTP off: unsupported by this build or family');
  assert.equal(engineUtils.engineStatusText(view, draft, {
    port: 8033, accelerationMode: 'ngram', accelerationReason: 'flag_off',
  }), 'Serving on :8033 \u00b7 MTP off');
});

test('mixed save writes managed settings before model tuning', async () => {
  const harness = createHarness({ ggufs: [gguf], settings: emptySettings({ accelerationCatalog: eligibleCatalog }) });
  await harness.controller.open('gemma3:latest');
  const host = harness.dom.window.document.getElementById('modelTuningDrawer');
  const temperature = host.querySelector('#modelTuningTemperature');
  temperature.value = '0.4';
  temperature.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
  host.querySelector('[data-inv-segmented="modelTuningEngine"]')
    .dispatchEvent(engineEvent(harness.dom.window, 'modelTuningEngine', 'llama-server'));
  host.querySelector('[data-action="save-model-tuning"]').click();
  await flush();
  await flush();
  assert.deepEqual(harness.calls.map((call) => call[0]), ['engine', 'tuning']);
  assert.equal(harness.calls[1][1].generationProfile.temperature, 0.4);
  harness.controller.dispose();
});

test('closing the drawer during an engine write does not leave it stuck pending', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const harness = createHarness({
    ggufs: [gguf],
    settings: emptySettings({ accelerationCatalog: eligibleCatalog }),
    engineUpdates: async (payload) => {
      await gate;
      return { ok: true, localEngines: { openaiCompatible: { managed: payload.managed } } };
    },
  });
  await harness.controller.open('gemma3:latest');
  let host = harness.dom.window.document.getElementById('modelTuningDrawer');
  host.querySelector('[data-inv-segmented="modelTuningEngine"]')
    .dispatchEvent(engineEvent(harness.dom.window, 'modelTuningEngine', 'llama-server'));
  host.querySelector('[data-action="save-model-tuning"]').click();
  await flush();
  assert.equal(host.querySelector('[data-action="save-model-tuning"]').textContent, 'Applying…');
  harness.controller.close();
  release();
  await flush();
  await flush();
  // The write landed while the drawer was closed: the library still hears it.
  assert.equal(harness.changed.length, 1);

  await harness.controller.open('gemma3:latest');
  host = harness.dom.window.document.getElementById('modelTuningDrawer');
  host.querySelector('[data-inv-segmented="modelTuningEngine"]')
    .dispatchEvent(engineEvent(harness.dom.window, 'modelTuningEngine', 'llama-server'));
  // A stuck `pending` would keep the button on "Applying…" and refuse the write.
  assert.equal(host.querySelector('[data-action="save-model-tuning"]').textContent, 'Apply 1 change');
  host.querySelector('[data-action="save-model-tuning"]').click();
  await flush();
  await flush();
  assert.equal(harness.calls.filter((call) => call[0] === 'engine').length, 2);
  harness.controller.dispose();
});

test('an unreflected engine write reports the failure and never applies the tuning half', async () => {
  const harness = createHarness({
    ggufs: [gguf],
    settings: emptySettings({ accelerationCatalog: eligibleCatalog }),
    // A flag-off backend ignores `managed` and echoes the untouched settings.
    engineUpdates: async () => ({ ok: true, localEngines: { openaiCompatible: { managed: { enabled: false, perModel: {} } } } }),
  });
  await harness.controller.open('gemma3:latest');
  const host = harness.dom.window.document.getElementById('modelTuningDrawer');
  const temperature = host.querySelector('#modelTuningTemperature');
  temperature.value = '0.4';
  temperature.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
  host.querySelector('[data-inv-segmented="modelTuningEngine"]')
    .dispatchEvent(engineEvent(harness.dom.window, 'modelTuningEngine', 'llama-server'));
  host.querySelector('[data-action="save-model-tuning"]').click();
  await flush();
  await flush();
  assert.deepEqual(harness.calls.map((call) => call[0]), ['engine']);
  assert.match(host.textContent, /Could not update the engine settings\./);
  // The engine draft survives the failure so the user can retry (the tuning
  // inputs re-render from the stored profile, as they do after any failed apply).
  assert.equal(host.querySelector('[data-value="llama-server"]').getAttribute('aria-checked'), 'true');
  assert.equal(host.querySelector('[data-action="save-model-tuning"]').textContent, 'Apply 1 change');
  assert.equal(host.querySelector('[data-action="save-model-tuning"]').disabled, false);
  harness.controller.dispose();
});

test('the reflect check holds against the real settings normalizer and rejects a tagless echo', () => {
  const view = engineUtils.deriveEngineView({
    activeModelId: 'gemma3:latest', engineType: 'ollama', shellState: {},
    engineSettings: emptySettings({ accelerationCatalog: eligibleCatalog }),
    localGgufs: { entries: [gguf] }, serverStatus: null,
  });
  const request = engineUtils.buildManagedPatch('gemma3:latest', view, { engine: 'llama-server', mtp: true, modelPath: '' });
  const normalized = normalizeLocalEngines({ openaiCompatible: { managed: request.payload.managed } });
  assert.equal(normalized.openaiCompatible.managed.perModel[view.key].modelPath, 'G:\\models\\gemma3-latest\\gemma3.gguf');
  assert.equal(engineUtils.returnedEntryMatches(normalized, view.key, request.entry), true);

  const tagless = { ...request.entry, tag: '' };
  const normalizedTagless = normalizeLocalEngines({ openaiCompatible: { managed: { enabled: true, perModel: { [view.key]: tagless } } } });
  assert.equal(engineUtils.returnedEntryMatches(normalizedTagless, view.key, request.entry), false);
});

test('saving carries the persisted draftNMax instead of resetting it', async () => {
  const modelPath = 'G:\\models\\gemma3-latest\\gemma3.gguf';
  const settings = emptySettings({
    localEngines: { openaiCompatible: { managed: { enabled: true, perModel: {
      'gemma3-latest': { engine: 'llama-server', tag: 'gemma3:latest', modelPath, mtp: { mode: 'off', draftNMax: 6 } },
    } } } },
    accelerationCatalog: eligibleCatalog,
  });
  const harness = createHarness({ settings, ggufs: [gguf] });
  await harness.controller.open('gemma3:latest');
  const host = harness.dom.window.document.getElementById('modelTuningDrawer');
  host.querySelector('[data-inv-toggle="modelTuningMtp"]')
    .dispatchEvent(toggleEvent(harness.dom.window, 'modelTuningMtp', true));
  host.querySelector('[data-action="save-model-tuning"]').click();
  await flush();
  assert.deepEqual(harness.calls[0][1].managed.perModel['gemma3-latest'].mtp, { mode: 'mtp', draftNMax: 6 });
  harness.controller.dispose();
});

test('the card engine facts seed Ollama availability and a served model opens clean', async () => {
  // Served by llama-server with no persisted entry: the draft seeds llama-server
  // and the drawer must not invent a pending change.
  const served = createHarness({ engineType: 'openai-compatible' });
  await served.controller.open('gemma3:latest', null, { engines: { ollama: { available: true } } });
  let host = served.dom.window.document.getElementById('modelTuningDrawer');
  assert.equal(host.querySelector('[data-value="llama-server"]').getAttribute('aria-checked'), 'true');
  assert.equal(host.querySelector('[data-value="llama-server"]').disabled, false);
  assert.equal(host.querySelector('[data-value="ollama"]').disabled, false);
  assert.equal(host.querySelector('[data-action="save-model-tuning"]').textContent, 'Apply 0 changes');
  served.controller.dispose();

  const noOllama = createHarness();
  await noOllama.controller.open('gemma3:latest', null, { engines: { ollama: { available: false } } });
  host = noOllama.dom.window.document.getElementById('modelTuningDrawer');
  assert.equal(host.querySelector('[data-value="ollama"]').disabled, true);
  noOllama.controller.dispose();
});

test('a persisted path outside the scanned directory owns the drafter verdict', async () => {
  const persisted = 'D:\\elsewhere\\gemma3.gguf';
  const settings = emptySettings({
    localEngines: { openaiCompatible: { managed: { enabled: true, perModel: {
      'gemma3-latest': { engine: 'llama-server', tag: 'gemma3:latest', modelPath: persisted, mtp: { mode: 'off' } },
    } } } },
    accelerationCatalog: eligibleCatalog,
  });
  // The tag scan finds a drafter in the default directory, but the model runs
  // from D:\elsewhere where no drafter is known.
  const harness = createHarness({ settings, ggufs: [gguf] });
  await harness.controller.open('gemma3:latest');
  const host = harness.dom.window.document.getElementById('modelTuningDrawer');
  assert.equal(host.querySelector('[data-model-tuning-gguf]').title, persisted);
  const view = engineUtils.deriveEngineView({
    activeModelId: 'gemma3:latest', engineType: 'ollama', shellState: {},
    engineSettings: settings, localGgufs: { entries: [gguf] }, serverStatus: null,
  });
  assert.equal(view.ggufEntry.source, '');
  assert.equal(host.querySelector('[data-model-tuning-row="mtp"] .model-tuning-row-range').textContent,
    'Drafter file missing \u00b7 falls back to plain decoding');
  harness.controller.dispose();
});

test('a rejected picker file is reported as not a GGUF and leaves the draft alone', async () => {
  const harness = createHarness({ chooseGguf: async () => ({ ok: false, reason: 'not_gguf' }) });
  await harness.controller.open('gemma3:latest');
  let host = harness.dom.window.document.getElementById('modelTuningDrawer');
  host.querySelector('[data-action="choose-model-gguf"]').click();
  await flush();
  host = harness.dom.window.document.getElementById('modelTuningDrawer');
  assert.match(host.textContent, /That file is not a GGUF model\./);
  assert.equal(host.querySelector('[data-model-tuning-gguf]').textContent, 'Not found for this tag');
  assert.equal(host.querySelector('[data-action="save-model-tuning"]').textContent, 'Apply 0 changes');
  harness.controller.dispose();
});

test('the Engine section never paints its unavailable fallback while the reads are in flight', async () => {
  const harness = createHarness();
  const opening = harness.controller.open('gemma3:latest');
  const firstPaint = harness.dom.window.document.getElementById('modelTuningDrawer').innerHTML;
  assert.doesNotMatch(firstPaint, /Engine controls are unavailable/);
  await opening;
  assert.ok(harness.dom.window.document.querySelector('[data-model-tuning-engine]'));
  harness.controller.dispose();
});
