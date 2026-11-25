'use strict';

// new-test-file: a new surface (row 200 D6): the Strata section of the Tune drawer (slots, memory format, the fit line,
// the context window, draft ahead, vision, Apply and the restart flow). The Library row cases live in the merge and view tests.

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
const { createStrataTuningSection, contextLabel } = require('../renderer/shell/renderer-model-tuning-strata');

const MODEL = 'inkling-2-mini-sq-20';

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function fits(overrides = {}) {
  const table = {};
  for (const slots of [1, 2, 4]) for (const kv of ['auto', 'k8v8', 'k8v4']) table[`${slots}:${kv}`] = { tokens: null, source: 'default' };
  return {
    ...table,
    '1:auto': { tokens: 114432, source: 'measured' },
    '1:k8v8': { tokens: 228864, source: 'measured' },
    '2:k8v8': { tokens: 114432, source: 'learned' },
    ...overrides,
  };
}

function harness(options = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  const calls = [];
  const manager = { state: 'stopped', port: 0, alias: '', ...(options.manager || {}) };
  const settings = { slots: 1, kv: 'auto', context: null, vision: true, drafting: 'off', watchdog: { enabled: false, maxWatts: 460, maxTempC: 83 }, ...(options.settings || {}) };
  const state = {
    features: { featureFlags: { llama_server_acceleration: options.acceleration !== false } },
    modelList: { data: [{ id: MODEL, engine_type: 'openai-compatible' }] },
    diagnosticsSnapshot: { runtime: { managed_server: options.managedServer || null } },
  };
  let streaming = options.streaming || 0;
  dom.window.jennyShell = {
    modelTuning: {
      async getState() { return { contextLengthSteps: [4096, 8192], contextLengthByModel: {}, ratioByModel: {}, generationProfilesByModel: {} }; },
      async update(payload) { calls.push(['tuning', payload]); return { status: 'applied', state: {} }; },
    },
    engines: { async getSettings() { calls.push(['engines.getSettings']); return { localEngines: { openaiCompatible: { managed: { enabled: true, perModel: {} } } } }; } },
    llamaServer: { async listLocalGgufs() { return { ok: true, entries: [] }; }, async getStatus() { return { ok: true, state: 'stopped' }; } },
    strata: {
      async getState() {
        calls.push(['strata.getState']);
        return { eligible: true, runtime: { packs: { native: 'verified', vision: 'verified', ...(options.packs || {}) } }, manager, settings, fits: options.fits || fits() };
      },
      async updateSettings(payload) { calls.push(['strata.updateSettings', payload]); return options.saveFails ? { ok: false, reason: 'invalid_payload' } : { ok: true, settings: { ...settings, ...payload } }; },
      async restart(spec) { calls.push(spec === undefined ? ['strata.restart'] : ['strata.restart', spec]); return options.restartFails ? { ok: false, reason: 'strata_start_failed', status: { state: 'stopped' } } : { ok: true, status: { ...manager, state: 'ready' } }; },
    },
  };
  const confirms = [];
  const controller = createModelTuningDrawerController({
    state, windowRef: dom.window, documentRef: dom.window.document, drawerFactory,
    inventory: { selectField, textField, actionButton, segmentedControl, toggleSwitch },
    getStreamingSessionIds: () => Array.from({ length: streaming }, (_, i) => `s${i}`),
    confirmDialog: { async confirm(request) { confirms.push(request); return options.confirm !== false; } },
  });
  const doc = () => dom.window.document;
  const pick = (id, value) => doc().querySelector(`[data-inv-segmented="${id}"] [data-value="${value}"]`).click();
  const toggle = (id, checked) => doc().getElementById('modelTuningDrawer').dispatchEvent(new dom.window.CustomEvent('inv-toggle-change', { bubbles: true, detail: { id, checked } }));
  return {
    dom, calls, confirms, controller, doc, pick, toggle, manager,
    text: () => doc().getElementById('modelTuningDrawer').textContent,
    fitLine: () => doc().getElementById('strataFitLine').textContent,
    contextOptions: () => [...doc().getElementById('strataContext').options].map((option) => [option.value, option.textContent]),
    apply: () => doc().querySelector('[data-action="apply-strata-tuning"]'),
    updates: () => calls.filter((call) => call[0] === 'strata.updateSettings').map((call) => call[1]),
    open: async () => { await controller.open(MODEL, null, { displayName: 'Inkling 2 Mini', engineTypeHint: 'openai-compatible', strata: { modelId: MODEL } }); await flush(); },
  };
}

test('a Strata row opens on the Strata section: its rows, defaults and the engine named, with no Engine section and no generic context row', async () => {
  const h = harness();
  await h.open();
  const doc = h.doc();
  assert.ok(doc.querySelector('[data-model-tuning-strata]'));
  assert.equal(doc.querySelector('[data-model-tuning-engine]'), null);
  assert.equal(doc.querySelector('[data-model-tuning-ninfer]'), null);
  assert.equal(doc.querySelector('#modelTuningContextLength'), null);
  assert.equal(doc.querySelector('[data-model-tuning-strata] .model-tuning-section-title').textContent, 'Strata');
  assert.match(h.text(), /Starts when you press Load/);
  assert.match(h.text(), /Runs on your Strata install\. These apply after Strata restarts\./);
  assert.equal(h.calls.some((call) => call[0] === 'engines.getSettings'), false, 'no llama-server engine reads for a Strata row');
  assert.deepEqual([...doc.querySelectorAll('[data-inv-segmented="strataSlots"] [data-value]')].map((node) => node.dataset.value), ['1', '2', '4']);
  assert.deepEqual([...doc.querySelectorAll('[data-inv-segmented="strataKv"] .inv-segmented-option-label')].map((node) => node.textContent), ['Standard', 'Compact', 'Smallest']);
  assert.match(h.text(), /How many chats Strata answers at the same time\./);
  assert.match(h.text(), /Compact holds about twice as much/);
  assert.equal(doc.querySelector('[data-inv-toggle="strataDraft"]').getAttribute('aria-checked'), 'false');
  assert.equal(doc.querySelector('[data-inv-toggle="strataVision"]').getAttribute('aria-checked'), 'true');
  assert.equal(h.apply().disabled, true, 'nothing dirty yet');
  assert.equal(h.apply().textContent, 'Apply Strata settings');
  assert.ok(doc.querySelector('[data-action="save-model-tuning"]'), 'the generation profile Apply stays');
});

test('the pairing line and the context options follow every slots and memory-format click, before Apply', async () => {
  const h = harness();
  await h.open();
  assert.equal(h.fitLine(), 'With this choice each chat can hold up to 112k tokens.');
  assert.equal(h.doc().querySelector('#strataFitLine b').textContent, '112k tokens');
  assert.deepEqual(h.contextOptions(), [['max', 'Largest that fits (112k tokens)'], ['16384', '16k tokens'], ['32768', '32k tokens'], ['65536', '64k tokens']]);
  assert.equal(h.doc().getElementById('strataContext').value, 'max');
  h.pick('strataKv', 'k8v8');
  assert.equal(h.fitLine(), 'With this choice each chat can hold up to 224k tokens.');
  assert.deepEqual(h.contextOptions().map(([value]) => value), ['max', '16384', '32768', '65536', '131072']);
  assert.match(h.doc().querySelector('[data-model-tuning-row="strataContext"] [data-model-tuning-note]').textContent, /Follows your choice above/);
  h.pick('strataSlots', '2');
  assert.equal(h.fitLine(), 'With this choice each chat can hold up to 112k tokens, and 2 chats are answered at once.');
  h.pick('strataKv', 'auto');
  assert.equal(h.fitLine(), 'This choice has not been measured on this card. Jenny starts at 32k tokens and keeps what Strata reports.');
  assert.deepEqual(h.contextOptions(), [['32768', '32k tokens (until the first start measures this choice)']]);
  assert.match(h.doc().querySelector('[data-model-tuning-row="strataContext"] [data-model-tuning-note]').textContent, /Not measured on this card yet\. Jenny starts at 32k and keeps the size Strata reports\./);
  assert.equal(h.apply().disabled, false, 'a click makes Apply live without a re-render');
  assert.equal(h.doc().querySelector('[data-model-tuning-row="strataSlots"] [data-model-tuning-changed]').hidden, false);
  assert.equal(h.doc().querySelector('[data-inv-segmented="strataSlots"] [aria-checked="true"]').dataset.value, '2');
});

test('a known fit never offers a size at or above it; a saved size at or above the fit shows as the largest', async () => {
  const exact = harness({ fits: fits({ '1:auto': { tokens: 65536, source: 'measured' } }), settings: { context: 32768 } });
  await exact.open();
  assert.deepEqual(exact.contextOptions().map(([value]) => value), ['max', '16384', '32768']);
  assert.equal(exact.doc().getElementById('strataContext').value, '32768');
  const above = harness({ settings: { context: 262144 } });
  await above.open();
  assert.equal(above.doc().getElementById('strataContext').value, 'max');
  assert.equal(above.apply().disabled, true, 'showing it as max is not a change');
  const odd = harness({ settings: { context: 40000 } });
  await odd.open();
  assert.equal(odd.doc().getElementById('strataContext').value, '40000');
  assert.ok(odd.contextOptions().some(([value]) => value === '40000'), 'a saved size below the fit stays visible');
  const none = harness({ fits: { '1:auto': { tokens: null, source: 'default' } } });
  await none.open();
  assert.deepEqual(none.contextOptions().map(([value]) => value), ['32768']);
  assert.match(none.fitLine(), /^This choice has not been measured on this card\./);
});

test('Largest that fits saves context: null; Apply sends only the changed keys and a server that is not serving needs no restart', async () => {
  const h = harness({ settings: { context: 65536 } });
  await h.open();
  const select = h.doc().getElementById('strataContext');
  select.value = 'max';
  select.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
  assert.equal(h.apply().disabled, false);
  h.apply().click();
  await flush();
  await flush();
  assert.deepEqual(h.updates(), [{ context: null }]);
  assert.equal(h.calls.some((call) => call[0] === 'strata.restart'), false);
  assert.match(h.text(), /Setting saved\. It takes effect when Strata next starts\./);
  assert.equal(h.apply().disabled, true, 'clean again after the save');
  // Strata started (Load) after the drawer opened: Apply decides the restart on its state now, not the stale one.
  const late = harness({ settings: { context: 65536 } });
  await late.open();
  late.manager.state = 'ready';
  const lateSelect = late.doc().getElementById('strataContext');
  lateSelect.value = 'max';
  lateSelect.dispatchEvent(new late.dom.window.Event('change', { bubbles: true }));
  late.apply().click();
  for (let i = 0; i < 4; i += 1) await flush();
  assert.deepEqual(late.calls.filter((call) => call[0] === 'strata.restart'), [['strata.restart']]);
  h.pick('strataSlots', '4');
  h.pick('strataKv', 'k8v4');
  h.toggle('strataDraft', true);
  h.apply().click();
  await flush();
  await flush();
  assert.deepEqual(h.updates()[1], { slots: 4, kv: 'k8v4', drafting: 'dspark' });
  h.toggle('strataDraft', false);
  h.apply().click();
  await flush();
  await flush();
  assert.deepEqual(h.updates()[2], { drafting: 'off' });
});

test('a pairing whose fit is smaller than the saved size sends the size as the largest that fits', async () => {
  const h = harness({ settings: { context: 65536 }, fits: fits({ '2:k8v8': { tokens: 40960, source: 'learned' } }) });
  await h.open();
  h.pick('strataSlots', '2');
  h.pick('strataKv', 'k8v8');
  h.apply().click();
  await flush();
  await flush();
  assert.deepEqual(h.updates(), [{ slots: 2, kv: 'k8v8', context: null }]);
});

test('the drawer Apply commits a pending Strata change it counts, then reads clean', async () => {
  const h = harness();
  await h.open();
  h.pick('strataKv', 'k8v8');
  const save = () => h.doc().querySelector('[data-action="save-model-tuning"]');
  assert.equal(save().textContent, 'Apply 1 change');
  save().click();
  await flush();
  await flush();
  assert.deepEqual(h.updates(), [{ kv: 'k8v8' }]);
  assert.equal(h.calls.some((call) => call[0] === 'tuning'), false, 'no profile write when only Strata changed');
  assert.equal(save().textContent, 'No changes');
  assert.match(h.text(), /Setting saved\. It takes effect when Strata next starts\./);
});

test('vision is on by default, sends its change, and is disabled with a reason when the image pack did not pass', async () => {
  const h = harness();
  await h.open();
  h.toggle('strataVision', false);
  h.apply().click();
  await flush();
  await flush();
  assert.deepEqual(h.updates(), [{ vision: false }]);
  for (const vision of ['failed', 'missing']) {
    const off = harness({ packs: { vision } });
    await off.open();
    const control = off.doc().querySelector('[data-inv-toggle="strataVision"]');
    assert.equal(control.disabled, true);
    assert.equal(control.getAttribute('aria-checked'), 'false');
    assert.match(off.text(), /The image pack did not pass its check\./);
    assert.equal(off.apply().disabled, true);
  }
});

test('while Strata serves, Apply restarts it; a streaming chat asks first, and Not now keeps the saved setting', async () => {
  const h = harness({ manager: { state: 'ready', alias: MODEL, port: 8035 } });
  await h.open();
  assert.match(h.text(), /Serving on :8035/);
  h.pick('strataSlots', '2');
  h.apply().click();
  await flush();
  await flush();
  await flush();
  assert.deepEqual(h.calls.filter((call) => call[0] === 'strata.restart'), [['strata.restart']]);
  assert.deepEqual(h.confirms, []);
  assert.match(h.text(), /Strata restarted with the new settings\./);
  const starting = harness({ manager: { state: 'starting', port: 8035 } });
  await starting.open();
  starting.pick('strataKv', 'k8v8');
  starting.apply().click();
  await flush();
  await flush();
  await flush();
  assert.equal(starting.calls.filter((call) => call[0] === 'strata.restart').length, 1, 'a start in progress restarts too');
  const streaming = harness({ manager: { state: 'ready', alias: MODEL, port: 8035 }, streaming: 2, confirm: false });
  await streaming.open();
  streaming.pick('strataKv', 'k8v8');
  streaming.apply().click();
  await flush();
  await flush();
  await flush();
  assert.equal(streaming.confirms.length, 1);
  assert.equal(streaming.confirms[0].title, 'Restart Strata?');
  assert.equal(streaming.confirms[0].confirmLabel, 'Restart anyway');
  assert.equal(streaming.confirms[0].cancelLabel, 'Not now');
  assert.equal(streaming.calls.some((call) => call[0] === 'strata.restart'), false);
  assert.match(streaming.text(), /Setting saved\. The new settings will take effect on the next Strata restart\./);
});

test('a refused save and a failed restart say so, keep the draft and never show the reason', async () => {
  const refused = harness({ saveFails: true });
  await refused.open();
  refused.pick('strataSlots', '4');
  refused.apply().click();
  await flush();
  await flush();
  assert.match(refused.text(), /The Strata settings could not be saved\./);
  assert.equal(refused.text().includes('invalid_payload'), false);
  assert.equal(refused.apply().disabled, false, 'the draft stays for a retry');
  const failed = harness({ manager: { state: 'ready', alias: MODEL, port: 8035 }, restartFails: true });
  await failed.open();
  failed.pick('strataSlots', '2');
  failed.apply().click();
  await flush();
  await flush();
  await flush();
  assert.match(failed.text(), /Strata restart failed\. The setting was saved and is not live yet\./);
  assert.equal(failed.text().includes('strata_start_failed'), false);
});

test('Discard returns the draft to the saved settings', async () => {
  const h = harness();
  await h.open();
  h.pick('strataSlots', '4');
  h.toggle('strataDraft', true);
  assert.equal(h.doc().querySelector('[data-action="save-model-tuning"]').textContent, 'Apply 2 changes');
  h.doc().querySelector('[data-action="discard-model-tuning"]').click();
  assert.equal(h.doc().querySelector('[data-inv-segmented="strataSlots"] [aria-checked="true"]').dataset.value, '1');
  assert.equal(h.doc().querySelector('[data-inv-toggle="strataDraft"]').getAttribute('aria-checked'), 'false');
  assert.equal(h.apply().disabled, true);
});

test('other segmented controls still reach the engine handler, and a plain openai-compatible row keeps the Engine section', async () => {
  const h = harness();
  await h.controller.open(MODEL, null, { displayName: 'Inkling 2 Mini', engineTypeHint: 'openai-compatible' });
  await flush();
  assert.equal(h.doc().querySelector('[data-model-tuning-strata]'), null);
  assert.ok(h.doc().querySelector('[data-model-tuning-engine]'));
  assert.ok(h.doc().querySelector('#modelTuningContextLength'));
  assert.equal(h.doc().querySelector('[data-model-tuning-engine] .model-tuning-section-title').textContent, 'Engine');
});

test('the engine label names Strata for a row Strata serves, and the section module stands alone', async () => {
  assert.equal(contextLabel(114432), '112k');
  assert.equal(contextLabel(512), '512');
  const section = createStrataTuningSection({ windowRef: { jennyShell: {} }, escapeHtml: (s) => s });
  assert.equal(await section.open({ modelId: MODEL }), false, 'no bridge: nothing read');
  assert.equal(section.active(), true);
  assert.equal(section.dirty(), false);
  assert.equal(await section.apply(), false, 'no bridge: no save');
  section.close();
  assert.equal(section.active(), false);
  const served = harness({ managedServer: { kind: 'strata', alias: MODEL, state: 'ready' }, acceleration: false });
  await served.controller.open(MODEL, null, { displayName: 'Inkling 2 Mini', engineTypeHint: 'openai-compatible' });
  await flush();
  assert.equal(served.doc().querySelector('.model-tuning-drawer-subtitle').textContent, 'Runs on Strata.');
  const other = harness({ managedServer: { kind: 'strata', alias: 'another-model', state: 'ready' }, acceleration: false });
  await other.controller.open(MODEL, null, { displayName: 'Inkling 2 Mini', engineTypeHint: 'openai-compatible' });
  await flush();
  assert.equal(other.doc().querySelector('.model-tuning-drawer-subtitle').textContent, 'Runs on llama-server.');
});
