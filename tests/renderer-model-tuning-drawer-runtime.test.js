'use strict';

// Tune drawer > Engine > "llama-server build" (W4c) and the Local GGUF engine
// hint (W4b). The real drawer and engine utils run in JSDOM over the real main
// write path (runtime reconcile + ShellConfigService + normalizer), so every
// Apply payload is checked against what main actually saves.

const fs = require('fs');
const os = require('os');
const path = require('path');
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
const { ShellConfigService } = require('../services/shell-config-service');
const { createRuntimePickRegistry, writeManagedPatch } = require('../services/main/llama-server-runtime');

const WIN32 = process.platform === 'win32';
const RUNTIMES = WIN32 ? 'G:\\llmmodels\\runtimes' : '/opt/llmmodels/runtimes';
const SEP = WIN32 ? '\\' : '/';
const FORK_DIR = RUNTIMES + SEP + 'llama-prism-b10683-cuda13.3';
const FORK = FORK_DIR + SEP + (WIN32 ? 'llama-server.exe' : 'llama-server');
const OTHER = RUNTIMES + SEP + 'llama-b10760' + SEP + (WIN32 ? 'llama-server.exe' : 'llama-server');
const GGUF_DIR = WIN32 ? 'G:\\llmmodels\\gguf\\ternary-bonsai-2-27b' : '/models/ternary-bonsai-2-27b';
const MODEL_PATH = GGUF_DIR + SEP + 'Ternary-Bonsai-2-27B-PQ2_0.gguf';
const TAG = 'ternary-bonsai-2-27b-pq2_0';
const KEY = 'ternary-bonsai-2-27b-pq2-0';
const FORK_VALUE = 'llama-prism-b10683-cuda13.3 \u00b7 build 10683';
const FORK_PICK = Object.freeze({ ok: true, picked: true, path: FORK, build: 10683, supportsMtp: false });
const BONSAI = Object.freeze({ engine: 'llama-server', tag: TAG, modelPath: MODEL_PATH, mtp: { mode: 'off' } });
const NO_OLLAMA_HINT = "Ollama doesn't have this model, so it runs on Jenny's own llama-server.";
const ENGINE_HINT = "Ollama or Jenny's own llama-server. llama-server can speed up verified models with multi-token prediction.";

function tuningState() {
  return {
    contextLengthSteps: [4096, 8192],
    contextLengthByModel: { [TAG]: 4096 },
    ratioByModel: { [TAG]: 0.8 },
    generationProfilesByModel: { [TAG]: { temperature: 0.6 } },
  };
}

// The main side of engines.updateSettings, minus IPC: the pick registry gates
// runtime paths and ShellConfigService merges, normalizes and persists.
function createSettingsStore(t, entry = BONSAI) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-drawer-runtime-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const service = new ShellConfigService({ userDataPath, env: {} });
  service.updateManagedLlamaServer({ enabled: true, perModel: { [KEY]: entry } });
  const picks = createRuntimePickRegistry();
  return {
    picks,
    localEngines: () => service.getLocalEngines(),
    saved: () => service.getLocalEngines().openaiCompatible.managed.perModel[KEY],
    write(payload) {
      writeManagedPatch({ shellConfigService: service, patch: payload.managed, picks });
      return service.getLocalEngines();
    },
  };
}

// options: entry, picks (values or functions), gguf (a value, or a function per
// call), bridge (false drops chooseRuntime), modelList.
function createHarness(t, options = {}) {
  const store = createSettingsStore(t, options.entry || BONSAI);
  const picks = (options.picks || []).slice();
  const calls = { engine: [], pickers: [] };
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  const llamaServer = {
    async listLocalGgufs() { return { ok: true, entries: [] }; },
    async getStatus() { return { ok: true, state: 'stopped', alias: '', port: 0 }; },
    async chooseGguf() {
      return (typeof options.gguf === 'function' ? await options.gguf() : options.gguf) || { ok: true, path: '' };
    },
  };
  if (options.bridge !== false) {
    llamaServer.chooseRuntime = async (request) => {
      calls.pickers.push(request);
      const next = picks.shift();
      const result = typeof next === 'function' ? await next() : next;
      if (result?.picked) store.picks.record(result.path, { build: result.build, supportsMtp: result.supportsMtp });
      return result || { ok: true, picked: false, path: '' };
    };
  }
  dom.window.jennyShell = {
    modelTuning: {
      async getState() { return tuningState(); },
      async update() { return { status: 'applied', state: tuningState() }; },
    },
    engines: {
      async getSettings() {
        return { localEngines: store.localEngines(), accelerationCatalog: { defaults: { vramHeadroomMb: 2048 }, families: [] } };
      },
      async updateSettings(payload) {
        calls.engine.push(JSON.parse(JSON.stringify(payload)));
        return { localEngines: store.write(payload), preferredEngineType: '' };
      },
    },
    llamaServer,
  };
  const state = { features: { featureFlags: { llama_server_acceleration: true } }, modelList: { data: options.modelList || [] } };
  const controller = createModelTuningDrawerController({
    state, windowRef: dom.window, documentRef: dom.window.document, drawerFactory,
    inventory: { selectField, textField, actionButton, segmentedControl, toggleSwitch },
  });
  t.after(() => controller.dispose());
  return { dom, state, controller, calls, store };
}

// Tune from a Local GGUF card: the section passes the engine hint and the
// card's engine facts (Ollama has no copy of the file).
async function openBonsai(h, extra = {}) {
  await h.controller.open(TAG, null, {
    engineTypeHint: 'openai-compatible', engines: { ollama: { available: false } }, ...extra,
  });
  return h.dom.window.document.getElementById('modelTuningDrawer');
}

function button(host, action) {
  const found = host.querySelector(`[data-action="${action}"]`);
  assert.ok(found, `${action} is rendered`);
  return found;
}

const runtimeCode = (host) => host.querySelector('[data-model-tuning-runtime]');
const statusText = (host) => host.querySelector('.model-tuning-drawer-status').textContent;
const applyLabel = (host) => host.querySelector('[data-action="save-model-tuning"]').textContent;

function setField(host, selector, value) {
  const field = host.querySelector(selector);
  field.value = value;
  field.dispatchEvent(new field.ownerDocument.defaultView.Event('input', { bubbles: true }));
  return field;
}

async function flush() {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function apply(host) {
  button(host, 'save-model-tuning').click();
  for (let attempt = 0; attempt < 100 && /Applying|Restarting/.test(statusText(host)); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await flush();
}

test('Tune on an unserved Local GGUF card resolves its engine from the hint and can apply', async (t) => {
  const h = createHarness(t);
  const host = await openBonsai(h);
  assert.doesNotMatch(host.textContent, /can't verify this model's engine/);
  assert.ok(host.querySelector('[data-model-tuning-engine]'), 'the Engine section renders');
  assert.match(host.querySelector('.model-tuning-drawer-subtitle').textContent, /\u00b7 llama-server /);
  assert.equal(host.querySelector('[data-value="llama-server"]').getAttribute('aria-checked'), 'true');
  assert.equal(host.querySelector('[data-value="ollama"]').disabled, true);
  const temperature = setField(host, '#modelTuningTemperature', '0.4');
  assert.equal(temperature.disabled, false);
  assert.equal(applyLabel(host), 'Apply 1 change');
  assert.equal(button(host, 'save-model-tuning').disabled, false);
  await apply(host);
  assert.equal(statusText(host), 'Applied. The runtime acknowledged this model profile.');
});

test('the engine hint is reset on every open and ranks after the model list and the served status', async (t) => {
  const h = createHarness(t);
  await openBonsai(h);
  await h.controller.open(TAG);
  let host = h.dom.window.document.getElementById('modelTuningDrawer');
  assert.match(host.textContent, /can't verify this model's engine yet/, 'a hint does not outlive its open()');
  assert.equal(host.querySelector('[data-model-tuning-engine]'), null);

  h.state.status = { model: TAG, engine: 'vllm' };
  host = await openBonsai(h);
  assert.match(host.querySelector('.model-tuning-drawer-subtitle').textContent, /\u00b7 vLLM /, 'the served status wins');
  h.state.status = { model: TAG };
  host = await openBonsai(h);
  assert.match(host.querySelector('.model-tuning-drawer-subtitle').textContent, /\u00b7 llama-server /,
    'a served status without an engine falls through to the hint');
  h.state.modelList.data.push({ id: TAG, engine_type: 'ollama' });
  host = await openBonsai(h);
  assert.match(host.querySelector('.model-tuning-drawer-subtitle').textContent, /\u00b7 Ollama /, 'the model list wins');
});

test('the Engine hint says why Ollama is greyed out only when Ollama lacks the model', async (t) => {
  const { document } = new JSDOM('<!doctype html><body></body>').window;
  const hintFor = (ollamaAvailable) => {
    const view = engineUtils.deriveEngineView({
      activeModelId: TAG, engineType: 'openai-compatible', engineHints: { ollama: { available: ollamaAvailable } },
      engineSettings: { localEngines: { openaiCompatible: { managed: { perModel: { [KEY]: BONSAI } } } } },
    });
    document.body.innerHTML = engineUtils.buildEngineSectionHtml({
      view, draft: view.draft, pending: false, statusText: '', escapeHtml: actionButton.escapeHtml,
      segmentedControl, toggleSwitch: toggleSwitch.toggleSwitch, actionButton,
    });
    return document.querySelector('.model-tuning-section-hint').textContent;
  };
  assert.equal(hintFor(false), NO_OLLAMA_HINT);
  assert.equal(hintFor(true), ENGINE_HINT);

  const h = createHarness(t);
  assert.equal((await openBonsai(h)).querySelector('.model-tuning-section-hint').textContent, NO_OLLAMA_HINT);
  const withOllama = await openBonsai(h, { engines: { ollama: { available: true } } });
  assert.equal(withOllama.querySelector('.model-tuning-section-hint').textContent, ENGINE_HINT);

  // No card facts (Quick Settings, the older model list): the model-list scan
  // can't prove Ollama lacks the model (a served llama-server alias hides
  // Ollama's copy of the same tag), so the plain hint stays.
  const listed = [{ id: TAG, engine_type: 'openai-compatible' }];
  const scanned = engineUtils.deriveEngineView({
    activeModelId: TAG, engineType: 'openai-compatible', shellState: { modelList: { data: listed } },
    engineSettings: { localEngines: { openaiCompatible: { managed: { perModel: { [KEY]: BONSAI } } } } },
  });
  document.body.innerHTML = engineUtils.buildEngineSectionHtml({
    view: scanned, draft: scanned.draft, pending: false, statusText: '', escapeHtml: actionButton.escapeHtml,
    segmentedControl, toggleSwitch: toggleSwitch.toggleSwitch, actionButton,
  });
  assert.equal(document.querySelector('.model-tuning-section-hint').textContent, ENGINE_HINT);
  const quick = createHarness(t, { modelList: listed });
  await quick.controller.open(TAG, null);
  const quickHost = quick.dom.window.document.getElementById('modelTuningDrawer');
  assert.equal(quickHost.querySelector('.model-tuning-section-hint').textContent, ENGINE_HINT);
  assert.equal(quickHost.querySelector('[data-value="ollama"]').disabled, true,
    'the Ollama option keeps its verdict from before this slice (the scan found no Ollama entry)');
});

test('the build row follows the GGUF-row grammar under GGUF file, escaped, and only with the bridge', () => {
  const { document } = new JSDOM('<!doctype html><body></body>').window;
  const odd = RUNTIMES + SEP + 'a"<b>&c' + SEP + (WIN32 ? 'llama-server.exe' : 'llama-server');
  const render = (draft, extra = {}) => {
    const view = { effectiveModelPath: MODEL_PATH, ggufEntry: null, eligible: false, familyMtp: '', ollamaAvailable: false };
    document.body.innerHTML = engineUtils.buildEngineSectionHtml({
      view, draft: { engine: 'llama-server', mtp: false, modelPath: MODEL_PATH, runtimePath: '', runtimeBuild: 0, ...draft },
      pending: false, statusText: '', escapeHtml: actionButton.escapeHtml, runtimeRowAvailable: true,
      segmentedControl, toggleSwitch: toggleSwitch.toggleSwitch, actionButton, ...extra,
    });
    return document.querySelector('[data-model-tuning-row="runtimePath"]');
  };

  const row = render({ runtimePath: FORK, runtimeBuild: 10683 });
  assert.ok(row, 'the row renders with the bridge');
  assert.equal(row.previousElementSibling.dataset.modelTuningRow, 'modelPath', 'placed right after GGUF file');
  assert.equal(row.className, 'model-tuning-row model-tuning-row--gguf');
  assert.equal(row.hidden, false);
  assert.deepEqual(Array.from(row.children, (child) => child.className),
    ['model-tuning-row-label', 'model-tuning-row-control', 'model-tuning-row-actions']);
  assert.equal(row.querySelector('.model-tuning-row-label').textContent, 'llama-server build');
  const code = row.querySelector('.model-tuning-row-control > code.model-tuning-gguf-path[data-model-tuning-runtime]');
  assert.equal(code.textContent, FORK_VALUE);
  assert.equal(code.title, FORK);
  const buttons = Array.from(row.querySelectorAll('.model-tuning-row-actions > button'));
  assert.deepEqual(buttons.map((node) => [node.dataset.action, node.textContent, node.className, node.hidden]), [
    ['choose-llama-server-runtime', 'Choose…', 'btn btn--ghost btn--sm', false],
    ['use-bundled-llama-server', 'Use bundled', 'btn btn--ghost btn--sm', false],
  ]);
  // Two visible "Choose…" controls in one section: each carries its own accessible name.
  const named = (action) => {
    const node = document.querySelector(`[data-action="${action}"]`);
    return [node.textContent, node.getAttribute('aria-label')];
  };
  assert.deepEqual(named('choose-llama-server-runtime'), ['Choose…', 'Choose a llama-server build']);
  assert.deepEqual(named('choose-model-gguf'), ['Choose…', 'Choose a GGUF file']);
  const names = Array.from(document.querySelectorAll('[data-model-tuning-engine] button[data-action]'),
    (node) => node.getAttribute('aria-label') || node.textContent.trim());
  assert.equal(new Set(names).size, names.length, names.join(' | '));

  const bundled = render({});
  assert.equal(bundled.querySelector('[data-model-tuning-runtime]').textContent, 'Bundled');
  assert.equal(bundled.querySelector('[data-model-tuning-runtime]').title, '');
  assert.equal(bundled.querySelector('[data-action="use-bundled-llama-server"]').hidden, true,
    'Use bundled is rendered but hidden while unused');
  assert.equal(render({ engine: 'ollama' }).hidden, true, 'hidden off llama-server');
  assert.ok(render({}, { pending: true }).querySelectorAll('button:disabled').length === 2);

  const escaped = render({ runtimePath: odd, runtimeBuild: 7 });
  assert.equal(escaped.querySelector('[data-model-tuning-runtime]').title, odd);
  assert.equal(escaped.querySelector('[data-model-tuning-runtime]').textContent, 'a"<b>&c \u00b7 build 7');
  assert.equal(escaped.querySelector('b'), null, 'the folder name is text, never markup');

  assert.equal(render({}, { runtimeRowAvailable: false }), null, 'no bridge, no row');
  assert.equal(engineUtils.buildRuntimeRowHtml({ runtimeRowAvailable: false, draft: {}, actionButton }), '');
});

test('engine utils carry the build through the draft, dirty set, pick, value text and picker failures', () => {
  const settings = (entry) => ({ localEngines: { openaiCompatible: { managed: { perModel: { [KEY]: entry } } } } });
  const custom = engineUtils.deriveEngineView({
    activeModelId: TAG, engineType: 'openai-compatible',
    engineSettings: settings({ ...BONSAI, runtimePath: FORK, runtimeBuild: 10683 }),
  });
  assert.equal(custom.draft.runtimePath, FORK);
  assert.equal(custom.baseline.runtimePath, FORK);
  assert.equal(custom.draft.runtimeBuild, 10683);
  assert.equal(custom.runtimeBuild, 10683);
  assert.equal(custom.baseline.runtimeBuild, 10683);
  // The saved file picked again: a new build (new files copied over it) is a change; the same build is not.
  const repicked = { ...custom.draft };
  assert.equal(engineUtils.applyPickedRuntime(custom, repicked, FORK_PICK), true);
  assert.deepEqual(engineUtils.engineDirtyFields(custom, repicked), []);
  assert.equal(engineUtils.applyPickedRuntime(custom, repicked, { ...FORK_PICK, build: 10700 }), true);
  assert.deepEqual(engineUtils.engineDirtyFields(custom, repicked), ['runtimePath']);
  assert.deepEqual(engineUtils.engineDirtyFields(custom, { ...repicked, engine: 'ollama' }), ['engine']);
  const view = engineUtils.deriveEngineView({ activeModelId: TAG, engineType: 'openai-compatible', engineSettings: settings(BONSAI) });
  assert.deepEqual([view.draft.runtimePath, view.baseline.runtimePath, view.draft.runtimeBuild, view.runtimeBuild], ['', '', 0, 0]);
  const unsaved = engineUtils.deriveEngineView({ activeModelId: 'other:model', engineType: 'openai-compatible' });
  assert.deepEqual([unsaved.draft.runtimePath, unsaved.baseline.runtimePath, unsaved.draft.runtimeBuild], ['', '', 0]);

  const draft = { ...view.draft };
  assert.equal(engineUtils.applyPickedRuntime(view, draft, { ok: true, picked: false, path: '' }), false);
  assert.equal(engineUtils.applyPickedRuntime(view, draft, { ok: false, reason: 'runtime_missing' }), false);
  assert.equal(draft.runtimePath, '');
  assert.equal(engineUtils.applyPickedRuntime(view, draft, FORK_PICK), true);
  assert.deepEqual([draft.runtimePath, draft.runtimeBuild], [FORK, 10683]);
  assert.equal(view.baseline.runtimePath, '', 'a pick is a draft: the baseline stays');
  assert.deepEqual(engineUtils.engineDirtyFields(view, draft), ['runtimePath']);
  assert.deepEqual(engineUtils.engineDirtyFields(view, { ...draft, engine: 'ollama' }), ['engine'],
    'the build is not a change while the model runs on Ollama');

  assert.equal(engineUtils.runtimeValueText({ runtimePath: '', runtimeBuild: 0 }), 'Bundled');
  assert.equal(engineUtils.runtimeValueText({ runtimePath: FORK, runtimeBuild: 10683 }), FORK_VALUE);
  assert.equal(engineUtils.runtimeValueText({ runtimePath: FORK, runtimeBuild: 0 }), 'llama-prism-b10683-cuda13.3');

  const failure = (reason) => engineUtils.runtimePickerFailureText({ ok: false, reason });
  assert.equal(failure('not_llama_server'), 'That file is not a llama-server program.');
  assert.equal(failure('runtime_probe_failed'), "That llama-server didn't report a build number, so Jenny can't use it.");
  assert.equal(failure('runtime_missing'), 'That file is no longer there.');
  for (const reason of ['manager_unavailable', 'not_gguf', '', undefined]) {
    assert.equal(failure(reason), 'Could not open the file picker.', String(reason));
  }
});

test('buildManagedPatch sends the build only when it changed, and each payload reflects through main', (t) => {
  const store = createSettingsStore(t, { ...BONSAI, runtimePath: FORK, runtimeBuild: 10683 });
  const view = engineUtils.deriveEngineView({
    activeModelId: TAG, engineType: 'openai-compatible', engineSettings: { localEngines: store.localEngines() },
  });
  const untouched = engineUtils.buildManagedPatch(TAG, view, { ...view.draft });
  assert.deepEqual(untouched.entry, { engine: 'llama-server', tag: TAG, modelPath: MODEL_PATH, mtp: { mode: 'off', draftNMax: 4 } });
  let returned = store.write(untouched.payload);
  assert.equal(engineUtils.returnedEntryMatches(returned, KEY, untouched.entry, untouched.runtimeBuild), true);
  assert.deepEqual([store.saved().runtimePath, store.saved().runtimeBuild], [FORK, 10683], 'main keeps the saved build');
  assert.equal('runtimePath' in engineUtils.buildManagedPatch(TAG, view, { ...view.draft, runtimeBuild: 10683 }).entry, false,
    'the saved file picked again with its saved build is no change');

  // The saved file picked again with a new build: sent, and main takes the pick's
  // number only for a fresh pick. The reflect check sees an echo it kept.
  const upgraded = engineUtils.buildManagedPatch(TAG, view, { ...view.draft, runtimeBuild: 10700 });
  assert.equal(upgraded.entry.runtimePath, FORK);
  assert.equal(upgraded.runtimeBuild, 10700);
  assert.equal(JSON.stringify(upgraded.payload).includes('runtimeBuild'), false, 'the renderer never sends a build number');
  returned = store.write(upgraded.payload);
  assert.equal(store.saved().runtimeBuild, 10683, 'no fresh pick: main keeps the saved build');
  assert.equal(engineUtils.returnedEntryMatches(returned, KEY, upgraded.entry, upgraded.runtimeBuild), false);
  store.picks.record(FORK, { build: 10700 });
  returned = store.write(upgraded.payload);
  assert.deepEqual([store.saved().runtimePath, store.saved().runtimeBuild], [FORK, 10700]);
  assert.equal(engineUtils.returnedEntryMatches(returned, KEY, upgraded.entry, upgraded.runtimeBuild), true);

  store.picks.record(OTHER, { build: 10760 });
  const picked = engineUtils.buildManagedPatch(TAG, view, { ...view.draft, runtimePath: OTHER, runtimeBuild: 10760 });
  assert.equal(picked.entry.runtimePath, OTHER);
  assert.equal('runtimeBuild' in picked.entry, false, 'main records the build itself');
  returned = store.write(picked.payload);
  assert.equal(engineUtils.returnedEntryMatches(returned, KEY, picked.entry, picked.runtimeBuild), true);
  assert.deepEqual([store.saved().runtimePath, store.saved().runtimeBuild], [OTHER, 10760]);

  // An unpicked (or already consumed) path is refused by main; the reflect check sees it.
  const replay = engineUtils.buildManagedPatch(TAG, view, { ...view.draft, runtimePath: FORK + 'x' });
  returned = store.write(replay.payload);
  assert.equal(engineUtils.returnedEntryMatches(returned, KEY, replay.entry), false);

  const cleared = engineUtils.buildManagedPatch(TAG, view, { ...view.draft, runtimePath: '', runtimeBuild: 0 });
  assert.equal(cleared.entry.runtimePath, '');
  returned = store.write(cleared.payload);
  assert.equal(engineUtils.returnedEntryMatches(returned, KEY, cleared.entry), true);
  assert.equal('runtimePath' in store.saved(), false);
  assert.equal(engineUtils.returnedEntryMatches(returned, KEY, { ...cleared.entry, runtimePath: FORK }), false);

  const onOllama = engineUtils.buildManagedPatch(TAG, view, { ...view.draft, engine: 'ollama', runtimePath: '' });
  assert.equal('runtimePath' in onOllama.entry, false, 'never sent while it is not a counted change');
});

test('a missing bridge hides the row, and the row follows the engine choice', async (t) => {
  const bare = createHarness(t, { bridge: false });
  const bareHost = await openBonsai(bare);
  assert.ok(bareHost.querySelector('[data-model-tuning-engine]'));
  assert.equal(bareHost.querySelector('[data-model-tuning-row="runtimePath"]'), null);
  assert.equal(bareHost.querySelector('[data-action="choose-llama-server-runtime"]'), null);

  const h = createHarness(t, { picks: [FORK_PICK] });
  const host = await openBonsai(h, { engines: { ollama: { available: true } } });
  const row = host.querySelector('[data-model-tuning-row="runtimePath"]');
  assert.ok(row, 'the row renders with the bridge');
  assert.equal(row.hidden, false);
  button(host, 'choose-llama-server-runtime').click();
  await flush();
  const group = host.querySelector('[data-inv-segmented="modelTuningEngine"]');
  segmentedControl.select(group, 'ollama');
  assert.equal(row.hidden, true);
  assert.equal(applyLabel(host), 'Apply 1 change', 'off llama-server the pick is not counted');
  segmentedControl.select(group, 'llama-server');
  assert.equal(row.hidden, false);
  assert.equal(runtimeCode(host).textContent, FORK_VALUE, 'the pick survives the round trip');
  assert.equal(applyLabel(host), 'Apply 1 change');
});

test('Choose then Apply saves the pick; Use bundled then Apply clears it', async (t) => {
  const h = createHarness(t, { picks: [FORK_PICK] });
  const host = await openBonsai(h);
  assert.equal(runtimeCode(host)?.textContent, 'Bundled');
  assert.equal(button(host, 'use-bundled-llama-server').hidden, true);
  button(host, 'choose-llama-server-runtime').click();
  await flush();
  assert.deepEqual(h.calls.pickers, [{ defaultPath: '' }]);
  assert.equal(runtimeCode(host).textContent, FORK_VALUE);
  assert.equal(runtimeCode(host).title, FORK);
  assert.equal(button(host, 'use-bundled-llama-server').hidden, false);
  assert.equal(applyLabel(host), 'Apply 1 change');
  assert.equal(h.calls.engine.length, 0, 'a pick never persists before Apply');

  await apply(host);
  assert.equal(h.calls.engine[0].managed.perModel[KEY].runtimePath, FORK);
  assert.deepEqual([h.store.saved().runtimePath, h.store.saved().runtimeBuild], [FORK, 10683]);
  assert.equal(statusText(host), 'Applied. Press Use on this model to run it with these settings.');
  assert.equal(runtimeCode(host).textContent, FORK_VALUE, 're-derived from what main saved');
  assert.equal(applyLabel(host), 'Apply 0 changes');

  button(host, 'choose-llama-server-runtime').click();
  await flush();
  assert.deepEqual(h.calls.pickers[1], { defaultPath: FORK_DIR }, 'the picker opens in the build\'s folder');

  const useBundled = button(host, 'use-bundled-llama-server');
  useBundled.focus();
  useBundled.click();
  assert.equal(runtimeCode(host).textContent, 'Bundled');
  assert.equal(runtimeCode(host).title, '');
  assert.equal(useBundled.hidden, true);
  assert.equal(h.dom.window.document.activeElement, button(host, 'choose-llama-server-runtime'),
    'focus moves to Choose… instead of falling to the page');
  assert.equal(applyLabel(host), 'Apply 1 change');
  await apply(host);
  assert.equal(h.calls.engine[1].managed.perModel[KEY].runtimePath, '');
  assert.equal('runtimePath' in h.store.saved(), false);
  assert.equal(runtimeCode(host).textContent, 'Bundled');
});

test('an untouched Apply sends no runtimePath key and keeps the saved build', async (t) => {
  const repick = GGUF_DIR + SEP + 'Ternary-Bonsai-2-27B-Q4_K_M.gguf';
  const h = createHarness(t, {
    entry: { ...BONSAI, runtimePath: FORK, runtimeBuild: 10683 },
    gguf: { ok: true, path: repick, dir: GGUF_DIR, drafterGguf: '' },
  });
  const host = await openBonsai(h);
  assert.equal(runtimeCode(host)?.textContent, FORK_VALUE, 'the saved build shows');
  assert.equal(button(host, 'use-bundled-llama-server').hidden, false);
  button(host, 'choose-model-gguf').click();
  await flush();
  assert.equal(applyLabel(host), 'Apply 1 change');
  await apply(host);
  assert.deepEqual(h.calls.engine, [{ managed: {
    enabled: true,
    lastPickDir: GGUF_DIR,
    perModel: { [KEY]: { engine: 'llama-server', tag: TAG, modelPath: repick, mtp: { mode: 'off', draftNMax: 4 } } },
  } }]);
  assert.deepEqual([h.store.saved().modelPath, h.store.saved().runtimePath, h.store.saved().runtimeBuild], [repick, FORK, 10683]);
  assert.equal(runtimeCode(host).textContent, FORK_VALUE);
});

test('a stale pick is dropped when the model switches or the drawer closes mid-dialog', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = createHarness(t, { picks: [() => gate] });
  let host = await openBonsai(h);
  button(host, 'choose-llama-server-runtime').click();
  await flush();
  await h.controller.open('other-model:7b', null, { engineTypeHint: 'openai-compatible' });
  host = h.dom.window.document.getElementById('modelTuningDrawer');
  release(FORK_PICK);
  await flush();
  assert.equal(runtimeCode(host).textContent, 'Bundled', 'the other model never sees the pick');
  assert.equal(applyLabel(host), 'Apply 0 changes');

  let releaseClosed;
  const closedGate = new Promise((resolve) => { releaseClosed = resolve; });
  const closed = createHarness(t, { picks: [() => closedGate] });
  button(await openBonsai(closed), 'choose-llama-server-runtime').click();
  await flush();
  closed.controller.close();
  releaseClosed(FORK_PICK);
  await flush();
  const reopened = await openBonsai(closed);
  assert.equal(runtimeCode(reopened).textContent, 'Bundled');
  assert.equal(applyLabel(reopened), 'Apply 0 changes');
});

test('a pick patches the row in place, so unapplied tuning inputs survive', async (t) => {
  const h = createHarness(t, { picks: [FORK_PICK] });
  const host = await openBonsai(h);
  const temperature = setField(host, '#modelTuningTemperature', '0.4');
  const context = setField(host, '#modelTuningContextLength', '8192');
  button(host, 'choose-llama-server-runtime').click();
  await flush();
  assert.equal(host.querySelector('#modelTuningTemperature'), temperature, 'no re-render');
  assert.deepEqual([temperature.value, context.value], ['0.4', '8192']);
  assert.equal(runtimeCode(host).textContent, FORK_VALUE);
  assert.equal(applyLabel(host), 'Apply 3 changes');
  button(host, 'use-bundled-llama-server').click();
  assert.equal(host.querySelector('#modelTuningTemperature'), temperature);
  assert.equal(applyLabel(host), 'Apply 2 changes');
});

// Both pickers report a failure on the status line in place: a re-render would
// rebuild the inputs and drop unapplied edits.
test('picker failures show their copy in place and leave the draft and unapplied inputs alone; cancel is silent', async (t) => {
  const ggufResults = [
    { ok: false, reason: 'not_gguf' },
    { ok: false, reason: 'manager_unavailable' },
    () => { throw new Error('ipc down'); },
  ];
  const h = createHarness(t, {
    picks: [
      { ok: true, picked: false, path: '' },
      { ok: false, reason: 'not_llama_server' },
      { ok: false, reason: 'runtime_probe_failed' },
      { ok: false, reason: 'runtime_missing' },
      { ok: false, reason: 'manager_unavailable' },
      () => { throw new Error('ipc down'); },
    ],
    gguf: () => { const next = ggufResults.shift(); return typeof next === 'function' ? next() : next; },
  });
  const host = await openBonsai(h);
  const temperature = setField(host, '#modelTuningTemperature', '0.4');
  const context = setField(host, '#modelTuningContextLength', '8192');
  const cases = [
    ['choose-llama-server-runtime', ''],
    ['choose-llama-server-runtime', 'That file is not a llama-server program.'],
    ['choose-llama-server-runtime', "That llama-server didn't report a build number, so Jenny can't use it."],
    ['choose-llama-server-runtime', 'That file is no longer there.'],
    ['choose-llama-server-runtime', 'Could not open the file picker.'],
    ['choose-llama-server-runtime', 'Could not open the file picker.'],
    ['choose-model-gguf', 'That file is not a GGUF model.'],
    ['choose-model-gguf', 'Could not open the file picker.'],
    ['choose-model-gguf', 'Could not open the file picker.'],
  ];
  for (const [action, text] of cases) {
    button(host, action).click();
    await flush();
    assert.equal(statusText(host), text, action);
    assert.equal(host.querySelector('#modelTuningTemperature'), temperature, `${action}: no re-render`);
    assert.deepEqual([temperature.value, context.value], ['0.4', '8192']);
    assert.equal(runtimeCode(host).textContent, 'Bundled');
    assert.equal(applyLabel(host), 'Apply 2 changes', `${action}: the dirty count survives`);
  }
});

test('re-picking the saved build after new files were copied over it saves the new build', async (t) => {
  const onFork = { ...BONSAI, runtimePath: FORK, runtimeBuild: 10683 };
  const upgraded = { ...FORK_PICK, build: 10700 };
  const h = createHarness(t, { entry: onFork, picks: [FORK_PICK, upgraded] });
  const host = await openBonsai(h);
  button(host, 'choose-llama-server-runtime').click();
  await flush();
  assert.equal(applyLabel(host), 'Apply 0 changes', 'the same file with the same build is no change');
  button(host, 'choose-llama-server-runtime').click();
  await flush();
  assert.equal(runtimeCode(host).textContent, 'llama-prism-b10683-cuda13.3 · build 10700');
  assert.equal(applyLabel(host), 'Apply 1 change');
  assert.equal(button(host, 'save-model-tuning').disabled, false);
  await apply(host);
  assert.equal(h.calls.engine[0].managed.perModel[KEY].runtimePath, FORK);
  assert.deepEqual([h.store.saved().runtimePath, h.store.saved().runtimeBuild], [FORK, 10700]);
  assert.equal(statusText(host), 'Applied. Press Use on this model to run it with these settings.');
  assert.equal(runtimeCode(host).textContent, 'llama-prism-b10683-cuda13.3 · build 10700', 're-derived from what main saved');
  assert.equal(applyLabel(host), 'Apply 0 changes');

  // A pick main no longer holds is an echo it keeps the old build for: the drawer says so.
  const stale = createHarness(t, { entry: onFork, picks: [upgraded] });
  const staleHost = await openBonsai(stale);
  button(staleHost, 'choose-llama-server-runtime').click();
  await flush();
  stale.store.picks.consume(FORK);
  await apply(staleHost);
  assert.equal(stale.store.saved().runtimeBuild, 10683);
  assert.equal(statusText(staleHost), 'Could not update the engine settings.');
  assert.equal(applyLabel(staleHost), 'Apply 1 change', 'the draft stays for a retry');
});
