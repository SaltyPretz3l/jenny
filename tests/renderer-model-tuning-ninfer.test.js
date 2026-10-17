'use strict';

// Row 54 N2 Step 11: the Tune drawer for an NInfer row shows the NInfer
// section (context window + multi-token prediction) instead of the
// llama-server Engine section (no GGUF, build or Run-with rows), names NInfer
// in the subtitle, saves through jennyShell.ninfer.updateSettings and reuses
// the restart flow with NInfer wording.

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
const { createNinferTuningSection, contextLabel } = require('../renderer/shell/renderer-model-tuning-ninfer');

const MODEL = 'qwen3.8-27b-nvfp4';
const HINT = { artifactId: MODEL, modelId: MODEL, contextWindows: [16384, 32768, 65536, 131072, 153600, 262144], fp8KvWindows: [153600, 262144], supportsMtp: true };

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function harness(options = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  const calls = [];
  const manager = { state: 'stopped', alias: '', port: 0, artifactId: '', mtp: false, ...(options.manager || {}) };
  const state = {
    features: { featureFlags: { llama_server_acceleration: true } },
    modelList: { data: [{ id: MODEL, engine_type: 'openai-compatible' }] },
  };
  let streaming = options.streaming || 0;
  dom.window.jennyShell = {
    modelTuning: {
      async getState() { return { contextLengthSteps: [4096, 8192], contextLengthByModel: {}, ratioByModel: {}, generationProfilesByModel: {} }; },
      async update(payload) { calls.push(['tuning', payload]); return { status: 'applied', state: {} }; },
    },
    engines: { async getSettings() { calls.push(['engines.getSettings']); return { localEngines: { openaiCompatible: { managed: { enabled: true, perModel: {} } } } }; } },
    llamaServer: { async listLocalGgufs() { calls.push(['llamaServer.listLocalGgufs']); return { ok: true, entries: [] }; }, async getStatus() { return { ok: true, state: 'stopped' }; } },
    ninfer: {
      async getState() { calls.push(['ninfer.getState']); return { eligible: true, manager, settings: { contextSize: 65536, mtp: true, watchdog: { enabled: false, maxWatts: 460, maxTempC: 83 }, ...(options.settings || {}) } }; },
      async updateSettings(payload) { calls.push(['ninfer.updateSettings', payload]); return options.saveFails ? { ok: false, reason: 'invalid_payload' } : { ok: true, settings: payload }; },
      async restart(spec) { calls.push(['ninfer.restart', spec]); return options.restartFails ? { ok: false, reason: 'ninfer_start_failed', status: { state: 'stopped' } } : { ok: true, status: { ...manager, state: 'ready', contextSize: spec.contextSize, mtp: spec.mtp, vision: spec.vision } }; },
    },
  };
  const confirms = [];
  const controller = createModelTuningDrawerController({
    state, windowRef: dom.window, documentRef: dom.window.document, drawerFactory,
    inventory: { selectField, textField, actionButton, segmentedControl, toggleSwitch },
    getStreamingSessionIds: () => Array.from({ length: streaming }, (_, i) => `s${i}`),
    confirmDialog: { async confirm(request) { confirms.push(request); return options.confirm !== false; } },
  });
  return {
    dom, calls, confirms, controller,
    doc: () => dom.window.document,
    text: () => dom.window.document.getElementById('modelTuningDrawer').textContent,
    setStreaming: (count) => { streaming = count; },
    open: () => controller.open(MODEL, null, { displayName: 'Qwen3.8 27B', engineTypeHint: 'openai-compatible', ninfer: HINT }),
  };
}

test('an NInfer row opens on the NInfer section: context + MTP + vision, NInfer named, no Engine rows, no generic context row', async () => {
  const h = harness();
  await h.open();
  await flush();
  const doc = h.doc();
  assert.ok(doc.querySelector('[data-model-tuning-ninfer]'), 'the NInfer section renders');
  assert.equal(doc.querySelector('[data-model-tuning-engine]'), null, 'no llama-server Engine section');
  assert.equal(doc.querySelector('[data-model-tuning-row="runtimePath"]'), null, 'no build row');
  assert.equal(doc.querySelector('#modelTuningContextLength'), null, 'no generic context row');
  assert.match(doc.querySelector('.model-tuning-drawer-subtitle').textContent, /qwen3\.8-27b-nvfp4 · NInfer · applies after the runtime confirms/);
  assert.match(h.text(), /Starts when you press Use/);
  const select = doc.getElementById('modelTuningNinferContext');
  assert.deepEqual([...select.options].map((option) => option.textContent), ['16k tokens', '32k tokens', '64k tokens', '128k tokens', '150k tokens · 8-bit cache', '256k tokens · 8-bit cache']);
  assert.equal(select.value, '65536');
  assert.ok(doc.querySelector('[data-inv-toggle="modelTuningNinferMtp"]'), 'the MTP toggle');
  assert.equal(doc.querySelector('[data-action="apply-ninfer-tuning"]').disabled, true, 'nothing dirty yet');
  assert.equal(h.calls.some((call) => call[0] === 'engines.getSettings'), false, 'no llama-server engine reads for an NInfer row');
  assert.ok(doc.querySelector('[data-action="save-model-tuning"]'), 'the generation profile Apply stays');
});

test('a context change enables Apply, saves through ninfer.updateSettings, and a server not serving the model needs no restart', async () => {
  const h = harness();
  await h.open();
  await flush();
  const select = h.doc().getElementById('modelTuningNinferContext');
  select.value = '131072';
  select.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
  const apply = h.doc().querySelector('[data-action="apply-ninfer-tuning"]');
  assert.equal(apply.disabled, false);
  assert.equal(h.doc().querySelector('[data-model-tuning-row="ninferContext"] .model-tuning-row-range').dataset.dirty, 'true');
  apply.click();
  await flush();
  await flush();
  assert.deepEqual(h.calls.filter((call) => call[0] === 'ninfer.updateSettings'), [['ninfer.updateSettings', { contextSize: 131072, mtp: true, vision: true }]]);
  assert.equal(h.calls.some((call) => call[0] === 'ninfer.restart'), false);
  assert.match(h.text(), /Setting saved\. It takes effect when NInfer next starts\./);
  assert.equal(h.doc().querySelector('[data-action="apply-ninfer-tuning"]').disabled, true, 'clean again after the save');
});

test('the drawer Apply commits a pending NInfer change it counts, then reads clean', async () => {
  // Regression: "Apply 1 change" counted the NInfer row but applied only the
  // generation profile, so the drawer said Applied and the count stayed.
  const h = harness();
  await h.open();
  await flush();
  const select = h.doc().getElementById('modelTuningNinferContext');
  select.value = '262144';
  select.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
  const save = () => h.doc().querySelector('[data-action="save-model-tuning"]');
  assert.equal(save().textContent, 'Apply 1 change');
  save().click();
  await flush();
  await flush();
  assert.deepEqual(h.calls.filter((call) => call[0] === 'ninfer.updateSettings'), [['ninfer.updateSettings', { contextSize: 262144, mtp: true, vision: true }]]);
  assert.equal(h.calls.some((call) => call[0] === 'tuning'), false, 'no profile write when only NInfer changed');
  assert.equal(save().textContent, 'Apply 0 changes');
  assert.equal(save().disabled, true);
  assert.match(h.text(), /Setting saved\. It takes effect when NInfer next starts\./);
  assert.doesNotMatch(h.text(), /runtime acknowledged this model profile/);
});

test('while NInfer serves the model, Apply restarts it with the new spec; a streaming chat asks first with NInfer wording', async () => {
  const h = harness({ manager: { state: 'ready', alias: MODEL, port: 8034, artifactId: MODEL, mtp: true } });
  await h.open();
  await flush();
  assert.match(h.text(), /Serving on :8034 · MTP on/);
  h.doc().getElementById('modelTuningDrawer').dispatchEvent(new h.dom.window.CustomEvent('inv-toggle-change', { bubbles: true, detail: { id: 'modelTuningNinferMtp', checked: false } }));
  h.doc().querySelector('[data-action="apply-ninfer-tuning"]').click();
  await flush();
  await flush();
  await flush();
  assert.deepEqual(h.calls.filter((call) => call[0] === 'ninfer.restart'), [['ninfer.restart', { artifactId: MODEL, contextSize: 65536, mtp: false, vision: true }]]);
  assert.deepEqual(h.confirms, [], 'no chat streaming: no confirm');
  assert.match(h.text(), /NInfer restarted with the new settings\./);
  // A streaming chat: the confirm names NInfer; Not now keeps the saved setting for the next restart.
  const streaming = harness({ manager: { state: 'ready', alias: MODEL, port: 8034, artifactId: MODEL, mtp: true }, streaming: 2, confirm: false });
  await streaming.open();
  await flush();
  const select = streaming.doc().getElementById('modelTuningNinferContext');
  select.value = '32768';
  select.dispatchEvent(new streaming.dom.window.Event('change', { bubbles: true }));
  streaming.doc().querySelector('[data-action="apply-ninfer-tuning"]').click();
  await flush();
  await flush();
  await flush();
  assert.equal(streaming.confirms.length, 1);
  assert.equal(streaming.confirms[0].title, 'Restart NInfer?');
  assert.equal(streaming.confirms[0].message, '2 chats are still streaming. Restarting NInfer will end those responses. The new settings only take effect after a restart.');
  assert.equal(streaming.calls.some((call) => call[0] === 'ninfer.restart'), false);
  assert.match(streaming.text(), /Setting saved\. The new settings will take effect on the next NInfer restart\./);
});

test('a refused save and a failed restart say so and keep the drawer usable', async () => {
  const refused = harness({ saveFails: true });
  await refused.open();
  await flush();
  const select = refused.doc().getElementById('modelTuningNinferContext');
  select.value = '16384';
  select.dispatchEvent(new refused.dom.window.Event('change', { bubbles: true }));
  refused.doc().querySelector('[data-action="apply-ninfer-tuning"]').click();
  await flush();
  await flush();
  assert.match(refused.text(), /The NInfer settings could not be saved\./);
  assert.equal(refused.doc().querySelector('[data-action="apply-ninfer-tuning"]').disabled, false, 'the draft stays for a retry');
  const failed = harness({ manager: { state: 'ready', alias: MODEL, port: 8034, artifactId: MODEL, mtp: true }, restartFails: true });
  await failed.open();
  await flush();
  const context = failed.doc().getElementById('modelTuningNinferContext');
  context.value = '16384';
  context.dispatchEvent(new failed.dom.window.Event('change', { bubbles: true }));
  failed.doc().querySelector('[data-action="apply-ninfer-tuning"]').click();
  await flush();
  await flush();
  await flush();
  assert.match(failed.text(), /NInfer restart failed\. The setting was saved and is not live yet\./);
});

test('a plain openai-compatible row (no NInfer hint) keeps the llama-server Engine section exactly as before', async () => {
  const h = harness();
  await h.controller.open(MODEL, null, { displayName: 'Qwen3.8 27B', engineTypeHint: 'openai-compatible' });
  await flush();
  assert.equal(h.doc().querySelector('[data-model-tuning-ninfer]'), null);
  assert.ok(h.doc().querySelector('[data-model-tuning-engine]'));
  assert.ok(h.doc().querySelector('#modelTuningContextLength'), 'the generic context row is back');
  assert.match(h.doc().querySelector('.model-tuning-drawer-subtitle').textContent, /· llama-server ·/);
  assert.ok(h.calls.some((call) => call[0] === 'engines.getSettings'));
});

test('the section module stands alone: labels, dirty tracking and a missing bridge', async () => {
  assert.equal(contextLabel(153600), '150k');
  assert.equal(contextLabel(512), '512');
  const section = createNinferTuningSection({ windowRef: { jennyShell: {} }, escapeHtml: (s) => s });
  assert.equal(await section.open(HINT), false, 'no bridge: nothing read');
  assert.equal(section.active(), true);
  assert.equal(section.dirty(), false);
  assert.equal(await section.apply(), false, 'no bridge: no save');
  section.close();
  assert.equal(section.active(), false);
});


test('Vision defaults on, counts as one draft change and both Apply actions save false', async () => {
  for (const action of ['apply-ninfer-tuning', 'save-model-tuning']) {
    const h = harness();
    await h.open(); await flush();
    assert.equal(h.doc().querySelector('[data-inv-toggle="modelTuningNinferVision"]').getAttribute('aria-checked'), 'true');
    h.doc().getElementById('modelTuningDrawer').dispatchEvent(new h.dom.window.CustomEvent('inv-toggle-change', {
      bubbles: true, detail: { id: 'modelTuningNinferVision', checked: false },
    }));
    assert.equal(h.doc().querySelector('[data-action="save-model-tuning"]').textContent, 'Apply 1 change');
    h.doc().querySelector('[data-action="' + action + '"]').click();
    await flush(); await flush();
    assert.deepEqual(h.calls.find(([name]) => name === 'ninfer.updateSettings')[1], { contextSize: 65536, mtp: true, vision: false });
    assert.equal(h.calls.some(([name]) => name === 'ninfer.restart'), false);
    assert.equal(h.doc().querySelector('[data-action="save-model-tuning"]').disabled, true);
  }
  const off = harness({ settings: { vision: false } });
  await off.open(); await flush();
  assert.equal(off.doc().querySelector('[data-inv-toggle="modelTuningNinferVision"]').getAttribute('aria-checked'), 'false');
});

test('a Vision change restarts only after the existing streaming confirmation', async () => {
  for (const confirm of [true, false]) {
    const h = harness({ manager: { state: 'ready', alias: MODEL, artifactId: MODEL, vision: true }, streaming: 1, confirm });
    await h.open(); await flush();
    h.doc().getElementById('modelTuningDrawer').dispatchEvent(new h.dom.window.CustomEvent('inv-toggle-change', {
      bubbles: true, detail: { id: 'modelTuningNinferVision', checked: false },
    }));
    h.doc().querySelector('[data-action="apply-ninfer-tuning"]').click();
    await flush(); await flush(); await flush();
    assert.equal(h.confirms.length, 1);
    const restart = h.calls.find(([name]) => name === 'ninfer.restart');
    assert.equal(Boolean(restart), confirm);
    if (restart) assert.equal(restart[1].vision, false);
    else assert.match(h.text(), /next NInfer restart/);
  }
});
