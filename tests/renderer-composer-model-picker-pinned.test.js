'use strict';

// new-test-file: row 144 variant A (the pinned Jenny chat picker); tests/renderer-composer-model-picker.test.js is at its line cap.
// While Settings pins Jenny's model, the Jenny chat's picker still opens but its list is locked, the Default option is
// gone, Thinking stays operable, and the footer links to Settings. Any other chat's picker is unchanged.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const inventory = {
  actionButton: require('../renderer/inventory/action-button'),
  textField: require('../renderer/inventory/text-field'),
  popover: require('../renderer/inventory/popover'),
};
const utils = require('../renderer/chat/renderer-composer-model-picker-utils');
const formatUtils = require('../renderer/shell/renderer-model-library-format-utils');
const { createComposerModelPicker } = require('../renderer/chat/renderer-composer-model-picker');

const CATALOG = [
  { id: 'qwen3:27b', engine_type: 'ollama' },
  { id: 'qwen3:8b', engine_type: 'ollama' },
  { id: 'lfm3:2b', engine_type: 'ollama' },
];

function harness(t, { pin = 'qwen3:27b', sessionId = 'p', storeSession = 'p', status = 'ready', preferred = 'qwen3:27b', catalog = CATALOG, getSessionId,
  backend = 'qwen3:27b', engine = '', efforts = [['default', 'Use default'], ['high', 'High']] } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>
    <button id="composerModelPill" class="inv-chip composer-model-pill" aria-expanded="false"><span class="inv-chip-label">Model</span></button>
    <div class="inv-popover composer-model-popover" id="composerModelPopover" data-inv-popover="composer-model" role="dialog" hidden>
      <div class="composer-model-picker" data-composer-model-picker></div>
      <select id="composerModelSelect"></select><select id="composerEffortSelect"></select>
    </div></body></html>`);
  const { document } = dom.window;
  inventory.popover.initPopoverHandlers(document);
  const modelSelect = document.getElementById('composerModelSelect');
  modelSelect.append(new dom.window.Option('Use backend default', ''));
  catalog.forEach((entry) => modelSelect.append(new dom.window.Option(entry.id, entry.id)));
  modelSelect.value = preferred;
  const effortSelect = document.getElementById('composerEffortSelect');
  efforts.forEach(([value, label]) => effortSelect.append(new dom.window.Option(label, value)));
  effortSelect.dataset.reasoningSupported = 'true';
  const changes = [];
  effortSelect.addEventListener('change', () => changes.push(effortSelect.value));
  const opened = [];
  let listener = null;
  const snapshot = { status, session_id: storeSession, model: pin };
  const store = {
    getSnapshot: () => ({ ...snapshot }),
    subscribe: (fn) => { listener = fn; return () => { listener = null; }; },
    openSettings: (target) => opened.push(target),
  };
  const state = { currentSessionId: sessionId, status: { model: backend, ...(engine ? { engine } : {}) }, modelList: { data: catalog, active_model: backend } };
  const picker = createComposerModelPicker({ state, documentRef: document, inventory, utils, formatUtils, primaryChatStore: store, getSessionId });
  picker.bind();
  t.after(() => { picker.dispose(); dom.window.close(); });
  return {
    dom, document, picker, state, snapshot, opened, changes, modelSelect, effortSelect,
    pill: document.getElementById('composerModelPill'),
    popoverEl: document.getElementById('composerModelPopover'),
    host: document.querySelector('[data-composer-model-picker]'),
    open() { inventory.popover.open(document.getElementById('composerModelPopover'), { trigger: document.getElementById('composerModelPill') }); },
    notify() { listener?.({ ...snapshot }); },
  };
}

const optionIds = (h) => [...h.host.querySelectorAll('[data-picker-model]')].map((button) => button.dataset.pickerModel);

test('a pinned Jenny chat opens a locked list with no Default option and the pinned model active', (t) => {
  const h = harness(t);
  h.open();
  const list = h.host.querySelector('.composer-model-picker-list');
  assert.ok(list.classList.contains('is-pinned'));
  assert.deepEqual(optionIds(h), ['qwen3:27b', 'qwen3:8b', 'lfm3:2b'], 'Default is not listed');
  const buttons = [...h.host.querySelectorAll('[data-picker-model]')];
  assert.deepEqual(buttons.map((button) => [button.disabled, button.getAttribute('aria-disabled')]),
    [[false, null], [true, 'true'], [true, 'true']]);
  assert.ok(buttons[0].classList.contains('is-active'));
  buttons[1].click();
  assert.equal(h.modelSelect.value, 'qwen3:27b', 'a disabled option changes nothing');
});

test('clicking the active pinned model just closes the list and writes nothing', (t) => {
  const h = harness(t, { preferred: 'qwen3:8b' });
  h.open();
  let writes = 0;
  h.modelSelect.addEventListener('change', () => { writes += 1; });
  h.host.querySelector('[data-picker-model="qwen3:27b"]').click();
  assert.equal(writes, 0);
  assert.equal(h.modelSelect.value, 'qwen3:8b');
});

test('the pill shows the pinned model and a quiet Pinned, even before the session saved the pin', (t) => {
  const h = harness(t, { preferred: 'lfm3:2b' });
  h.picker.syncPill();
  assert.match(h.pill.querySelector('.inv-chip-label').textContent, /^qwen3/);
  const pin = h.pill.querySelector('.composer-model-pill-pin');
  assert.equal(pin.textContent, 'Pinned');
  h.picker.syncPill();
  assert.equal(h.pill.querySelectorAll('.composer-model-pill-pin').length, 1, 'one badge however often the pill syncs');
  h.snapshot.model = '';
  h.picker.syncPill();
  assert.equal(h.pill.querySelector('.composer-model-pill-pin'), null, 'unpinning removes it');
});

test('Thinking stays operable while the model list is locked', (t) => {
  const h = harness(t);
  h.open();
  const high = h.host.querySelector('[data-picker-effort="high"]');
  assert.equal(high.disabled, false);
  high.click();
  assert.deepEqual(h.changes, ['high']);
});

test('the footer says the model is pinned and its link opens Settings at Jenny\'s model', (t) => {
  const h = harness(t);
  h.open();
  const footer = h.host.querySelector('.inv-popover-footer.composer-model-picker-pinned');
  assert.match(footer.textContent, /Jenny's model is pinned in Settings\./);
  const link = footer.querySelector('[data-picker-open-settings]');
  assert.equal(link.tagName, 'BUTTON');
  assert.equal(link.textContent, 'Change in Settings');
  link.click();
  assert.deepEqual(h.opened, ['model']);
  assert.equal(h.popoverEl.hasAttribute('hidden'), true, 'the list closes behind the link');
});

test('an ordinary chat with the same pin keeps Default, an unlocked list and today\'s footer', (t) => {
  const h = harness(t, { sessionId: 'other', preferred: 'qwen3:8b' });
  h.open();
  assert.equal(h.host.querySelector('.composer-model-picker-list').classList.contains('is-pinned'), false);
  assert.deepEqual(optionIds(h), ['', 'qwen3:27b', 'qwen3:8b', 'lfm3:2b']);
  assert.equal(h.host.querySelectorAll('[data-picker-model][disabled]').length, 0);
  assert.equal(h.host.querySelector('.composer-model-picker-pinned'), null);
  assert.match(h.host.querySelector('.inv-popover-footer').textContent, /Applies to this chat/);
  h.picker.syncPill();
  assert.equal(h.pill.querySelector('.composer-model-pill-pin'), null);
});

test('the Jenny chat without a pin, or while the store is not ready, is an ordinary picker', (t) => {
  const unpinned = harness(t, { pin: '' });
  unpinned.open();
  assert.equal(unpinned.host.querySelector('.is-pinned'), null);
  assert.equal(optionIds(unpinned)[0], '');
  const offline = harness(t, { status: 'unavailable' });
  offline.open();
  assert.equal(offline.host.querySelector('.is-pinned'), null);
});

test('a store change repaints the open list: pinning locks it, unpinning frees it', (t) => {
  const h = harness(t, { pin: '', preferred: 'qwen3:8b' });
  h.open();
  assert.equal(h.host.querySelector('.is-pinned'), null);
  h.snapshot.model = 'qwen3:27b';
  h.notify();
  assert.ok(h.host.querySelector('.composer-model-picker-list.is-pinned'));
  assert.equal(h.pill.querySelector('.composer-model-pill-pin').textContent, 'Pinned');
  h.snapshot.model = '';
  h.notify();
  assert.equal(h.host.querySelector('.is-pinned'), null);
});

test('a pinned model missing from the catalog still shows as the active option', (t) => {
  const h = harness(t, { pin: 'gone:70b', preferred: 'gone:70b' });
  h.open();
  const ids = optionIds(h);
  assert.equal(ids[0], 'gone:70b');
  assert.ok(h.host.querySelector('[data-picker-model="gone:70b"]').classList.contains('is-active'));
});

test('a split pane locks by its own session, not the focused pane', (t) => {
  const pane = harness(t, { sessionId: 'other', getSessionId: () => 'p' });
  pane.open();
  assert.ok(pane.host.querySelector('.composer-model-picker-list.is-pinned'));
  const elsewhere = harness(t, { sessionId: 'p', getSessionId: () => 'other' });
  elsewhere.open();
  assert.equal(elsewhere.host.querySelector('.is-pinned'), null);
});

// Not a pin case: it lives here because the main picker test file is at its line cap.
test('an API model shows its plain name on the Default row and Min for its lowest effort', (t) => {
  const id = 'api-provider/anthropic-api/claude-haiku-5-5';
  const h = harness(t, {
    pin: '', sessionId: 'other', preferred: '', backend: id, catalog: [{ id, engine_type: 'api-provider' }],
    efforts: [['default', 'Use default'], ['none', 'Minimal'], ['max', 'Maximum']],
  });
  h.open();
  assert.equal(
    h.host.querySelector('[data-picker-model=""] .composer-model-picker-name').textContent,
    'Default \u00b7 claude-haiku-5-5',
  );
  assert.deepEqual(
    [...h.host.querySelectorAll('[data-picker-effort]')].map((segment) => segment.textContent),
    ['Default', 'Min', 'Max'],
  );
});

// Row 192 C14 (not a pin case: the main picker test file is at its line cap). A cloud engine is marked on the pill.
const OPENROUTER = 'api-provider/openrouter/qwen3.8-72b';
const CLOUD_CATALOG = [
  { id: OPENROUTER, engine_type: 'api-provider', provider: 'OpenRouter', apiProviderInstanceId: 'openrouter', apiProviderModelId: 'qwen3.8-72b' },
  { id: 'qwen3:27b', engine_type: 'ollama' },
  { id: 'team/team_abc/qwen3:8b', engine_type: 'openai-compatible', team_id: 'team_abc', team_name: 'Studio' },
];
const cloudOf = (h) => ({
  cloud: h.pill.classList.contains('composer-model-pill--cloud'),
  icon: Boolean(h.pill.querySelector('.inv-chip-icon svg')),
  label: h.pill.querySelector('.inv-chip-label').textContent,
  title: h.pill.getAttribute('title'),
});
const CLOUD_TITLE = (provider) => `Cloud model. Your messages leave this computer and go to ${provider}.`;

test('a cloud model gets the cloud class, icon, "Provider · model" label and the leaves-this-computer title', (t) => {
  const h = harness(t, { pin: '', sessionId: 'other', preferred: OPENROUTER, catalog: CLOUD_CATALOG, backend: 'qwen3:27b' });
  h.picker.syncPill();
  assert.deepEqual(cloudOf(h), { cloud: true, icon: true, label: 'OpenRouter · qwen3.8-72b', title: CLOUD_TITLE('OpenRouter') });
  assert.match(h.pill.getAttribute('aria-label'), /Model: qwen3\.8-72b.*Cloud model\./, 'the name keeps the model and adds the warning');
  assert.equal(h.pill.querySelectorAll('.inv-chip-icon').length, 1, 'one icon however often the pill syncs');
  h.picker.syncPill();
  assert.equal(h.pill.querySelectorAll('.inv-chip-icon').length, 1);
  h.modelSelect.value = 'qwen3:27b';
  h.picker.syncPill();
  assert.deepEqual(cloudOf(h), { cloud: false, icon: false, label: 'qwen3 · 27b', title: 'Model: qwen3:27b. Thinking: Default' });
  assert.ok(h.pill.querySelector('.composer-model-pill-dot.status-dot--ok'), 'a local model keeps its loaded dot');
});

test('a Default chat that resolves to a cloud model is marked the same way', (t) => {
  const h = harness(t, { pin: '', sessionId: 'other', preferred: '', backend: 'gpt-5.1', engine: 'chatgpt', catalog: [{ id: 'gpt-5.1', engine_type: 'chatgpt' }] });
  h.picker.syncPill();
  assert.deepEqual(cloudOf(h), { cloud: true, icon: true, label: 'ChatGPT · Default · gpt-5.1', title: CLOUD_TITLE('ChatGPT') });
  assert.equal(h.pill.querySelector('.composer-model-pill-dot'), null, 'the cloud icon takes the dot\'s place');
  const unlisted = require('../renderer/chat/renderer-composer-model-picker-utils').describeCloudPill({ preferredModel: 'gpt-5.1' }, { modelList: { data: CLOUD_CATALOG } });
  assert.match(unlisted.title, /go to ChatGPT\.$/, 'a ChatGPT model the catalog does not list is still marked');
});

test('a pinned cloud model is marked and keeps its Pinned badge; a team model is not a cloud engine', (t) => {
  const pinned = harness(t, { pin: 'codex-cli/gpt-5.1-codex', preferred: '', catalog: [{ id: 'codex-cli/gpt-5.1-codex', engine_type: 'codex-cli' }] });
  pinned.picker.syncPill();
  assert.deepEqual(cloudOf(pinned), { cloud: true, icon: true, label: 'Codex CLI · gpt-5.1-codex', title: CLOUD_TITLE('Codex CLI') });
  assert.ok(pinned.pill.querySelector('.composer-model-pill-pin'));
  const team = harness(t, { pin: '', sessionId: 'other', preferred: 'team/team_abc/qwen3:8b', catalog: CLOUD_CATALOG });
  team.picker.syncPill();
  assert.equal(cloudOf(team).cloud, false);
  assert.equal(cloudOf(team).icon, false);
});
