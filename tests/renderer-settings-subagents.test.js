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
function harness({ fail = false, catalogs, delay, routing } = {}) {
  const dom = new JSDOM('<div id="toolsConfigFieldList"><div data-subagent-routing-host></div></div>');
  let features = { subagentRouting: normalizeSubagentRouting(routing), subagentModelCatalogs: catalogs || {
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

test('every change saves as it is made: effort, ordered preferences, provider switching and reset', async () => {
  const h = harness({ routing: { chatgpt: { defaultModel: 'astra' } } });
  await settle();
  assert.equal(h.container.querySelector('#subagent-model'), null, 'the default model moved to Settings > Models');
  assert.equal(h.container.querySelector('[data-subagent-action="save"]'), null, 'there is no Save routing button');
  assert.deepEqual([...h.container.querySelector('#subagent-effort').options].map((row) => row.value), ['', 'low', 'high']);
  h.change('effort', 'high');
  await settle();
  assert.deepEqual(h.writes[0], { subagentRouting: { chatgpt: { defaultModel: 'astra', defaultEffort: 'high', preferredModels: [], allowedModels: [], maxEffort: '' } } });
  h.change('preferred', 'astra'); await settle();
  h.change('preferred', 'luna'); await settle();
  h.click('up', 1); await settle();
  assert.deepEqual(h.writes.at(-1).subagentRouting.chatgpt.preferredModels, ['luna', 'astra']);
  const count = h.writes.length;
  h.change('provider', 'codex-cli');
  await settle();
  assert.equal(h.writes.length, count, 'switching the provider writes nothing');
  assert.equal(h.container.querySelector('#subagent-provider').value, 'codex-cli');
  h.change('maximum', 'low'); await settle();
  assert.deepEqual(h.writes.at(-1).subagentRouting['codex-cli'].maxEffort, 'low');
  h.change('provider', 'chatgpt');
  assert.equal(h.container.querySelector('#subagent-effort').value, 'high');
  h.click('reset');
  await settle();
  assert.deepEqual(h.getFeatures().subagentRouting.chatgpt, normalizeSubagentRouting().chatgpt);
  assert.equal(h.getFeatures().subagentRouting['codex-cli'].maxEffort, 'low');
  h.controller.dispose();
});

test('Tools keeps the switch, then a read-only Helper models row that names the helper model and links to Models', async () => {
  const h = harness({ routing: { chatgpt: { defaultModel: 'luna' } } });
  await settle();
  const pointer = h.container.querySelector('.roles-pointer');
  assert.equal(h.container.querySelector('[data-subagent-routing-host] .settings-field'), pointer, 'first row of the routing host');
  assert.equal(pointer.querySelector('.settings-field-title').textContent, 'Helper models');
  assert.equal(pointer.querySelector('.settings-field-help').textContent, 'ChatGPT chats hand side work to Luna.');
  assert.equal(pointer.querySelector('[data-open-model-roles]').textContent, 'Change in Models');
  const provider = h.container.querySelector('[data-settings-field="subagent-routing-provider"]');
  assert.equal(provider.querySelector('.settings-field-title').textContent, 'Limits for');
  assert.equal(provider.querySelector('.settings-field-help').textContent, 'These apply to helpers under this provider. Changes save as you make them.');
  h.change('provider', 'codex-cli');
  assert.equal(h.container.querySelector('.roles-pointer .settings-field-help').textContent, 'Codex CLI chats hand side work to the same model as the chat.');
  assert.deepEqual([...h.container.querySelectorAll('[data-settings-field] .settings-field-title')].map((el) => el.textContent).slice(0, 6),
    ['Helper models', 'Limits for', 'Default effort', 'Preferred models in order', 'Allowed models', 'Maximum effort']);
  assert.deepEqual([...h.container.querySelectorAll('[data-subagent-action]')].map((el) => el.dataset.subagentAction), ['reset', 'refresh']);
  h.controller.dispose();
});

test('Change in Models opens Settings > Models', async () => {
  const h = harness();
  await settle();
  const doc = h.windowRef.document;
  doc.body.insertAdjacentHTML('beforeend', '<button id="settingsNav-models"></button>');
  let opened = 0;
  doc.getElementById('settingsNav-models').addEventListener('click', () => { opened += 1; });
  h.container.querySelector('[data-open-model-roles]').click();
  assert.equal(opened, 1);
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
  h.change('maximum', 'low');
  await settle();
  finishRefresh(stale);
  await refreshing;
  assert.equal(h.getFeatures().subagentRouting.chatgpt.maxEffort, 'low');
  assert.equal(h.container.querySelector('#subagent-maximum').value, 'low');
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
  stale.container.querySelector('#subagent-maximum').focus();
  sync(stale.container);
  assert.equal(stale.windowRef.document.activeElement.id, 'subagent-maximum');
  stale.change('provider', 'codex-cli');
  assert.match(stale.container.textContent, /provider is unavailable/);
  stale.controller.dispose();
});

test('a failed save restores the earlier value and says so in that row; a late completion after disposal cannot repaint', async () => {
  const h = harness({ fail: true });
  await settle(); h.change('maximum', 'low'); await settle();
  assert.equal(h.container.querySelector('#subagent-maximum').value, '');
  const row = h.container.querySelector('[data-settings-field="subagent-routing-maximum"] .settings-field-error');
  assert.equal(row.hidden, false);
  assert.equal(row.textContent, 'Could not save this change. The earlier value is restored.');
  assert.equal(h.container.querySelector('[data-settings-field="subagent-routing-effort"] .settings-field-error').hidden, true);
  h.controller.dispose();
  let resolve;
  const delayed = harness({ delay: new Promise((done) => { resolve = done; }) });
  await settle(); delayed.change('maximum', 'low');
  delayed.change('maximum', 'high');
  assert.equal(delayed.writes.length, 1, 'a change while a save is in flight is not sent');
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
  assert.ok(h.container.querySelector('#subagent-maximum'));
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
  const maximum = app.window.document.getElementById('subagent-maximum');
  assert.ok(maximum, 'Tools navigation mounts the lazy routing controller');
  maximum.value = 'low';
  maximum.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  await waitForUi(app.window, 40);
  assert.equal(writes.length, 1, 'the change saves without a Save button');
  assert.equal(writes[0].subagentRouting.chatgpt.maxEffort, 'low');
  assert.equal(app.window.__rendererState.features.subagentRouting.chatgpt.maxEffort, 'low');
});


test('owner limits survive feature normalization, save, and tool disablement', async () => {
  const h = harness(); await settle();
  h.change('allowed', 'luna'); await settle(); h.change('maximum', 'low'); await settle();
  const row = normalizeFeatureState(h.getFeatures()).subagentRouting.chatgpt;
  assert.deepEqual(row.allowedModels, ['luna']); assert.equal(row.maxEffort, 'low');
  h.getFeatures().tools = { subagents: false }; sync(h.container);
  assert.ok([...h.container.querySelectorAll('select,button:not([data-open-model-roles])')].every((el) => el.disabled), 'the link to Models stays usable');
  const count = h.writes.length; await h.controller.save(normalizeSubagentRouting().chatgpt, 'subagent-routing-actions'); assert.equal(h.writes.length, count);
  h.controller.dispose();
});

test('malicious labels are escaped and stale defaults explain automatic fallback', async () => {
  const h = harness({ catalogs: { chatgpt: { models: [{ id: 'astra', label: '<img src=x onerror=alert(1)>', reasoning_efforts: ['low'] }] } } });
  await settle(); assert.equal(h.container.querySelector('img'), null);
  h.getFeatures().subagentRouting.chatgpt.defaultModel = 'astra'; sync(h.container);
  assert.equal(h.container.querySelector('img'), null, 'the helper model is named in the pointer row, escaped');
  assert.match(h.container.querySelector('.roles-pointer .settings-field-help').textContent, /<img src=x onerror=alert\(1\)>/);
  h.getFeatures().subagentRouting.chatgpt.defaultModel = 'missing'; sync(h.container);
  assert.match(h.container.textContent, /Saved default is no longer available/);
  h.controller.dispose();
});

test('stable action IDs preserve keyboard focus and the persistent status node', async () => {
  const h = harness(); await settle();
  h.change('provider', 'codex-cli'); h.change('preferred', 'codex-cli/default'); await settle();
  let button = h.container.querySelector('[data-subagent-action=remove]');
  assert.ok(button.id); assert.equal(h.windowRef.document.getElementById(button.id), button);
  h.change('provider', 'chatgpt'); h.change('preferred', 'astra'); await settle(); h.change('preferred', 'luna'); await settle();
  button = h.container.querySelector('[data-subagent-action=up][data-index="1"]'); button.focus(); button.click(); await settle();
  assert.notEqual(h.windowRef.document.activeElement, h.windowRef.document.body);
  const status = h.container.querySelector('[role=status]');
  h.change('maximum', 'low'); await settle();
  assert.equal(h.container.querySelector('[role=status]'), status);
  assert.match(status.textContent, /Routing saved/);
  const refresh = h.container.querySelector('[data-subagent-action=refresh]'); refresh.focus(); refresh.click(); await settle();
  assert.equal(h.windowRef.document.activeElement.id, refresh.id);
  h.controller.dispose();
});

test('double binding and disposed listeners do not duplicate or persist writes', async () => {
  const h = harness(); await settle(); h.controller.bind();
  h.change('maximum', 'low'); await settle(); assert.equal(h.writes.length, 1);
  h.controller.dispose();
  h.change('maximum', 'high'); await settle(); assert.equal(h.writes.length, 1);
});


test('delayed Settings actions do not steal focus after the user moves elsewhere', async () => {
  for (const action of ['save', 'refresh']) {
    let resolve;
    const pending = new Promise((done) => { resolve = done; });
    const h = harness({ delay: action === 'save' ? pending : undefined });
    await settle();
    if (action !== 'save') h.windowRef.jennyShell.features.getState = async () => { await pending; return h.getFeatures(); };
    const button = h.container.querySelector(action === 'save' ? '#subagent-maximum' : `[data-subagent-action=${action}]`);
    button.focus();
    if (action === 'save') h.change('maximum', 'low'); else button.click();
    const outside = h.windowRef.document.createElement('button');
    h.windowRef.document.body.append(outside); outside.focus();
    resolve(); await settle();
    assert.equal(h.windowRef.document.activeElement, outside, action);
    h.controller.dispose();
  }
});

test('the provider select offers API providers and saves a namespaced allowed model', async () => {
  const full = 'api-provider/anthropic-api/claude-sonnet-5-5';
  const h = harness({ catalogs: {
    chatgpt: { available: false, models: [] },
    'api-provider': { available: true, stale: false, models: [
      { id: full, label: 'Anthropic API · claude-sonnet-5-5', reasoning_efforts: ['default', 'low', 'high'] }] },
  }, routing: { 'api-provider': { defaultModel: full } } });
  await settle();
  const options = [...h.container.querySelector('#subagent-provider').options].map((row) => row.value);
  assert.deepEqual(options, ['chatgpt', 'codex-cli', 'api-provider']);
  h.change('provider', 'api-provider');
  assert.equal(h.container.querySelector('.roles-pointer .settings-field-help').textContent, 'API providers chats hand side work to Anthropic API · claude-sonnet-5-5.');
  h.change('effort', 'low');
  await settle();
  assert.deepEqual(h.writes[0].subagentRouting['api-provider'],
    { defaultModel: full, defaultEffort: 'low', preferredModels: [], allowedModels: [], maxEffort: '' });
  assert.equal(h.getFeatures().subagentRouting['api-provider'].defaultModel, full);
  assert.equal(normalizeFeatureState({ subagentRouting: { 'api-provider': { defaultModel: full } } }).subagentRouting['api-provider'].defaultModel, full);
  h.controller.dispose();
});
