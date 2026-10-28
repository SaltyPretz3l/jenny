'use strict';

// Settings > Models API-key providers (row 78, variant A): rows inside Cloud
// models, the editor in place, the write-only key and the enable list.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createApiProvidersController } = require('../renderer/shell/renderer-settings-api-providers.js');
const { formatTokens, formatUsd, errorText } = require('../renderer/shell/renderer-settings-api-providers-view.js');

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

function providerState({ hasKey = true, models, error = null, fetchedAt = '2026-10-25T10:00:00.000Z', localOnly = false } = {}) {
  return {
    enabled: true,
    localOnly,
    maxInstances: 16,
    presets: [{ id: 'openrouter', label: 'OpenRouter' }, { id: 'groq', label: 'Groq' }],
    instances: [{
      id: 'openrouter', presetId: 'openrouter', label: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1',
      transport: 'openai_chat_completions_v1', authProfile: 'api_key_bearer', hasKey, noticeAcknowledgedAt: null,
      models: models || [
        { id: 'qwen/qwen4', enabled: true, pin: {}, limits: limits(), costPerMtokUsd: { input: 0.2, output: 0.8 } },
        { id: 'zeta/unknown', enabled: false, pin: {}, limits: limits({ context_length: 32768, sources: { context_length: 'fallback' } }) },
      ],
      discovery: { fetchedAt, error, rows: [] },
    }],
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

function harness(state) {
  const dom = new JSDOM('<!doctype html><div id="apiProvidersHost"></div>', { pretendToBeVisual: true, url: 'http://localhost/' });
  dom.window.inventoryTextField = require('../renderer/inventory/text-field');
  dom.window.inventorySelectField = require('../renderer/inventory/select-field');
  const host = dom.window.document.getElementById('apiProvidersHost');
  const recorder = recordingBridge(state);
  let composerRefreshes = 0;
  const controller = createApiProvidersController({
    windowRef: dom.window, documentRef: dom.window.document, host, inventory: inventoryFixture(),
    getBridge: () => recorder.bridge, refreshComposerModels: () => { composerRefreshes += 1; },
  });
  return { dom, host, controller, recorder, composerRefreshes: () => composerRefreshes };
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

test('a provider row reads status only and the editor opens in place under it', async () => {
  const { dom, host, controller } = harness(providerState());
  controller.bind();
  await settle();
  const row = () => host.querySelector('[data-api-provider="openrouter"]');
  assert.match(row().textContent, /OpenRouter/);
  assert.match(row().textContent, /1 model in Composer · openrouter\.ai/);
  assert.match(row().textContent, /Key saved/);
  assert.equal(host.querySelector('[data-api-provider-editor]'), null);
  click(dom, action(host, 'apiProvidersToggleEditor'));
  const editor = host.querySelector('[data-api-provider-editor="openrouter"]');
  assert.ok(editor);
  assert.equal(row().nextElementSibling, editor);
  assert.match(action(host, 'apiProvidersToggleEditor').textContent, /Done/);
  // A saved key is never shown: no key field until Replace…
  assert.equal(host.querySelector('[data-api-provider-key]'), null);
  assert.ok(action(host, 'apiProvidersReplaceKey'));
});

test('the enable list shows limits with their source, cost, and enabled models first', async () => {
  const { dom, host, controller } = harness(providerState());
  controller.bind();
  await settle();
  click(dom, action(host, 'apiProvidersToggleEditor'));
  const rows = [...host.querySelectorAll('[data-api-model]')].map((row) => row.getAttribute('data-api-model'));
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

test('a key goes out once through setKey and the field is cleared', async () => {
  const { dom, host, controller, recorder } = harness(providerState({ hasKey: false, fetchedAt: null, models: [] }));
  controller.bind();
  await settle();
  assert.match(host.textContent, /Add a key to use it/);
  click(dom, action(host, 'apiProvidersToggleEditor'));
  const field = host.querySelector('[data-api-provider-key="openrouter"]');
  assert.equal(field.type, 'password');
  field.value = `  ${KEY}  `;
  click(dom, action(host, 'apiProvidersSaveKey'));
  await settle();
  assert.deepEqual(recorder.calls[0], ['setKey', { instanceId: 'openrouter', key: KEY }]);
  // Nothing listed yet: a fresh key loads the list straight away.
  assert.deepEqual(recorder.calls[1], ['discover', { instanceId: 'openrouter' }]);
  assert.ok(!host.innerHTML.includes(KEY));
  assert.ok(!JSON.stringify(controller.ui).includes(KEY));
});

test('Save key while another action runs keeps the pasted key in the field', async () => {
  const { dom, host, controller, recorder } = harness(providerState({ hasKey: false, fetchedAt: null, models: [] }));
  let release = null;
  recorder.bridge.setKey = (payload) => { recorder.calls.push(['setKey', payload]); return new Promise((resolve) => { release = resolve; }); };
  controller.bind();
  await settle();
  click(dom, action(host, 'apiProvidersToggleEditor'));
  host.querySelector('[data-api-provider-key="openrouter"]').value = KEY;
  click(dom, action(host, 'apiProvidersSaveKey'));
  await settle();
  const field = host.querySelector('[data-api-provider-key="openrouter"]');
  field.value = 'second-key';
  click(dom, action(host, 'apiProvidersSaveKey'));
  await settle();
  assert.equal(field.value, 'second-key');
  assert.equal(recorder.calls.filter(([name]) => name === 'setKey').length, 1);
  release({ ok: false, code: 'storage_unavailable' });
  await settle();
});

test('toggling a model and adding one by id call the main process', async () => {
  const { dom, host, controller, recorder } = harness(providerState());
  controller.bind();
  await settle();
  click(dom, action(host, 'apiProvidersToggleEditor'));
  const toggle = host.querySelector('[data-api-model-toggle="zeta/unknown"]');
  toggle.checked = true;
  toggle.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await settle();
  assert.deepEqual(recorder.calls.at(-1), ['setModelEnabled', { instanceId: 'openrouter', modelId: 'zeta/unknown', enabled: true }]);
  host.querySelector('[data-api-provider-add-model="openrouter"]').value = 'mistral/large-4';
  click(dom, action(host, 'apiProvidersAddModel'));
  await settle();
  assert.deepEqual(recorder.calls.at(-1), ['setModelEnabled', { instanceId: 'openrouter', modelId: 'mistral/large-4', enabled: true }]);
});

test('Limits… opens the pin row and Pin sends whole-number limits', async () => {
  const { dom, host, controller, recorder } = harness(providerState());
  controller.bind();
  await settle();
  click(dom, action(host, 'apiProvidersToggleEditor'));
  click(dom, host.querySelector('[data-action="apiProvidersLimits"][data-model="zeta/unknown"]'));
  host.querySelector('#apiProvidersPinContext').value = '65536';
  host.querySelector('#apiProvidersPinOutput').value = 'abc';
  click(dom, action(host, 'apiProvidersSavePin'));
  await settle();
  assert.deepEqual(recorder.calls.at(-1), ['setModelPin', {
    instanceId: 'openrouter', modelId: 'zeta/unknown', pin: { contextLength: 65536, maxOutputTokens: undefined },
  }]);
});

test('a failed load keeps the list and says why without provider text', async () => {
  const { dom, host, controller } = harness(providerState({ error: { code: 'unauthorized', status: 401 } }));
  controller.bind();
  await settle();
  click(dom, action(host, 'apiProvidersToggleEditor'));
  const alert = [...host.querySelectorAll('[role="alert"]')].find((node) => node.textContent.trim());
  assert.match(alert.textContent, /OpenRouter refused the key \(401\)/);
  assert.match(alert.textContent, /last successful load/);
  assert.equal(host.querySelectorAll('[data-api-model]').length, 2);
});

test('search filters rows without a repaint and keeps the typed text across a push', async () => {
  const many = Array.from({ length: 8 }, (_, index) => ({ id: `org/model-${index}`, enabled: false, pin: {}, limits: limits() }));
  const { dom, host, controller, recorder, composerRefreshes } = harness(providerState({ models: many }));
  controller.bind();
  await settle();
  click(dom, action(host, 'apiProvidersToggleEditor'));
  const search = host.querySelector('[data-api-provider-search]');
  search.value = 'model-3';
  search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  const visible = [...host.querySelectorAll('[data-api-model]')].filter((row) => !row.hidden);
  assert.deepEqual(visible.map((row) => row.getAttribute('data-api-model')), ['org/model-3']);
  search.focus();
  recorder.push(providerState({ models: many }));
  await settle();
  const after = host.querySelector('[data-api-provider-search]');
  assert.equal(after.value, 'model-3');
  assert.equal(dom.window.document.activeElement, after);
  assert.equal([...host.querySelectorAll('[data-api-model]')].filter((row) => !row.hidden).length, 1);
  assert.equal(composerRefreshes(), 1);
});

test('remove asks once more before it calls the main process', async () => {
  const { dom, host, controller, recorder } = harness(providerState());
  controller.bind();
  await settle();
  click(dom, action(host, 'apiProvidersToggleEditor'));
  click(dom, action(host, 'apiProvidersRemoveAsk'));
  assert.equal(recorder.calls.length, 0);
  assert.match(host.textContent, /Remove OpenRouter\?/);
  click(dom, action(host, 'apiProvidersRemoveConfirm'));
  await settle();
  assert.deepEqual(recorder.calls.at(-1), ['removeInstance', { instanceId: 'openrouter' }]);
});

test('a custom endpoint draft offers only the sign-in each API format admits', async () => {
  const { dom, host, controller, recorder } = harness({ ...providerState(), instances: [] });
  controller.bind();
  await settle();
  const preset = host.querySelector('[data-api-provider-preset]');
  preset.value = 'custom';
  preset.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  click(dom, action(host, 'apiProvidersAdd'));
  const format = host.querySelector('[data-api-custom="transport"]');
  format.value = 'anthropic_messages_v1';
  format.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  const auth = host.querySelector('[data-api-custom="authProfile"]');
  assert.deepEqual([...auth.options].map((option) => option.value), ['api_key_header']);
  for (const [field, value] of [['label', 'Gateway'], ['endpoint', 'https://gw.example.com/v1']]) {
    const input = host.querySelector(`[data-api-custom="${field}"]`);
    input.value = value;
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  }
  click(dom, action(host, 'apiProvidersCustomSubmit'));
  await settle();
  assert.deepEqual(recorder.calls.at(-1), ['addInstance', {
    presetId: 'custom', label: 'Gateway', endpoint: 'https://gw.example.com/v1',
    transport: 'anthropic_messages_v1', authProfile: 'api_key_header',
  }]);
});

test('the feature turned off renders nothing; Force local inference says so on the row', async () => {
  const off = harness({ ...providerState(), enabled: false });
  off.controller.bind();
  await settle();
  assert.equal(off.host.innerHTML, '');
  const local = harness(providerState({ localOnly: true }));
  local.controller.bind();
  await settle();
  assert.match(local.host.textContent, /Force local inference is on/);
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
