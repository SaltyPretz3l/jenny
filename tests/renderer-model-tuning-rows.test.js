'use strict';

// Tune drawer rows (renderer/shell/renderer-model-tuning-rows.js) and the
// drawer behaviors built on them: plain-language rows with tooltips, a custom
// context window, Summarize at as a percentage, per-row revert, Discard, a
// Reset that fills the draft, and the Advanced sampling fold.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const drawerFactory = require('../renderer/inventory/drawer');
const selectField = require('../renderer/inventory/select-field');
const textField = require('../renderer/inventory/text-field');
const actionButton = require('../renderer/inventory/action-button');
const rows = require('../renderer/shell/renderer-model-tuning-rows');
const { createModelTuningDrawerController } = require('../renderer/shell/renderer-model-tuning-drawer');
const compaction = require('../services/shell-config-compaction-tuning');

const MODEL = 'gemma3:latest';
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

function harness(t, saved = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  const calls = [];
  let state = {
    contextLengthSteps: [4096, 8192, 32768],
    contextLengthBounds: { min: 2048, max: 262144 },
    contextLengthByModel: { [MODEL]: 4096 },
    ratioByModel: { [MODEL]: 0.8 },
    ratioBounds: { min: 0.1, max: 0.99 },
    generationProfilesByModel: { [MODEL]: { temperature: 0.6 } },
    ...saved,
  };
  dom.window.jennyShell = { modelTuning: {
    async getState() { return state; },
    async update(payload) {
      calls.push(payload);
      state = {
        ...state,
        contextLengthByModel: Object.hasOwn(payload, 'contextLength')
          ? (payload.contextLength == null ? {} : { [MODEL]: payload.contextLength }) : state.contextLengthByModel,
        ratioByModel: Object.hasOwn(payload, 'ratio')
          ? (payload.ratio == null ? {} : { [MODEL]: payload.ratio }) : state.ratioByModel,
        generationProfilesByModel: Object.keys(payload.generationProfile || {}).length
          ? { [MODEL]: payload.generationProfile } : {},
      };
      return { status: 'applied', state };
    },
  } };
  const controller = createModelTuningDrawerController({
    state: { modelList: { data: [{ id: MODEL, engine_type: 'ollama' }] } },
    windowRef: dom.window, documentRef: dom.window.document, drawerFactory,
    inventory: { selectField, textField, actionButton },
  });
  t.after(() => controller.dispose());
  const host = () => dom.window.document.getElementById('modelTuningDrawer');
  const q = (selector) => host().querySelector(selector);
  const set = (selector, value, type = 'input') => {
    const node = q(selector);
    node.value = value;
    node.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
    return node;
  };
  const applyLabel = () => q('[data-action="save-model-tuning"]').textContent;
  return { dom, calls, controller, host, q, set, applyLabel, open: () => controller.open(MODEL) };
}

test('every field has a label, a one-line description and a tooltip with the live bounds', () => {
  for (const key of ['contextLength', 'ratio', 'temperature', 'maxOutputTokens', ...rows.ADVANCED_KEYS]) {
    const copy = rows.fieldCopy(key, { min: 1, max: 7 });
    assert.ok(copy.label && copy.desc && copy.tip, key);
    assert.match(copy.tip, /\b1\b.*\b7\b/, `${key} names its bounds`);
  }
});

test('the defaults the rows name match their owners', () => {
  const tokenBudget = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'ai', 'context', 'token_budget.py'), 'utf8');
  assert.equal(Number(/^_AUTO_COMPACT_RATIO = ([\d.]+)$/m.exec(tokenBudget)[1]), rows.RATIO_DEFAULT);
  assert.deepEqual(rows.CONTEXT_BOUNDS, { min: compaction.CONTEXT_LENGTH_MIN, max: compaction.CONTEXT_LENGTH_MAX });
  const configSections = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'ai', 'config_sections.py'), 'utf8');
  const overrideCap = /"context_length_override"\),[\s\S]*?max_value=([\d_]+)/.exec(configSections)[1];
  assert.equal(Number(overrideCap.replaceAll('_', '')), compaction.CONTEXT_LENGTH_MAX, 'the sidecar accepts every custom size');
});

test('Custom… takes any whole number of tokens in bounds and saves it', async (t) => {
  const h = harness(t);
  await h.open();
  const wrap = h.q('[data-model-tuning-context-custom]');
  assert.equal(wrap.hidden, true, 'a preset keeps the token field hidden');
  assert.ok([...h.q('#modelTuningContextLength').options].some((option) => option.value === 'custom'));

  h.set('#modelTuningContextLength', 'custom', 'change');
  assert.equal(wrap.hidden, false);
  assert.equal(h.q('#modelTuningContextCustom').value, '4096', 'seeded with the saved size');
  assert.equal(h.applyLabel(), 'No changes', 'the same size is no change');

  h.set('#modelTuningContextCustom', '1000');
  assert.equal(h.q('[data-action="save-model-tuning"]').disabled, true);
  assert.equal(h.q('[data-model-tuning-row="contextLength"] [data-model-tuning-note]').textContent,
    'Enter a whole number of tokens from 2,048 to 262,144.');

  h.set('#modelTuningContextCustom', '200000');
  assert.equal(h.applyLabel(), 'Apply 1 change');
  assert.equal(h.q('[data-model-tuning-row="contextLength"] [data-model-tuning-note]').textContent, '');
  h.q('[data-action="save-model-tuning"]').click();
  await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].contextLength, 200000);
  assert.equal(Object.hasOwn(h.calls[0], 'ratio'), false, 'an unchanged ratio is not sent');
  // Re-rendered from the saved state: a non-preset size reopens on Custom.
  assert.equal(h.q('#modelTuningContextLength').value, 'custom');
  assert.equal(h.q('#modelTuningContextCustom').value, '200000');
  assert.equal(h.q('[data-model-tuning-context-custom]').hidden, false);
  assert.equal(h.applyLabel(), 'No changes');

  h.set('#modelTuningContextLength', '8192', 'change');
  assert.equal(h.q('[data-model-tuning-context-custom]').hidden, true, 'a preset hides the token field again');
  assert.equal(h.applyLabel(), 'Apply 1 change');
});

test('Summarize at reads and writes a percentage over the stored ratio', async (t) => {
  const h = harness(t, { ratioByModel: { [MODEL]: 0.855 } });
  await h.open();
  const ratio = h.q('#modelTuningRatio');
  assert.equal(ratio.value, '86');
  assert.equal(h.applyLabel(), 'No changes', 'a stored ratio that rounds to the shown percent is clean');
  assert.equal(ratio.placeholder, 'Default (90%)');
  h.set('#modelTuningRatio', '75');
  h.q('[data-action="save-model-tuning"]').click();
  await flush();
  assert.equal(h.calls[0].ratio, 0.75);
});

test('a fractional percent saves as the whole percent the field will show', async (t) => {
  const h = harness(t);
  await h.open();
  h.set('#modelTuningRatio', '85.5');
  h.q('[data-action="save-model-tuning"]').click();
  await flush();
  assert.equal(h.calls[0].ratio, 0.86);
});

test('while an apply is in flight, Discard and the revert buttons are locked', async (t) => {
  const h = harness(t, { generationProfilesByModel: { [MODEL]: { temperature: 0.6, topK: 40 } } });
  let release;
  const realUpdate = h.dom.window.jennyShell.modelTuning.update;
  h.dom.window.jennyShell.modelTuning.update = (payload) => new Promise((resolve) => {
    release = () => resolve(realUpdate(payload));
  });
  await h.open();
  h.set('#modelTuningTemperature', '0.7');
  h.q('[data-action="save-model-tuning"]').click();
  await flush();
  assert.equal(h.q('[data-action="discard-model-tuning"]').disabled, true);
  const revert = h.q('[data-model-tuning-row="topK"] [data-model-tuning-revert]');
  assert.equal(revert.disabled, true);
  revert.dispatchEvent(new h.dom.window.Event('click', { bubbles: true }));
  assert.equal(h.q('#modelTuningTopK').value, '40', 'a locked revert clears nothing');
  release();
  await flush();
  assert.equal(h.q('[data-model-tuning-row="topK"] [data-model-tuning-revert]').disabled, false);
});

test('revert clears one field to its default; Discard throws every edit away', async (t) => {
  const h = harness(t);
  await h.open();
  const row = h.q('[data-model-tuning-row="temperature"]');
  const revert = row.querySelector('[data-model-tuning-revert]');
  assert.equal(revert.hidden, false, 'a saved value can be cleared');
  assert.equal(revert.getAttribute('aria-label'), 'Clear Temperature to use the default');
  assert.equal(h.q('[data-model-tuning-row="topP"] [data-model-tuning-revert]').hidden, true, 'nothing to clear');
  revert.click();
  assert.equal(h.q('#modelTuningTemperature').value, '');
  assert.equal(row.querySelector('[data-model-tuning-changed]').hidden, false);
  assert.equal(revert.hidden, true);
  assert.equal(h.applyLabel(), 'Apply 1 change');

  h.set('#modelTuningTopK', '40');
  const discard = h.q('[data-action="discard-model-tuning"]');
  assert.equal(discard.hidden, false);
  discard.click();
  assert.equal(h.q('#modelTuningTemperature').value, '0.6');
  assert.equal(h.q('#modelTuningTopK').value, '');
  assert.equal(h.applyLabel(), 'No changes');
  assert.equal(h.q('[data-action="discard-model-tuning"]').hidden, true);
  assert.equal(h.calls.length, 0, 'Discard never writes');
});

test('Reset fills the draft and Apply commits it; with nothing saved it is disabled', async (t) => {
  const h = harness(t);
  await h.open();
  h.q('[data-action="reset-model-tuning"]').click();
  assert.equal(h.calls.length, 0, 'Reset alone writes nothing');
  assert.equal(h.q('#modelTuningTemperature').value, '');
  assert.equal(h.q('#modelTuningRatio').value, '');
  assert.equal(h.q('#modelTuningContextLength').value, '');
  assert.equal(h.applyLabel(), 'Apply 3 changes');
  h.q('[data-action="save-model-tuning"]').click();
  await flush();
  assert.deepEqual(h.calls[0], { modelId: MODEL, generationProfile: {}, ratio: null, contextLength: null });
  assert.equal(h.q('[data-action="reset-model-tuning"]').disabled, true, 'nothing left to reset');
});

test('the Advanced sampling fold opens for saved values and keeps the user\'s choice across re-renders', async (t) => {
  const h = harness(t, { generationProfilesByModel: { [MODEL]: { topK: 40, minP: 0.05 } } });
  await h.open();
  const fold = () => h.q('[data-model-tuning-fold]');
  assert.equal(fold().open, true);
  assert.equal(fold().querySelector('.model-tuning-fold-count').textContent, '2 set');
  fold().open = false;
  h.set('#modelTuningTemperature', '0.5');
  h.q('[data-action="save-model-tuning"]').click();
  await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(fold().open, false, 'the Apply re-render keeps it closed');
});
