const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createSubagentRoutingController, sync } = require('../renderer/shell/renderer-settings-subagents');
const { createSettingsSectionBinders } = require('../renderer/shell/renderer-settings-section-binders');
const { normalizeFeatureState, buildToolConfigFieldListMarkup } = require('../renderer/shell/renderer-settings-support');
const { normalizeSubagentRouting, applySubagentRoutingPatch } = require('../services/subagent-routing-settings');
const inventory = {
  settingsField: require('../renderer/inventory/settings-field'),
  selectField: require('../renderer/inventory/select-field'),
  actionButton: require('../renderer/inventory/action-button'),
  statusRow: require('../renderer/inventory/status-row'),
};
const settle = () => new Promise((resolve) => setImmediate(resolve));
function harness({ fail = false, catalogs, delay } = {}) {
  const dom = new JSDOM('<div id="toolsConfigFieldList"><div data-subagent-routing-host></div></div>');
  let features = { subagentRouting: normalizeSubagentRouting(), subagentModelCatalogs: catalogs || {
    chatgpt: { available: true, stale: false, models: [{ id: 'astra', label: 'Astra', reasoning_efforts: ['low', 'high'] },
      { id: 'luna', label: 'Luna', reasoning_efforts: ['medium'] }] },
    'codex-cli': { available: true, models: [{ id: 'codex-cli/default', reasoning_efforts: ['low', 'high'] }] },
  } };
  const writes = [];
  const bridge = { getState: async () => features, updateSettings: async (patch) => {
    writes.push(patch);
    if (delay) await delay;
    if (fail) throw new Error('failure');
    features = { ...features, subagentRouting: applySubagentRoutingPatch(features.subagentRouting, patch.subagentRouting) };
    return features;
  } };
  const windowRef = { document: dom.window.document, inventory, jennyShell: { features: bridge, models: { list: async () => ({}) } } };
  const container = windowRef.document.getElementById('toolsConfigFieldList');
  const controller = createSubagentRoutingController({ windowRef, container, getFeatures: () => features,
    applyFeatures: (payload) => { features = payload; } });
  controller.bind();
  function change(field, value) {
    const element = container.querySelector(`[data-subagent-field="${field}"]`);
    element.value = value;
    element.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  }
  function click(action, index) {
    const button = container.querySelector(`[data-subagent-action="${action}"]${index === undefined ? '' : `[data-index="${index}"]`}`);
    button.click();
  }
  return { controller, container, windowRef, change, click, writes, getFeatures: () => features };
}

test('catalog-backed model and effort selection, ordered preferences and provider switching save through features', async () => {
  const h = harness();
  await settle();
  h.change('model', 'astra');
  assert.deepEqual([...h.container.querySelector('#subagent-effort').options].map((row) => row.value), ['', 'low', 'high']);
  h.change('effort', 'high');
  h.change('preferred', 'astra');
  h.change('preferred', 'luna');
  h.click('up', 1);
  h.change('provider', 'codex-cli');
  h.change('model', 'codex-cli/default');
  h.click('save');
  await settle();
  h.change('provider', 'chatgpt');
  assert.equal(h.container.querySelector('#subagent-model').value, 'astra');
  assert.equal(h.container.querySelector('#subagent-effort').value, 'high');
  h.click('save');
  await settle();
  assert.deepEqual(h.writes[1], { subagentRouting: { chatgpt: { defaultModel: 'astra', defaultEffort: 'high', preferredModels: ['luna', 'astra'], allowedModels: [], maxEffort: '' } } });
  h.click('reset');
  await settle();
  assert.deepEqual(h.getFeatures().subagentRouting.chatgpt, normalizeSubagentRouting().chatgpt);
  assert.equal(h.getFeatures().subagentRouting['codex-cli'].defaultModel, 'codex-cli/default');
  h.controller.dispose();
});

test('a late catalog refresh cannot overwrite a newer routing save', async () => {
  const h = harness();
  await settle();
  const stale = structuredClone(h.getFeatures());
  let finishRefresh;
  h.windowRef.jennyShell.features.getState = () => new Promise((resolve) => { finishRefresh = resolve; });
  const refreshing = h.controller.refresh();
  await settle();
  h.change('model', 'astra');
  await h.controller.save();
  finishRefresh(stale);
  await refreshing;
  assert.equal(h.getFeatures().subagentRouting.chatgpt.defaultModel, 'astra');
  assert.equal(h.container.querySelector('#subagent-model').value, 'astra');
  assert.equal(h.container.querySelector('[data-subagent-action="save"]').disabled, true);
  h.controller.dispose();
});

test('changing model clears an effort unsupported by its selected model', async () => {
  const h = harness();
  await settle();
  h.change('model', 'astra'); h.change('effort', 'high'); h.change('model', 'luna');
  assert.equal(h.container.querySelector('#subagent-effort').value, '');
  assert.match(h.container.textContent, /primary agent can override/);
  h.controller.dispose();
});

test('empty, stale and unavailable catalogs have truthful states and preserve drafts across rerender', async () => {
  const h = harness({ catalogs: { chatgpt: { models: [], available: false } } });
  await settle();
  assert.match(h.container.textContent, /No model catalog/);
  assert.equal(h.container.querySelector('#subagent-effort').disabled, true);
  h.controller.dispose();
  const stale = harness({ catalogs: { chatgpt: { stale: true, available: true, models: [{ id: 'a' }] },
    'codex-cli': { available: false, models: [{ id: 'codex-cli/default', available: false }] } } });
  await settle();
  assert.match(stale.container.textContent, /cached model catalog/);
  stale.change('model', 'a');
  stale.container.querySelector('#subagent-model').focus();
  sync(stale.container);
  assert.equal(stale.container.querySelector('#subagent-model').value, 'a');
  assert.equal(stale.windowRef.document.activeElement.id, 'subagent-model');
  stale.change('provider', 'codex-cli');
  assert.match(stale.container.textContent, /provider is unavailable/);
  stale.controller.dispose();
});

test('save failure retains draft and late completion after disposal cannot repaint', async () => {
  const h = harness({ fail: true });
  await settle(); h.change('model', 'astra'); h.click('save'); await settle();
  assert.equal(h.container.querySelector('#subagent-model').value, 'astra');
  assert.match(h.container.textContent, /Your draft is kept/);
  h.controller.dispose();
  let resolve;
  const delayed = harness({ delay: new Promise((done) => { resolve = done; }) });
  await settle(); delayed.change('model', 'astra'); delayed.click('save');
  delayed.click('save');
  assert.equal(delayed.writes.length, 1);
  delayed.controller.dispose();
  const before = delayed.container.innerHTML;
  resolve(); await settle();
  assert.equal(delayed.container.innerHTML, before);
});

test('real Tools binder mounts the lazy controller, cleanup releases it, and feature normalization preserves routing', async () => {
  const h = harness(); h.controller.dispose();
  const cleanup = [];
  const state = { features: h.getFeatures() };
  const binders = createSettingsSectionBinders({ state, windowRef: h.windowRef,
    callbacks: { applyRoutingFeatureState: (payload) => { state.features = normalizeFeatureState(payload); } } });
  const context = { finalizeSectionBindings: () => true, markSectionBound() {}, addCleanup: (fn) => cleanup.push(fn) };
  binders.bindSection('tools', context); binders.bindSection('tools', context);
  assert.equal(cleanup.length, 1, 'binding Tools twice keeps one routing controller');
  await settle();
  assert.ok(h.container.querySelector('#subagent-model'));
  assert.equal(normalizeFeatureState(h.getFeatures()).subagentModelCatalogs.chatgpt.models.length, 2);
  assert.match(buildToolConfigFieldListMarkup({ fields: [{ key: 'subagents', label: 'Subagents', default: true, fieldType: 'toggle', storage: 'config' }] }), /data-subagent-routing-host/);
  cleanup.forEach((fn) => fn()); binders.dispose();
});

test('production renderer navigation loads routing controls and saves through the feature bridge', async (t) => {
  const { loadRendererApp, waitForUi, openSettingsView } = require('./helpers/renderer-shell-harness');
  let features = { subagentRouting: normalizeSubagentRouting(), subagentModelCatalogs: {
    chatgpt: { available: true, models: [{ id: 'gpt-6-astra', label: 'Astra', reasoning_efforts: ['low', 'high'] }] },
    'codex-cli': { available: false, models: [] },
  } };
  const writes = [];
  const app = await loadRendererApp({ shell: { features: {
    async getState() { return features; },
    async updateSettings(patch) {
      writes.push(patch);
      features = { ...features, subagentRouting: applySubagentRoutingPatch(features.subagentRouting, patch.subagentRouting) };
      return features;
    },
  } } });
  t.after(() => app.dispose());
  await openSettingsView(app.window);
  app.window.document.getElementById('settingsNav-tools').click();
  await waitForUi(app.window, 60);
  const model = app.window.document.getElementById('subagent-model');
  assert.ok(model, 'Tools navigation mounts the lazy routing controller');
  model.value = 'gpt-6-astra';
  model.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  app.window.document.querySelector('[data-subagent-action="save"]').click();
  await waitForUi(app.window, 40);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].subagentRouting.chatgpt.defaultModel, 'gpt-6-astra');
  assert.equal(app.window.__rendererState.features.subagentRouting.chatgpt.defaultModel, 'gpt-6-astra');
});


test('owner limits survive feature normalization, save, and tool disablement', async () => {
  const h = harness(); await settle();
  h.change('allowed', 'luna'); h.change('maximum', 'low');
  h.click('save'); await settle();
  const row = normalizeFeatureState(h.getFeatures()).subagentRouting.chatgpt;
  assert.deepEqual(row.allowedModels, ['luna']); assert.equal(row.maxEffort, 'low');
  h.getFeatures().tools = { subagents: false }; sync(h.container);
  assert.ok([...h.container.querySelectorAll('select,button')].every((el) => el.disabled));
  const count = h.writes.length; await h.controller.save(); assert.equal(h.writes.length, count);
  h.controller.dispose();
});

test('malicious labels are escaped and stale defaults explain automatic fallback', async () => {
  const h = harness({ catalogs: { chatgpt: { models: [{ id: 'astra', label: '<img src=x onerror=alert(1)>', reasoning_efforts: ['low'] }] } } });
  await settle(); assert.equal(h.container.querySelector('img'), null);
  h.getFeatures().subagentRouting.chatgpt.defaultModel = 'missing'; sync(h.container);
  assert.match(h.container.textContent, /Saved default is no longer available/);
  assert.equal(h.container.querySelector('#subagent-model').value, 'missing');
  h.controller.dispose();
});

test('stable action IDs preserve keyboard focus and the persistent status node', async () => {
  const h = harness(); await settle();
  h.change('provider', 'codex-cli'); h.change('preferred', 'codex-cli/default');
  let button = h.container.querySelector('[data-subagent-action=remove]');
  assert.ok(button.id); assert.equal(h.windowRef.document.getElementById(button.id), button);
  h.change('provider', 'chatgpt'); h.change('preferred', 'astra'); h.change('preferred', 'luna');
  button = h.container.querySelector('[data-subagent-action=up][data-index="1"]'); button.focus(); button.click();
  assert.notEqual(h.windowRef.document.activeElement, h.windowRef.document.body);
  const status = h.container.querySelector('[role=status]');
  h.change('model', 'astra'); button = h.container.querySelector('[data-subagent-action=save]'); button.focus();
  h.click('save'); await settle();
  assert.ok(h.container.contains(h.windowRef.document.activeElement));
  assert.equal(h.container.querySelector('[role=status]'), status);
  assert.match(status.textContent, /Routing saved/);
  const refresh = h.container.querySelector('[data-subagent-action=refresh]'); refresh.focus(); refresh.click(); await settle();
  assert.equal(h.windowRef.document.activeElement.id, refresh.id);
  h.controller.dispose();
});

test('double binding and disposed listeners do not duplicate or persist writes', async () => {
  const h = harness(); await settle(); h.controller.bind();
  h.change('model', 'astra'); h.click('save'); await settle(); assert.equal(h.writes.length, 1);
  h.change('model', 'luna'); h.controller.dispose();
  h.click('save'); await settle(); assert.equal(h.writes.length, 1);
});


test('delayed Settings actions do not steal focus after the user moves elsewhere', async () => {
  for (const action of ['save', 'refresh']) {
    let resolve;
    const pending = new Promise((done) => { resolve = done; });
    const h = harness({ delay: action === 'save' ? pending : undefined });
    await settle();
    if (action === 'save') h.change('model', 'astra');
    else h.windowRef.jennyShell.features.getState = async () => { await pending; return h.getFeatures(); };
    const button = h.container.querySelector(`[data-subagent-action=${action}]`);
    button.focus(); button.click();
    const outside = h.windowRef.document.createElement('button');
    h.windowRef.document.body.append(outside); outside.focus();
    resolve(); await settle();
    assert.equal(h.windowRef.document.activeElement, outside, action);
    h.controller.dispose();
  }
});
