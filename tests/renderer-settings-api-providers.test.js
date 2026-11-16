'use strict';

// Settings > Models API-key providers (row 78): one row per provider under Cloud providers in
// Engines and providers, the editor in its Manage drawer, the write-only key and the enable list.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createApiProvidersController } = require('../renderer/shell/renderer-settings-api-providers.js');
const { formatTokens, formatUsd, errorText } = require('../renderer/shell/renderer-settings-api-providers-view.js');
const servicesModule = require('../renderer/shell/model-library/model-library-services');

const KEY = 'synthetic-renderer-key-0001';

function inventoryFixture() {
  return {
    settingsField: require('../renderer/inventory/settings-field'),
    actionButton: require('../renderer/inventory/action-button'),
    badge: require('../renderer/inventory/badge'),
    checkbox: require('../renderer/inventory/checkbox').checkbox,
  };
}

function limits(overrides = {}) {
  return {
    context_length: 262144, max_output_tokens: 32768, tools: true, vision: false, reasoning: true,
    sources: { context_length: 'catalog', max_output_tokens: 'catalog', tools: 'catalog', vision: 'catalog', reasoning: 'catalog' },
    ...overrides,
  };
}

function instance(overrides = {}) {
  const { hasKey = true, models, error = null, fetchedAt = '2026-10-25T10:00:00.000Z', ...rest } = overrides;
  return {
    id: 'openrouter', presetId: 'openrouter', label: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1',
    transport: 'openai_chat_completions_v1', authProfile: 'api_key_bearer', hasKey, noticeAcknowledgedAt: null,
    models: models || [
      { id: 'qwen/qwen4', enabled: true, pin: {}, limits: limits(), costPerMtokUsd: { input: 0.2, output: 0.8 } },
      { id: 'zeta/unknown', enabled: false, pin: {}, limits: limits({ context_length: 32768, sources: { context_length: 'fallback' } }) },
    ],
    discovery: { fetchedAt, error, rows: [] },
    ...rest,
  };
}

function providerState({ localOnly = false, instances, ...instanceOptions } = {}) {
  return {
    enabled: true,
    localOnly,
    maxInstances: 16,
    presets: [{ id: 'openrouter', label: 'OpenRouter' }, { id: 'groq', label: 'Groq' }],
    instances: instances || [instance(instanceOptions)],
  };
}

function recordingBridge(initial) {
  const calls = [];
  let listener = null;
  let state = initial;
  const reply = (name, result = { ok: true }) => async (payload) => {
    calls.push([name, payload]);
    return result;
  };
  return {
    calls,
    push(next) { state = next; listener?.(next); },
    bridge: {
      async getState() { return state; },
      onChanged(fn) { listener = fn; return () => { listener = null; }; },
      setKey: reply('setKey'),
      clearKey: reply('clearKey'),
      discover: reply('discover'),
      setModelEnabled: reply('setModelEnabled'),
      setModelPin: reply('setModelPin'),
      renameInstance: reply('renameInstance'),
      removeInstance: reply('removeInstance'),
      addInstance: reply('addInstance', { ok: true, instanceId: 'groq' }),
    },
  };
}

function harness(t, state) {
  const dom = new JSDOM('<!doctype html><body><div id="modelServicesHost"></div></body>', { pretendToBeVisual: true, url: 'http://localhost/' });
  dom.window.inventoryTextField = require('../renderer/inventory/text-field');
  dom.window.inventorySelectField = require('../renderer/inventory/select-field');
  const doc = dom.window.document;
  const services = servicesModule.createModelLibraryServices({ documentRef: doc, windowRef: dom.window });
  const recorder = recordingBridge(state);
  let composerRefreshes = 0;
  const controller = createApiProvidersController({
    windowRef: dom.window, documentRef: doc, inventory: inventoryFixture(), services: () => services,
    getBridge: () => recorder.bridge, refreshComposerModels: () => { composerRefreshes += 1; },
  });
  t.after(() => { controller.dispose(); services.dispose(); dom.window.close(); });
  return {
    dom, doc, services, controller, recorder, composerRefreshes: () => composerRefreshes,
    // Opens a provider's drawer; the drawer body is the host every control is read from.
    open(id = 'api:openrouter') {
      assert.equal(services.open(id), true, `${id} opens`);
      return services.drawerBody();
    },
  };
}

async function settle() {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function click(dom, element) {
  element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

function action(host, name) {
  return host.querySelector(`[data-action="${name}"]`);
}

const ids = (doc) => [...doc.querySelectorAll('#modelServicesHost .srow[data-service-id]')].map((node) => node.dataset.serviceId);
const row = (doc, id) => doc.querySelector(`#modelServicesHost .srow[data-service-id="${id}"]`);
const status = (doc, id) => row(doc, id).querySelector('.srow-status span:last-child').textContent;
const summary = (doc) => doc.querySelector('#modelServicesHost [data-service-summary="cloud"]')?.textContent;

test('each provider is its own row with its host and model count, and Add provider stays last and uncounted', async (t) => {
  const h = harness(t, providerState());
  h.controller.bind();
  await settle();
  assert.deepEqual(ids(h.doc), ['api:openrouter', 'api-add']);
  const provider = row(h.doc, 'api:openrouter');
  assert.equal(provider.querySelector('.mrow-name').textContent, 'OpenRouter');
  assert.equal(provider.querySelector('.mrow-meta').textContent, 'openrouter.ai');
  assert.equal(status(h.doc, 'api:openrouter'), 'Connected · 1 model');
  assert.equal(provider.querySelector('.mp-dot').dataset.tone, 'ready');
  assert.equal(provider.querySelector('button').textContent, 'Manage');
  const add = row(h.doc, 'api-add');
  assert.equal(add.querySelector('.mrow-name').textContent, 'Add provider');
  assert.equal(add.querySelector('.mrow-meta').textContent, 'Your own key, or any compatible endpoint');
  assert.equal(status(h.doc, 'api-add'), '1 added');
  assert.equal(add.querySelector('button').textContent, 'Add…');
  assert.equal(summary(h.doc), '1 ready', 'the add row is not counted');
  h.recorder.push(providerState({ models: [] }));
  await settle();
  assert.equal(status(h.doc, 'api:openrouter'), 'Connected · 0 models');
});

test('a provider row says what is wrong: no key, a failed load, Force local inference', async (t) => {
  const noKey = harness(t, providerState({ hasKey: false, fetchedAt: null, models: [] }));
  noKey.controller.bind();
  await settle();
  assert.equal(status(noKey.doc, 'api:openrouter'), 'Add a key to use it');
  assert.equal(row(noKey.doc, 'api:openrouter').querySelector('.mp-dot').dataset.tone, 'warn');
  assert.equal(row(noKey.doc, 'api:openrouter').querySelector('button').textContent, 'Manage', 'an existing provider is always Manage');

  const failed = harness(t, providerState({ error: { code: 'unauthorized', status: 401 } }));
  failed.controller.bind();
  await settle();
  assert.match(status(failed.doc, 'api:openrouter'), /OpenRouter refused the key \(401\)/);
  assert.equal(row(failed.doc, 'api:openrouter').querySelector('.mp-dot').dataset.tone, 'warn');

  const local = harness(t, providerState({ localOnly: true }));
  local.controller.bind();
  await settle();
  assert.equal(status(local.doc, 'api:openrouter'), 'Blocked by Force local inference');
  assert.match(local.open().textContent, /Force local inference is on, so this provider will not run/);
});

test('with no provider the add row reads None added; adding and removing providers moves the rows', async (t) => {
  const h = harness(t, providerState({ instances: [] }));
  h.controller.bind();
  await settle();
  assert.deepEqual(ids(h.doc), ['api-add']);
  assert.equal(status(h.doc, 'api-add'), 'None added');
  assert.equal(h.doc.querySelector('#modelServicesHost [data-service-summary="cloud"]').textContent, 'None set up');
  h.recorder.push(providerState({ instances: [instance(), instance({ id: 'groq', presetId: 'groq', label: 'Groq', endpoint: 'https://api.groq.com/openai/v1' })] }));
  await settle();
  assert.deepEqual(ids(h.doc), ['api:openrouter', 'api:groq', 'api-add']);
  h.recorder.push(providerState({ instances: [instance({ id: 'groq', presetId: 'groq', label: 'Groq', endpoint: 'https://api.groq.com/openai/v1' })] }));
  await settle();
  assert.deepEqual(ids(h.doc), ['api:groq', 'api-add']);
});

test('the drawer holds the editor under the provider name; a saved key is never shown', async (t) => {
  const h = harness(t, providerState());
  h.controller.bind();
  await settle();
  const body = h.open();
  assert.equal(h.doc.querySelector('#modelServicesDrawer .inv-drawer-header h2').textContent, 'OpenRouter');
  assert.ok(body.querySelector('#apiProvidersDrawerHost[data-api-provider-instance="openrouter"]'));
  assert.equal(body.querySelector('[data-api-provider-editor]'), null, 'no in-place toggle row any more');
  assert.equal(body.querySelector('[data-api-provider-name]').value, 'OpenRouter');
  assert.equal(body.querySelector('[data-api-provider-key]'), null);
  assert.ok(action(body, 'apiProvidersReplaceKey'));
  assert.equal(h.doc.querySelector('#modelServicesHost [data-action]'), null, 'the table rows carry no editor control');
});

test('the enable list shows limits with their source, cost, and enabled models first', async (t) => {
  const h = harness(t, providerState());
  h.controller.bind();
  await settle();
  const host = h.open();
  const rows = [...host.querySelectorAll('[data-api-model]')].map((node) => node.getAttribute('data-api-model'));
  assert.deepEqual(rows, ['qwen/qwen4', 'zeta/unknown']);
  const first = host.querySelector('[data-api-model="qwen/qwen4"]');
  assert.match(first.textContent, /262K context/);
  assert.match(first.textContent, /\$0\.20 in \/ \$0\.80 out per 1M tokens/);
  assert.equal(first.querySelector('[data-source]').getAttribute('data-source'), 'catalog');
  assert.match(first.querySelector('[data-source]').getAttribute('title'), /models\.dev/);
  const fallback = host.querySelector('[data-api-model="zeta/unknown"] [data-source]');
  assert.equal(fallback.getAttribute('data-source'), 'fallback');
  assert.match(host.textContent, /1 of 2 in Composer/);
});

test('a key goes out once through setKey and the field is cleared', async (t) => {
  const h = harness(t, providerState({ hasKey: false, fetchedAt: null, models: [] }));
  h.controller.bind();
  await settle();
  const host = h.open();
  const field = host.querySelector('[data-api-provider-key="openrouter"]');
  assert.equal(field.type, 'password');
  field.value = `  ${KEY}  `;
  click(h.dom, action(host, 'apiProvidersSaveKey'));
  await settle();
  assert.deepEqual(h.recorder.calls[0], ['setKey', { instanceId: 'openrouter', key: KEY }]);
  // Nothing listed yet: a fresh key loads the list straight away.
  assert.deepEqual(h.recorder.calls[1], ['discover', { instanceId: 'openrouter' }]);
  assert.ok(!h.doc.body.innerHTML.includes(KEY));
  assert.ok(!JSON.stringify(h.controller.ui).includes(KEY));
});

test('Save key while another action runs keeps the pasted key in the field', async (t) => {
  const h = harness(t, providerState({ hasKey: false, fetchedAt: null, models: [] }));
  let release = null;
  h.recorder.bridge.setKey = (payload) => { h.recorder.calls.push(['setKey', payload]); return new Promise((resolve) => { release = resolve; }); };
  h.controller.bind();
  await settle();
  const host = h.open();
  host.querySelector('[data-api-provider-key="openrouter"]').value = KEY;
  click(h.dom, action(host, 'apiProvidersSaveKey'));
  await settle();
  const field = host.querySelector('[data-api-provider-key="openrouter"]');
  field.value = 'second-key';
  click(h.dom, action(host, 'apiProvidersSaveKey'));
  await settle();
  assert.equal(field.value, 'second-key');
  assert.equal(h.recorder.calls.filter(([name]) => name === 'setKey').length, 1);
  release({ ok: false, code: 'storage_unavailable' });
  await settle();
});

test('toggling a model and adding one by id call the main process', async (t) => {
  const h = harness(t, providerState());
  h.controller.bind();
  await settle();
  const host = h.open();
  const toggle = host.querySelector('[data-api-model-toggle="zeta/unknown"]');
  toggle.checked = true;
  toggle.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
  await settle();
  assert.deepEqual(h.recorder.calls.at(-1), ['setModelEnabled', { instanceId: 'openrouter', modelId: 'zeta/unknown', enabled: true }]);
  host.querySelector('[data-api-provider-add-model="openrouter"]').value = 'mistral/large-4';
  click(h.dom, action(host, 'apiProvidersAddModel'));
  await settle();
  assert.deepEqual(h.recorder.calls.at(-1), ['setModelEnabled', { instanceId: 'openrouter', modelId: 'mistral/large-4', enabled: true }]);
});

test('Limits… opens the pin row and Pin sends whole-number limits', async (t) => {
  const h = harness(t, providerState());
  h.controller.bind();
  await settle();
  const host = h.open();
  click(h.dom, host.querySelector('[data-action="apiProvidersLimits"][data-model="zeta/unknown"]'));
  host.querySelector('#apiProvidersPinContext').value = '65536';
  host.querySelector('#apiProvidersPinOutput').value = 'abc';
  click(h.dom, action(host, 'apiProvidersSavePin'));
  await settle();
  assert.deepEqual(h.recorder.calls.at(-1), ['setModelPin', {
    instanceId: 'openrouter', modelId: 'zeta/unknown', pin: { contextLength: 65536, maxOutputTokens: undefined },
  }]);
});

test('a failed load keeps the list and says why without provider text', async (t) => {
  const h = harness(t, providerState({ error: { code: 'unauthorized', status: 401 } }));
  h.controller.bind();
  await settle();
  const host = h.open();
  const alert = [...host.querySelectorAll('[role="alert"]')].find((node) => node.textContent.trim());
  assert.match(alert.textContent, /OpenRouter refused the key \(401\)/);
  assert.match(alert.textContent, /last successful load/);
  assert.equal(host.querySelectorAll('[data-api-model]').length, 2);
});

test('search filters rows without a repaint and keeps the typed text across a push', async (t) => {
  const many = Array.from({ length: 8 }, (_, index) => ({ id: `org/model-${index}`, enabled: false, pin: {}, limits: limits() }));
  const h = harness(t, providerState({ models: many }));
  h.controller.bind();
  await settle();
  const host = h.open();
  const search = host.querySelector('[data-api-provider-search]');
  search.value = 'model-3';
  search.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
  const visible = [...host.querySelectorAll('[data-api-model]')].filter((node) => !node.hidden);
  assert.deepEqual(visible.map((node) => node.getAttribute('data-api-model')), ['org/model-3']);
  search.focus();
  h.recorder.push(providerState({ models: many }));
  await settle();
  const after = host.querySelector('[data-api-provider-search]');
  assert.equal(after.value, 'model-3');
  assert.equal(h.doc.activeElement, after);
  assert.equal([...host.querySelectorAll('[data-api-model]')].filter((node) => !node.hidden).length, 1);
  assert.equal(h.composerRefreshes(), 1);
});

test('remove asks once more, and removing the provider takes its row and drawer away', async (t) => {
  const h = harness(t, providerState());
  h.controller.bind();
  await settle();
  const host = h.open();
  click(h.dom, action(host, 'apiProvidersRemoveAsk'));
  assert.equal(h.recorder.calls.length, 0);
  assert.match(host.textContent, /Remove OpenRouter\?/);
  click(h.dom, action(host, 'apiProvidersRemoveConfirm'));
  await settle();
  assert.deepEqual(h.recorder.calls.at(-1), ['removeInstance', { instanceId: 'openrouter' }]);
  h.recorder.push(providerState({ instances: [] }));
  await settle();
  assert.deepEqual(ids(h.doc), ['api-add']);
  assert.equal(h.services.openId(), null, 'the drawer of a removed provider closes');
});

test('a custom endpoint draft offers only the sign-in each API format admits', async (t) => {
  const h = harness(t, providerState({ instances: [] }));
  h.controller.bind();
  await settle();
  const host = h.open('api-add');
  assert.equal(h.doc.querySelector('#modelServicesDrawer .inv-drawer-header h2').textContent, 'Add a provider');
  assert.ok(host.querySelector('#apiProvidersDrawerHost[data-api-provider-add]'));
  const preset = host.querySelector('[data-api-provider-preset]');
  preset.value = 'custom';
  preset.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
  click(h.dom, action(host, 'apiProvidersAdd'));
  const format = host.querySelector('[data-api-custom="transport"]');
  format.value = 'anthropic_messages_v1';
  format.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
  const auth = host.querySelector('[data-api-custom="authProfile"]');
  assert.deepEqual([...auth.options].map((option) => option.value), ['api_key_header']);
  for (const [field, value] of [['label', 'Gateway'], ['endpoint', 'https://gw.example.com/v1']]) {
    const input = host.querySelector(`[data-api-custom="${field}"]`);
    input.value = value;
    input.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
  }
  click(h.dom, action(host, 'apiProvidersCustomSubmit'));
  await settle();
  assert.deepEqual(h.recorder.calls.at(-1), ['addInstance', {
    presetId: 'custom', label: 'Gateway', endpoint: 'https://gw.example.com/v1',
    transport: 'anthropic_messages_v1', authProfile: 'api_key_header',
  }]);
});

test('after a provider is added the add drawer closes and the new provider opens with its key field focused', async (t) => {
  const h = harness(t, providerState({ instances: [] }));
  h.controller.bind();
  await settle();
  const host = h.open('api-add');
  // The main process pushes the new state before the reply resolves.
  h.recorder.bridge.addInstance = async (payload) => {
    h.recorder.calls.push(['addInstance', payload]);
    h.recorder.push(providerState({ instances: [instance({ id: 'groq', presetId: 'groq', label: 'Groq', endpoint: 'https://api.groq.com/openai/v1', hasKey: false, fetchedAt: null, models: [] })] }));
    return { ok: true, instanceId: 'groq' };
  };
  host.querySelector('[data-api-provider-preset]').value = 'groq';
  host.querySelector('[data-api-provider-preset]').dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
  click(h.dom, action(host, 'apiProvidersAdd'));
  await settle();
  assert.deepEqual(h.recorder.calls.at(-1), ['addInstance', { presetId: 'groq' }]);
  assert.equal(h.services.openId(), 'api:groq');
  assert.equal(h.doc.querySelector('#modelServicesDrawer .inv-drawer-header h2').textContent, 'Groq');
  const key = h.services.drawerBody().querySelector('[data-api-provider-key="groq"]');
  assert.equal(h.doc.activeElement, key);
});

test('the feature turned off registers no rows; at the limit the add drawer says so', async (t) => {
  const off = harness(t, { ...providerState(), enabled: false });
  off.controller.bind();
  await settle();
  assert.deepEqual(ids(off.doc), []);

  const full = harness(t, { ...providerState(), maxInstances: 1 });
  full.controller.bind();
  await settle();
  assert.match(full.open('api-add').textContent, /most providers Jenny can hold/);
  assert.equal(full.services.drawerBody().querySelector('[data-api-provider-preset]'), null);
});

test('the controller registers when the services module announces itself, and dispose removes its rows', async (t) => {
  const dom = new JSDOM('<!doctype html><body><div id="modelServicesHost"></div></body>', { pretendToBeVisual: true, url: 'http://localhost/' });
  const doc = dom.window.document;
  const controller = createApiProvidersController({
    windowRef: dom.window, documentRef: doc, inventory: inventoryFixture(), getBridge: () => recordingBridge(providerState()).bridge,
  });
  controller.bind();
  await settle();
  assert.deepEqual(ids(doc), []);
  dom.window.modelLibraryServices = servicesModule;
  const services = servicesModule.shared({ documentRef: doc, windowRef: dom.window });
  t.after(() => services.dispose());
  doc.dispatchEvent(new dom.window.CustomEvent(servicesModule.READY_EVENT));
  await settle();
  assert.deepEqual(ids(doc), ['api:openrouter', 'api-add']);
  controller.dispose();
  await settle();
  assert.deepEqual(ids(doc), []);
});

test('formatters and coded errors', () => {
  assert.equal(formatTokens(1048576), '1M');
  assert.equal(formatTokens(1050000), '1.1M');
  assert.equal(formatTokens(262144), '262K');
  assert.equal(formatUsd(0.2), '$0.20');
  assert.equal(formatUsd(0.075), '$0.075');
  assert.equal(formatUsd(15), '$15.00');
  assert.match(errorText('redirect_refused', 'Groq'), /Groq tried to redirect/);
  assert.match(errorText('no_such_code'), /could not complete/);
});
