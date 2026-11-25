// new-test-file: new surface, the Model roles block (row 194, C6)
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { mountModelRoles } = require('../renderer/shell/renderer-settings-lazy-renderers.js');
const inventory = {
  settingsField: require('../renderer/inventory/settings-field'),
  selectField: require('../renderer/inventory/select-field'),
  actionButton: require('../renderer/inventory/action-button'),
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const MODELS = [
  { id: 'qwen3:27b', engine_type: 'ollama', parameter_size: '27.8B' },
  { id: 'qwen3:8b', engine_type: 'ollama', parameter_size: '8.2B' },
  { id: 'lfm3:2b', engine_type: 'ollama', parameter_size: '2.6B' },
  { id: 'gpt-6', engine_type: 'chatgpt' },
];
const CATALOGS = {
  chatgpt: { available: true, models: [{ id: 'astra', label: 'Astra' }, { id: 'luna', label: 'Luna' }] },
  'codex-cli': { available: true, models: [] },
};

function harness({ snapshot = {}, preferred = 'qwen3:27b', loaded = 'qwen3:27b', routing = {}, catalogs = CATALOGS, store: withStore = true, sessions = [] } = {}) {
  const dom = new JSDOM('<!doctype html><body><button id="settingsNav-tools"></button>'
    + '<section class="settings-card" data-settings-section="models"><div class="settings-group" id="library"></div>'
    + '<div class="settings-group"><h4 id="modelServicesHeading">Engines and providers</h4></div></section></body>', { url: 'http://localhost/' });
  const snap = { status: 'ready', session_id: 'p', model: '', check_model: '', ...snapshot };
  let listener = null;
  const storeCalls = [];
  const store = {
    answer: { ok: true },
    getSnapshot: () => ({ ...snap }),
    subscribe: (fn) => { listener = fn; return () => { listener = null; }; },
    async setModels(patch) { storeCalls.push(patch); return store.answer; },
  };
  const state = {
    modelList: { data: MODELS, active_model: loaded }, status: { model: loaded }, sessions,
    offline: { preferredLocalModel: preferred },
    features: { subagentModelCatalogs: catalogs, subagentRouting: { chatgpt: { defaultModel: '' }, ...routing } },
  };
  const offlineCalls = [];
  const featureCalls = [];
  const bridge = { refuse: false };
  const windowRef = {
    document: dom.window.document, inventory, scriptLoaderUtils: null,
    jennyShell: {
      offline: { async updateSettings(patch) { offlineCalls.push(patch); return bridge.refuse ? { preferredLocalModel: preferred } : patch; } },
      features: {
        async updateSettings(patch) {
          featureCalls.push(patch);
          if (bridge.refuse) return { subagentRouting: { chatgpt: { defaultModel: '' } } };
          return { subagentRouting: { chatgpt: { defaultModel: patch.subagentRouting.chatgpt.defaultModel } }, subagentModelCatalogs: catalogs };
        },
      },
    },
  };
  let defaultChanges = 0;
  const options = { windowRef, documentRef: dom.window.document, state, store: withStore ? store : null, onDefaultChange: () => { defaultChanges += 1; } };
  return {
    dom, snap, state, store, bridge, offlineCalls, featureCalls, storeCalls, options,
    defaultChanges: () => defaultChanges,
    mount: () => mountModelRoles(options),
    emit: () => listener && listener(),
    q: (selector) => dom.window.document.querySelector(selector),
    select: (id) => dom.window.document.getElementById(`${id}Select`),
    line: (id) => dom.window.document.getElementById(`${id}Effective`),
    async change(select, value) {
      select.value = value;
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      await settle();
      await settle();
    },
    cleanup() { dom.window.close(); },
  };
}
const values = (select) => Array.from(select.options, (option) => option.value);
const optionOf = (select, value) => Array.from(select.options).find((option) => option.value === value);
const titles = (h) => Array.from(h.dom.window.document.querySelectorAll('#modelRolesList .settings-field-title'), (el) => el.textContent);

test('the block is one ordinary group placed before Engines and providers, with its heading focusable', async (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  assert.ok(await h.mount());
  const group = h.q('#modelRolesGroup');
  assert.ok(group);
  assert.equal(group.nextElementSibling.querySelector('#modelServicesHeading') !== null, true, 'directly before Engines and providers');
  const heading = h.q('#modelRolesHeading');
  assert.equal(heading.textContent, 'Model roles');
  assert.equal(heading.getAttribute('tabindex'), '-1');
  assert.equal(group.getAttribute('aria-labelledby'), 'modelRolesHeading');
  await h.mount();
  assert.equal(h.dom.window.document.querySelectorAll('#modelRolesGroup').length, 1, 'mounting again keeps one group');
});

test('the four row kinds, in order, with a row per provider that has routing', async (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  await h.mount();
  assert.deepEqual(titles(h), ['New chats', "Jenny's own chat", 'Scheduled checks', 'Helpers under ChatGPT chats']);
  assert.match(h.q('#modelRoleDefaultHelp').textContent, /Always a model on this PC\.$/);
  assert.match(h.q('#modelRoleCheckHelp').textContent, /Models under 7B can't run checks/);
  assert.equal(h.q('#modelRoleHelper-chatgptHelp').textContent, 'The model a ChatGPT chat hands side work to.');
  assert.equal(h.select('modelRoleDefault').getAttribute('aria-describedby'), 'modelRoleDefaultHelp');
  assert.equal(h.dom.window.document.querySelectorAll('#modelRolesList select').length, 4);
});

test('New chats lists local models only with no group labels; the other lists group On this PC then Cloud', async (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  await h.mount();
  const fresh = h.select('modelRoleDefault');
  assert.deepEqual(values(fresh), ['qwen3:27b', 'qwen3:8b', 'lfm3:2b']);
  assert.equal(fresh.querySelectorAll('optgroup').length, 0);
  assert.equal(fresh.value, 'qwen3:27b');
  const jenny = h.select('modelRoleJenny');
  assert.deepEqual(values(jenny), ['', 'qwen3:27b', 'qwen3:8b', 'lfm3:2b', 'gpt-6']);
  assert.equal(jenny.options[0].textContent, "Follow the chat's picker");
  assert.deepEqual(Array.from(jenny.querySelectorAll('optgroup'), (group) => [group.label, group.children.length]),
    [['On this PC', 3], ['Cloud · leaves this PC', 1]]);
  const check = h.select('modelRoleCheck');
  assert.equal(check.options[0].textContent, "Same as Jenny's model");
  assert.equal(optionOf(check, 'lfm3:2b').textContent, 'lfm3:2b · under 7B, too small for checks');
  assert.equal(optionOf(check, 'lfm3:2b').disabled, true);
  assert.equal(optionOf(check, 'qwen3:8b').disabled, false);
  assert.equal(optionOf(check, 'gpt-6').disabled, false);
  const helper = h.select('modelRoleHelper-chatgpt');
  assert.deepEqual(values(helper), ['', 'astra', 'luna']);
  assert.equal(helper.options[0].textContent, 'Same model as the chat');
  assert.equal(optionOf(helper, 'astra').textContent, 'Astra');
});

test('the line under each row says what runs, and the helper row links to Tools', async (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  await h.mount();
  assert.equal(h.line('modelRoleDefault').textContent, 'qwen3:27b is loaded now.');
  assert.equal(h.line('modelRoleJenny').textContent, 'Now: qwen3:27b, your default.');
  assert.equal(h.line('modelRoleCheck').textContent, 'Checks run on qwen3:27b.');
  assert.equal(h.line('modelRoleCheck').querySelector('strong').textContent, 'qwen3:27b');
  const helperLine = h.line('modelRoleHelper-chatgpt');
  assert.equal(helperLine.textContent, 'Effort limits and allowed models stay in Tools › Subagents.');
  assert.equal(helperLine.querySelector('[data-open-settings-section="tools"]').textContent, 'Tools › Subagents');
  let opened = 0;
  h.dom.window.document.getElementById('settingsNav-tools').addEventListener('click', () => { opened += 1; });
  helperLine.querySelector('[data-open-settings-section]').click();
  assert.equal(opened, 1);
  h.state.status.model = 'lfm3:2b';
  h.snap.model = 'gpt-6';
  h.snap.check_model = 'lfm3:2b';
  h.emit();
  assert.equal(h.line('modelRoleDefault').textContent, 'Jenny loads qwen3:27b with the next message in a Default chat.');
  assert.equal(h.line('modelRoleJenny').textContent, 'Every Jenny chat turn runs on gpt-6.');
  assert.equal(h.line('modelRoleCheck').textContent, 'Checks will wait: lfm3:2b is under 7B. Pick a bigger model here or above.');
  assert.ok(h.line('modelRoleCheck').classList.contains('settings-field-effective--warn'));
});

test('the first sentence counts the roles that use a cloud model: none, one, two', async (t) => {
  const none = harness({ catalogs: { chatgpt: { models: [] } }, routing: {} });
  t.after(() => none.cleanup());
  await none.mount();
  assert.deepEqual(titles(none), ['New chats', "Jenny's own chat", 'Scheduled checks']);
  const summary = (h) => h.q('#modelRolesSummary').textContent;
  assert.equal(summary(none), 'Every model Jenny may load or call on her own. None of these uses a cloud model.');
  assert.ok(none.q('#modelRolesSummary').classList.contains('model-roles-summary'));
  const one = harness();
  t.after(() => one.cleanup());
  await one.mount();
  assert.equal(summary(one), 'Every model Jenny may load or call on her own. 1 of these uses a cloud model: Helpers under ChatGPT chats.');
  const two = harness({ snapshot: { model: 'gpt-6' } });
  t.after(() => two.cleanup());
  await two.mount();
  assert.equal(summary(two), "Every model Jenny may load or call on her own. 3 of these use a cloud model: Jenny's own chat, Scheduled checks, Helpers under ChatGPT chats.");
  const checksOnly = harness({ snapshot: { check_model: 'gpt-6' }, catalogs: { chatgpt: { models: [] } } });
  t.after(() => checksOnly.cleanup());
  await checksOnly.mount();
  assert.equal(summary(checksOnly), 'Every model Jenny may load or call on her own. 1 of these uses a cloud model: Scheduled checks.');
});

test('New chats saves the default through offline settings and tells the Library; Set as default shows here at once', async (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  await h.mount();
  await h.change(h.select('modelRoleDefault'), 'qwen3:8b');
  assert.deepEqual(h.offlineCalls, [{ preferredLocalModel: 'qwen3:8b' }]);
  assert.equal(h.state.offline.preferredLocalModel, 'qwen3:8b');
  assert.equal(h.defaultChanges(), 1);
  assert.equal(h.line('modelRoleDefault').textContent, 'Jenny loads qwen3:8b with the next message in a Default chat.');
  h.state.offline.preferredLocalModel = 'lfm3:2b';
  await h.mount();
  assert.equal(h.select('modelRoleDefault').value, 'lfm3:2b', 'the Library wrote the default: this row follows');
});

test('Jenny and checks save through the chat store; Helper saves only the default model through features', async (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  await h.mount();
  await h.change(h.select('modelRoleJenny'), 'gpt-6');
  await h.change(h.select('modelRoleCheck'), 'qwen3:8b');
  await h.change(h.select('modelRoleCheck'), '');
  assert.deepEqual(h.storeCalls, [{ model: 'gpt-6' }, { check_model: 'qwen3:8b' }, { check_model: '' }]);
  await h.change(h.select('modelRoleHelper-chatgpt'), 'luna');
  assert.deepEqual(h.featureCalls, [{ subagentRouting: { chatgpt: { defaultModel: 'luna' } } }]);
  assert.equal(h.state.features.subagentRouting.chatgpt.defaultModel, 'luna');
  assert.equal(h.select('modelRoleHelper-chatgpt').value, 'luna');
  assert.equal(h.dom.window.document.querySelector('.settings-field-error:not([hidden])'), null);
});

test('a refused save restores the earlier value and says so in that row only', async (t) => {
  const h = harness({ snapshot: { check_model: 'qwen3:8b' } });
  t.after(() => h.cleanup());
  await h.mount();
  h.store.answer = { ok: false, reason: 'invalid_request' };
  await h.change(h.select('modelRoleCheck'), 'qwen3:27b');
  assert.equal(h.select('modelRoleCheck').value, 'qwen3:8b');
  const row = h.q('[data-settings-field="modelRoleCheckRow"]');
  assert.equal(row.querySelector('.settings-field-error').textContent, 'Could not save this choice. Try again.');
  assert.doesNotMatch(row.textContent, /invalid_request/);
  assert.equal(h.q('[data-settings-field="modelRoleJennyRow"] .settings-field-error').hidden, true);
  h.store.answer = { ok: true };
  await h.change(h.select('modelRoleCheck'), 'qwen3:27b');
  assert.equal(row.querySelector('.settings-field-error').hidden, true, 'a good write clears it');
  h.bridge.refuse = true;
  await h.change(h.select('modelRoleDefault'), 'qwen3:8b');
  assert.equal(h.select('modelRoleDefault').value, 'qwen3:27b');
  assert.equal(h.state.offline.preferredLocalModel, 'qwen3:27b');
  assert.equal(h.defaultChanges(), 0);
  await h.change(h.select('modelRoleHelper-chatgpt'), 'astra');
  assert.equal(h.select('modelRoleHelper-chatgpt').value, '');
  assert.equal(h.q('[data-settings-field="modelRoleHelper-chatgptRow"] .settings-field-error').hidden, false);
});

test('with the Jenny chat unavailable its two rows are disabled with the reason; the others stay editable', async (t) => {
  const h = harness({ snapshot: { status: 'unavailable' } });
  t.after(() => h.cleanup());
  await h.mount();
  for (const id of ['modelRoleJenny', 'modelRoleCheck']) {
    assert.equal(h.select(id).disabled, true, id);
    assert.equal(h.line(id).textContent, 'Available when the Jenny chat is on.');
  }
  assert.equal(h.select('modelRoleDefault').disabled, false);
  assert.equal(h.select('modelRoleHelper-chatgpt').disabled, false);
});

test('with Subagents off the helper row stays, disabled, with the reason', async (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  h.state.features.tools = { subagents: false };
  await h.mount();
  assert.equal(h.select('modelRoleHelper-chatgpt').disabled, true);
  assert.equal(h.line('modelRoleHelper-chatgpt').textContent, 'Subagents are off in Tools, so helpers do not run.');
});

test('a saved model missing from the list stays as an option so a row never shows the wrong value', async (t) => {
  const h = harness({ preferred: 'old:70b', snapshot: { model: 'old:70b' }, routing: { chatgpt: { defaultModel: 'gone' } } });
  t.after(() => h.cleanup());
  await h.mount();
  assert.equal(h.select('modelRoleDefault').value, 'old:70b');
  assert.equal(h.select('modelRoleJenny').value, 'old:70b');
  assert.equal(h.select('modelRoleHelper-chatgpt').value, 'gone');
});

test('with no model chosen New chats shows a disabled placeholder, and no store leaves the other rows disabled', async (t) => {
  const h = harness({ preferred: '', loaded: '', store: false });
  t.after(() => h.cleanup());
  await h.mount();
  assert.equal(h.select('modelRoleDefault').value, '');
  assert.equal(h.select('modelRoleDefault').options[0].textContent, 'No model chosen');
  assert.equal(h.select('modelRoleDefault').options[0].disabled, true);
  assert.equal(h.line('modelRoleDefault').textContent, '');
  assert.equal(h.select('modelRoleJenny').disabled, true);
});

// Row 201 C1 / OD-1: team models are a third source class; no local-only role offers one.
const TEAM_MODEL = { id: 'team/team_alpha1/qwen3:70b', engine_type: 'openai-compatible', team_id: 'team_alpha1', team_name: 'Alpha crew' };

test('no role offers a team model, and the summary stays true', async (t) => {
  const plain = harness();
  t.after(() => plain.cleanup());
  await plain.mount();
  const h = harness();
  t.after(() => h.cleanup());
  h.state.modelList.data = [...MODELS, TEAM_MODEL];
  await h.mount();
  for (const id of ['modelRoleDefault', 'modelRoleJenny', 'modelRoleCheck']) {
    assert.deepEqual(values(h.select(id)).filter((value) => value.startsWith('team/')), [], id);
  }
  assert.equal(h.q('#modelRolesSummary').textContent, plain.q('#modelRolesSummary').textContent, 'a listed team model changes nothing in the summary');
  assert.doesNotMatch(h.q('#modelRolesSummary').textContent, /team model/);
});

test('a team id saved in a local-only role is ignored for New chats and checks, shown disabled, and named in the summary', async (t) => {
  const h = harness({ preferred: TEAM_MODEL.id, loaded: 'qwen3:27b', snapshot: { model: TEAM_MODEL.id } });
  t.after(() => h.cleanup());
  h.state.modelList.data = [...MODELS, TEAM_MODEL];
  await h.mount();
  assert.equal(h.select('modelRoleDefault').value, 'qwen3:27b', 'a saved team default reads as unset');
  assert.equal(values(h.select('modelRoleDefault')).includes(TEAM_MODEL.id), false);
  const jenny = optionOf(h.select('modelRoleJenny'), TEAM_MODEL.id);
  assert.equal(jenny.disabled, true);
  assert.equal(jenny.textContent, 'qwen3:70b', 'the formatted name, not team/<teamId>/<modelId>');
  assert.match(h.line('modelRoleCheck').textContent, /^Checks run on qwen3:27b\./, 'a team pin is skipped for the check model');
  assert.match(h.q('#modelRolesSummary').textContent, /Jenny's own chat runs on a team model/);
});
