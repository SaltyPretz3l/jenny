const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  normalizeFeatureState,
  getToolConfigFieldsForRender,
  buildToolConfigFieldListMarkup,
  buildSettingsToggleListMarkup,
  buildContextToggleListsMarkup,
  buildWebSearchSectionMarkup,
  resolveToolConfigToggleEvent,
  resolveModelBadge,
  buildUiLanguageFieldMarkup,
} = require('../renderer/shell/renderer-settings-support');
const supportExports = require('../renderer/shell/renderer-settings-support');
const { toggleSwitch } = require('../renderer/inventory/toggle-switch');
const selectField = require('../renderer/inventory/select-field');
const textField = require('../renderer/inventory/text-field');
const actionButton = require('../renderer/inventory/action-button');
const settingsField = require('../renderer/inventory/settings-field');
const { segmentedGroup, segmentedValue } = require('./helpers/segmented-control');
const { settingRow } = require('./helpers/settings-rows');

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

test('buildSettingsToggleListMarkup renders one standard row per field and drops id-less rows', () => {
  const markup = buildSettingsToggleListMarkup({
    fields: [
      { id: 'aToggle', label: 'A', description: 'About A', detail: 'More on A', checked: true },
      { id: 'bToggle', label: 'B', checked: false, disabled: true },
      { id: 'contextIncludePersonalityToggle', checked: false },
      { id: '', label: 'no id' },
    ],
    toggleSwitch,
    escapeHtml,
  });
  const doc = new JSDOM(`<!doctype html><body>${markup}</body>`).window.document;
  assert.equal(doc.querySelectorAll('[data-inv-toggle]').length, 3, 'id-less field is dropped');
  assert.equal(doc.querySelectorAll('.settings-field.settings-field--row').length, 3);
  assert.equal(doc.querySelector('.inv-toggle-label'), null, 'no legacy switch label');
  const a = doc.querySelector('[data-inv-toggle="aToggle"]');
  const rowA = a.closest('.settings-field--row');
  const title = rowA.querySelector('.settings-field-title');
  assert.equal(title.tagName, 'LABEL');
  assert.equal(title.textContent, 'A');
  assert.equal(title.htmlFor, a.id);
  assert.equal(rowA.querySelector('.settings-field-help').textContent, 'About A');
  assert.equal(a.getAttribute('aria-checked'), 'true');
  assert.equal(rowA.querySelector('.settings-field-detail').getAttribute('data-tooltip'), 'More on A');
  const b = doc.querySelector('[data-inv-toggle="bToggle"]');
  assert.equal(b.getAttribute('aria-checked'), 'false');
  assert.equal(b.disabled, true, 'disabled lands on the track button');
  assert.equal(b.closest('.settings-field--row').querySelector('.settings-field-detail'), null, 'no detail, no affordance');
  const copyRow = doc.querySelector('[data-inv-toggle="contextIncludePersonalityToggle"]').closest('.settings-field--row');
  assert.match(copyRow.querySelector('.settings-field-detail').getAttribute('data-tooltip'), /ChatGPT engine/, 'field copy detail');
});

test('buildSettingsToggleListMarkup finds the switch through the shared row builder when none is passed in', () => {
  const markup = buildSettingsToggleListMarkup({ fields: [{ id: 'x', label: 'X' }] });
  assert.match(markup, /data-inv-toggle="x"/);
  assert.doesNotMatch(markup, /class="settings-note"/);
});

test('buildContextToggleListsMarkup splits prefs and feature flags by persistence path', () => {
  const lists = buildContextToggleListsMarkup({
    contextPreferences: { includePersonality: true, includeMemory: false },
    featureFlags: { token_budget: true, context_compaction: false },
    prefsDisabled: false,
    flagsDisabled: true,
    toggleSwitch,
    escapeHtml,
  });
  const sources = new JSDOM(`<!doctype html><body>${lists.sources}</body>`).window.document;
  const runtime = new JSDOM(`<!doctype html><body>${lists.runtime}</body>`).window.document;

  // sources = the 2 session runtime-preference toggles (not disabled here)
  assert.equal(sources.querySelectorAll('[data-inv-toggle]').length, 2);
  assert.equal(sources.querySelector('[data-inv-toggle="contextIncludePersonalityToggle"]').getAttribute('aria-checked'), 'true');
  assert.equal(sources.querySelector('[data-inv-toggle="contextIncludeMemoryToggle"]').getAttribute('aria-checked'), 'false');

  // runtime = automatic summarization only (token budget left the page), disabled here
  assert.equal(runtime.querySelectorAll('[data-inv-toggle]').length, 1);
  assert.equal(runtime.querySelector('[data-inv-toggle="contextTokenBudgetToggle"]'), null);
  assert.equal(runtime.querySelector('[data-inv-toggle="contextCompactionToggle"]').getAttribute('aria-checked'), 'false');
  assert.equal(runtime.querySelector('[data-inv-toggle="contextCompactionToggle"]').disabled, true);
});

test('web search provider markup nests a bounded connection test in Web tools', () => {
  const markup = buildWebSearchSectionMarkup({
    visible: true,
    webSearch: { provider: 'duckduckgo' },
    selectField,
    textField,
    actionButton, settingsField,
    escapeHtml,
  });
  const doc = new JSDOM(`<!doctype html><body>${markup}</body>`).window.document;
  assert.equal(doc.querySelector('[data-web-search-test]')?.textContent.trim(), 'Test');
  assert.ok(doc.querySelector('[data-web-search-test-status][aria-live="polite"]'));
});

test('resolveModelBadge derives state + text from runtime signals', () => {
  assert.deepEqual(resolveModelBadge({ busy: true, loadingModel: true }), { state: 'busy', text: 'Switching' });
  assert.deepEqual(resolveModelBadge({ busy: true, loadingModel: false }), { state: 'busy', text: 'Unloading' });
  assert.deepEqual(resolveModelBadge({ errored: true }), { state: 'error', text: 'Error' });
  assert.deepEqual(resolveModelBadge({ catalogUnavailable: true, activeModel: '' }), { state: 'warn', text: 'Unavailable' });
  assert.deepEqual(resolveModelBadge({ catalogUnavailable: true, activeModel: 'gpt-4o' }), { state: 'live', text: 'gpt-4o' });
  assert.deepEqual(resolveModelBadge({}), { state: 'info', text: 'Default backend' });
});

test('normalizeFeatureState preserves sanitized tool config metadata', () => {
  const normalized = normalizeFeatureState({
    tools: { web: true },
    toolConfig: {
      schemaVersion: 1,
      fields: [
        {
          key: 'web',
          label: 'Live <web>',
          fieldType: 'toggle',
          storage: 'config',
          default: false,
          helpText: 'Use <live> lookup.',
          configFlag: 'tools_web_enabled',
          toolIds: ['web_search', '', 42, 'fetch_url', 'web_search'],
        },
        {
          key: 'apiKey',
          label: 'API key',
          fieldType: 'password',
          storage: 'config',
          default: '',
        },
        {
          key: 'badDefault',
          label: 'Bad default',
          fieldType: 'toggle',
          storage: 'config',
          default: 'true',
        },
        {
          key: '',
          label: 'Missing key',
          fieldType: 'toggle',
          storage: 'config',
          default: false,
        },
      ],
    },
  });

  assert.equal(normalized.toolConfig.schemaVersion, 1);
  assert.deepEqual(normalized.toolConfig.fields, [
    {
      key: 'web',
      label: 'Live <web>',
      fieldType: 'toggle',
      storage: 'config',
      default: false,
      helpText: 'Use <live> lookup.',
      configFlag: 'tools_web_enabled',
      toolIds: ['web_search', 'fetch_url'],
    },
  ]);
});

test('tool config fields fall back to the legacy tool toggles when metadata is absent', () => {
  const normalized = normalizeFeatureState({ tools: { web: true } });
  const fields = getToolConfigFieldsForRender(normalized);

  assert.deepEqual(
    fields.map((field) => field.key),
    [
      'fileTools', 'richFiles', 'imageRead', 'web', 'bash',
      'pythonRuntime', 'lsp', 'worktree', 'subagents',
    ]
  );
  assert.ok(fields.every((field) => field.fieldType === 'toggle'));
  assert.ok(fields.every((field) => field.storage === 'config'));
});

test('tool config field list renders display-safe inventory toggle rows', () => {
  const fields = [
    {
      key: 'web',
      label: 'Live <web>',
      fieldType: 'toggle',
      storage: 'config',
      default: false,
      helpText: 'Use <live> lookup.',
      configFlag: 'tools_web_enabled',
      toolIds: ['web_search', 'fetch_url'],
    },
  ];
  const markup = buildToolConfigFieldListMarkup({
    fields,
    tools: { web: true },
    availability: { web: { enabled: false, workspaceRootRequired: true } },
    escapeHtml,
    toggleSwitch,
  });
  const dom = new JSDOM(`<!doctype html><body>${markup}</body>`);
  const row = dom.window.document.querySelector('[data-settings-field="settings-tool-config-web"]');
  const toggle = dom.window.document.querySelector('[data-inv-toggle="settings-tool-config-web"]');

  assert.ok(row);
  assert.ok(toggle);
  assert.equal(toggle.getAttribute('aria-checked'), 'true');
  assert.equal(toggle.hasAttribute('disabled'), true);
  assert.match(row.textContent, /Web tools/);
  assert.match(row.textContent, /Search the web and fetch pages\. Currently blocked by runtime availability\./);
});

test('PDF help uses the shared add-on sentence only while the add-on is needed', () => {
  for (const pdfAddonNeeded of [true, false]) {
    const markup = buildToolConfigFieldListMarkup({ fields: getToolConfigFieldsForRender({}), pdfAddonNeeded, toggleSwitch });
    const doc = new JSDOM(markup).window.document;
    for (const key of ['richFiles', 'imageRead']) {
      const help = doc.querySelector(`[data-settings-field="settings-tool-config-${key}"] .settings-field-help`);
      assert.equal(help.textContent.endsWith('Needs the PDF reading add-on.'), pdfAddonNeeded);
    }
    assert.equal(doc.querySelector('.tools-config-field-addon-note'), null);
  }
});

test('a tool row help line is the base help plus the add-on and runtime notes that apply', () => {
  const { composeToolHelp } = supportExports;
  const rich = { key: 'richFiles', helpText: 'Open files.' };
  assert.equal(composeToolHelp(rich, {}), 'Open files.');
  assert.equal(composeToolHelp(rich, { pdfAddonNeeded: true }), 'Open files. Needs the PDF reading add-on.');
  assert.equal(composeToolHelp(rich, { blocked: true }), 'Open files. Currently blocked by runtime availability.');
  assert.equal(composeToolHelp(rich, { pdfAddonNeeded: true, blocked: true }), 'Open files. Needs the PDF reading add-on. Currently blocked by runtime availability.');
  assert.equal(composeToolHelp({ key: 'web', helpText: 'Search.' }, { pdfAddonNeeded: true }), 'Search.', 'only the PDF rows need the add-on');
});

test('Tools rows show the copy their descriptors hold; a tool the renderer does not know shows the manifest copy', () => {
  // Fresh modules under a translator that numbers every tool string it hands out, so a
  // second copy of the same catalog string would read differently from the descriptor's.
  const paths = ['../renderer/shell/renderer-settings-field-descriptors.js', '../renderer/shell/renderer-settings-field-copy.js', '../renderer/shell/renderer-settings-support.js'].map((p) => require.resolve(p));
  const cached = paths.map((p) => require.cache[p]);
  const saved = globalThis.jennyI18n;
  let calls = 0;
  paths.forEach((p) => { delete require.cache[p]; });
  globalThis.jennyI18n = { t: (k, d, p) => (k.startsWith('settings.tools.') ? `${d} #${calls += 1}` : (p ? String(d).replace(/\{(\w+)\}/g, (m, n) => String(p[n])) : d)) };
  let fresh;
  try {
    fresh = paths.map((p) => require(p));
  } finally {
    globalThis.jennyI18n = saved;
    paths.forEach((p, i) => { if (cached[i]) require.cache[p] = cached[i]; else delete require.cache[p]; });
  }
  const [descriptors, , support] = fresh;
  const markup = support.buildToolConfigFieldListMarkup({ fields: support.DEFAULT_TOOL_CONFIG_FIELDS.concat([{ key: 'futureTool', label: 'Future tool', helpText: 'From the manifest.' }]), toggleSwitch });
  const doc = new JSDOM(markup).window.document;
  for (const field of support.DEFAULT_TOOL_CONFIG_FIELDS) {
    const copy = descriptors.getSettingDescriptor('settings-tool-config-' + field.key).copy;
    const row = doc.querySelector(`[data-settings-field="settings-tool-config-${field.key}"]`);
    assert.equal(row.querySelector('.settings-field-title').textContent, copy.label, field.key);
    assert.equal(row.querySelector('.settings-field-help').textContent, copy.description, field.key);
    assert.equal(row.querySelector('.settings-field-detail')?.dataset.tooltip || '', copy.detail, field.key);
  }
  assert.match(descriptors.getSettingDescriptor('settings-tool-config-pythonRuntime').copy.detail, /^Resource-bounded, but not a filesystem or network sandbox\./);
  const future = doc.querySelector('[data-settings-field="settings-tool-config-futureTool"]');
  assert.equal(future.querySelector('.settings-field-title').textContent, 'Future tool');
  assert.equal(future.querySelector('.settings-field-help').textContent, 'From the manifest.');
});

test('tool config field list escapes help text with its built-in fallback', () => {
  const markup = buildToolConfigFieldListMarkup({
    fields: [
      {
        key: 'futureTool',
        label: 'Web tools',
        fieldType: 'toggle',
        storage: 'config',
        default: false,
        helpText: '<img src=x onerror=alert(1)>',
        toolIds: ['web_search'],
      },
    ],
    tools: {},
    availability: {},
    toggleSwitch,
  });

  assert.doesNotMatch(markup, /<img/i);
  assert.match(markup, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('tool config field ids encode future-safe metadata keys', () => {
  const markup = buildToolConfigFieldListMarkup({
    fields: [
      {
        key: 'future/tool',
        label: 'Future tool',
        fieldType: 'toggle',
        storage: 'config',
        default: false,
        toolIds: ['future_tool'],
      },
    ],
    tools: { 'future/tool': true },
    availability: {},
    escapeHtml,
    toggleSwitch,
  });
  const dom = new JSDOM(`<!doctype html><body>${markup}</body>`);
  const toggle = dom.window.document.querySelector('[data-inv-toggle="settings-tool-config-future%2Ftool"]');

  assert.ok(toggle);
  assert.equal(toggle.getAttribute('aria-checked'), 'true');
  assert.deepEqual(
    resolveToolConfigToggleEvent({
      detail: {
        id: 'settings-tool-config-future%2Ftool',
        checked: false,
      },
    }, [
      {
        key: 'future/tool',
        label: 'Future tool',
        fieldType: 'toggle',
        storage: 'config',
        default: false,
        toolIds: ['future_tool'],
      },
    ]),
    {
      key: 'future/tool',
      checked: false,
      label: 'Future tool',
    }
  );
});

test('resolveToolConfigToggleEvent maps inventory toggle events back to tool keys', () => {
  const result = resolveToolConfigToggleEvent({
    detail: {
      id: 'settings-tool-config-futureTool',
      checked: true,
    },
  }, [
    {
      key: 'futureTool',
      label: 'Future tool',
      fieldType: 'toggle',
      storage: 'config',
      default: false,
      toolIds: ['future_tool'],
    },
  ]);

  assert.deepEqual(result, {
    key: 'futureTool',
    checked: true,
    label: 'Future tool',
  });
});

test('two unknown tool keys never share a row: each title toggles its own switch', () => {
  // "future/tool" encodes to "future%2Ftool"; a plain replace of "%" would land on the second key's id.
  const fields = ['future/tool', 'future_2Ftool'].map((key) => ({ key, label: key }));
  const doc = new JSDOM(buildToolConfigFieldListMarkup({ fields, tools: {} })).window.document;
  const rows = [...doc.querySelectorAll('.settings-field')];
  assert.equal(new Set(rows.map((row) => row.dataset.settingsField)).size, 2);
  for (const [index, row] of rows.entries()) {
    const toggle = row.querySelector('[data-inv-toggle]');
    assert.equal(toggle.dataset.invToggle, `settings-tool-config-${encodeURIComponent(fields[index].key)}`);
    assert.equal(doc.getElementById(row.querySelector('.settings-field-title').htmlFor), toggle);
    assert.equal(supportExports.toolConfigRowId(toggle.dataset.invToggle), row.dataset.settingsField);
  }
});

test('the Permissions rows and the language row keep their control ids', () => {
  const markup = settingRow('safetyModeSelect', 'strict', { selectField })
    + settingRow('defaultRunModeSelect', 'plan', { selectField })
    + settingRow('unattendedGuardMinutesInput', 0)
    + settingRow('autoApproveStreakCapInput', 0)
    + buildUiLanguageFieldMarkup({ value: 'de', use24HourTime: true, selectField });
  const doc = new JSDOM(`<!doctype html><body>${markup}</body>`).window.document;
  const expected = { safetyModeSelect: 'strict', defaultRunModeSelect: 'plan', unattendedGuardMinutesInput: '0', autoApproveStreakCapInput: '', uiLanguageSelect: 'de' };
  // Three-option preferences are segmented groups; the rest keep an input with the id.
  const segmented = ['safetyModeSelect', 'defaultRunModeSelect'];
  for (const [id, value] of Object.entries(expected)) {
    const control = segmented.includes(id) ? segmentedGroup(doc, id) : doc.getElementById(id);
    assert.ok(control, `${id} keeps its id`);
    assert.equal(segmented.includes(id) ? segmentedValue(doc, id) : control.value, value, id);
    assert.ok(control.closest(`[data-settings-field="${id}"]`), `${id} renders as its descriptor row`);
  }
  assert.equal(doc.getElementById('unattendedGuardModeSelect'), null, 'the Off/On select is retired');
  assert.equal(doc.querySelector('[data-inv-toggle="unattendedGuardToggle"]'), null);
  assert.equal(doc.getElementById('unattendedGuardMinutesInput').disabled, false);
  assert.equal(doc.querySelector('[data-inv-toggle="use24HourTimeToggle"]').getAttribute('aria-checked'), 'true');
  assert.match(doc.querySelector('[data-settings-field="defaultRunModeSelect"] .settings-field-detail').dataset.tooltip, /The composer switcher changes the current chat\./);
  assert.equal(doc.querySelector('[data-default-run-mode-field]'), null);
  assert.equal(doc.querySelector('[data-settings-field="defaultRunModeSelect"] [data-setting-revert]').getAttribute('data-setting-revert-default'), 'Ask');
  for (const retired of ['resolveSafetyModeChangeEvent', 'resolveDefaultRunModeChangeEvent', 'resolveUnattendedGuardChangeEvent', 'resolveAutoApproveStreakCapChangeEvent', 'resolveUiLanguageChangeEvent', 'resolveWebSearchFieldChangeEvent']) {
    assert.equal(supportExports[retired], undefined, `${retired} is retired`);
  }
});


test('W2-2 contract 3 keeps rich file reading stored and disabled under its off parent', () => {
  const markup = buildToolConfigFieldListMarkup({ fields: getToolConfigFieldsForRender({}), tools: { fileTools: false, richFiles: true }, toggleSwitch });
  const doc = new JSDOM(markup).window.document;
  const toggle = doc.querySelector('[data-inv-toggle="settings-tool-config-richFiles"]');
  assert.equal(toggle.disabled, true);
  assert.equal(toggle.getAttribute('aria-checked'), 'true');
  const row = toggle.closest('.settings-field--row');
  assert.ok(row.classList.contains('settings-field--sub'));
  assert.equal(row.dataset.settingParentOff, 'true');
});


test('unknown tool keys keep encoded toggle ids and title wiring through the row primitive', () => {
  for (const key of ['future/tool', 'future.tool', "future'quote"]) {
    const id = `settings-tool-config-${encodeURIComponent(key)}`;
    const markup = buildToolConfigFieldListMarkup({ fields: [{ key, label: 'Future tool', helpText: '<untrusted help>' }], tools: { [key]: true } });
    const doc = new JSDOM(markup).window.document;
    const toggle = doc.querySelector('[data-inv-toggle]');
    assert.equal(toggle.dataset.invToggle, id);
    assert.match(doc.querySelector('.settings-field').dataset.settingsField, /^[A-Za-z0-9_-]+$/, 'the row id is a plain token');
    const title = doc.querySelector('.settings-field-title');
    assert.equal(title.htmlFor, toggle.id);
    assert.equal(doc.getElementById(title.htmlFor), toggle);
    assert.equal(doc.querySelector('.settings-field-help').textContent, '<untrusted help>');
    assert.equal(doc.querySelector('untrusted'), null);
  }
});

// The Tools page as one root: the Files rows (Rich file reading under File tools)
// and the web search section under Web tools, rendered for the given parent states.
function renderToolsRoot({ fileTools, web }) {
  const fields = getToolConfigFieldsForRender({}).filter((field) => ['fileTools', 'richFiles'].includes(field.key));
  const markup = buildToolConfigFieldListMarkup({ fields, tools: { fileTools, richFiles: true, web }, toggleSwitch })
    + buildWebSearchSectionMarkup({ visible: true, parentOff: !web, webSearch: { provider: 'google_pse' },
      selectField, textField, actionButton, settingsField, escapeHtml });
  const doc = new JSDOM(`<!doctype html><body><div id="toolsConfigFieldList">${markup}</div></body>`).window.document;
  return doc.getElementById('toolsConfigFieldList');
}
test('the search provider row takes the wide dropdown, so the longest provider name fits', () => {
  const root = renderToolsRoot({ fileTools: true, web: true });
  const row = root.querySelector('[data-settings-field="webSearchProviderSelect"]');
  assert.ok(row.classList.contains('settings-field--wide-control'));
  assert.ok(row.classList.contains('settings-field--sub'));
  // Google needs a key and an engine ID; only the key field asks for an API key.
  assert.equal(root.querySelector('[data-web-search-key-field="google_pse"]').placeholder, 'Enter API key');
  assert.equal(root.querySelector('[data-web-search-key-field="google_pse_cx"]').placeholder, '');
});

// What a person sees and a screen reader hears for each row and control.
function dependentState(root) {
  return Array.from(root.querySelectorAll('.settings-field, select, input, button, label.inv-toggle')).map((el) => [
    el.tagName, el.id || el.dataset.settingsField || '', el.getAttribute('data-setting-parent-off'), el.disabled === true,
    el.getAttribute('aria-disabled'), el.classList.contains('inv-toggle--disabled'),
  ]);
}
const barrelToggleSwitch = Object.assign((options) => toggleSwitch(options), { setDisabled: require('../renderer/inventory/toggle-switch').setDisabled });
const syncTools = (root, tools, availability = {}) => supportExports.syncToolDependents(root, {
  toolOn: (key) => tools[key] === true, availability, inventory: { toggleSwitch: barrelToggleSwitch } });

test('dependent rows follow their parent in place and match what a fresh render shows', () => {
  assert.deepEqual({ ...supportExports.TOOL_DEPENDENTS }, { richFiles: 'fileTools', commandSandbox: 'bash', webSearch: 'web' });
  assert.ok(Object.isFrozen(supportExports.TOOL_DEPENDENTS));
  const root = renderToolsRoot({ fileTools: false, web: false });
  const nodes = Array.from(root.querySelectorAll('*'));
  const track = root.querySelector('[data-inv-toggle="settings-tool-config-richFiles"]');
  const label = track.closest('label.inv-toggle');

  syncTools(root, { fileTools: true, web: true });
  assert.deepEqual(Array.from(root.querySelectorAll('*')), nodes, 'no node is created or removed');
  assert.deepEqual(dependentState(root), dependentState(renderToolsRoot({ fileTools: true, web: true })));
  assert.equal(track.disabled, false);
  assert.equal(track.hasAttribute('aria-disabled'), false);
  assert.equal(label.hasAttribute('aria-disabled'), false);
  assert.equal(label.classList.contains('inv-toggle--disabled'), false);
  assert.equal(track.getAttribute('aria-checked'), 'true', 'the stored value is kept');

  syncTools(root, { fileTools: false, web: false });
  assert.deepEqual(dependentState(root), dependentState(renderToolsRoot({ fileTools: false, web: false })));
  assert.equal(track.getAttribute('aria-disabled'), 'true');
  assert.equal(label.getAttribute('aria-disabled'), 'true');
  assert.ok(label.classList.contains('inv-toggle--disabled'));

  syncTools(root, { fileTools: true, web: true }, { richFiles: { enabled: false } });
  assert.equal(track.disabled, true, 'runtime availability still blocks the switch under an on parent');
  assert.equal(track.closest('.settings-field').hasAttribute('data-setting-parent-off'), false);
  assert.doesNotThrow(() => syncTools(null, {}));
  assert.doesNotThrow(() => syncTools(new JSDOM('<div></div>').window.document.body, {}));
});

test('the dependent sync leaves a write lock in place and the release reads the parent again', () => {
  const binding = require('../renderer/shell/renderer-settings-field-binding');
  const descriptor = require('../renderer/shell/renderer-settings-field-descriptors').getSettingDescriptor('settings-tool-config-richFiles');
  const root = renderToolsRoot({ fileTools: true, web: true });
  const track = root.querySelector('[data-inv-toggle="settings-tool-config-richFiles"]');
  const testButton = root.querySelector('[data-web-search-test]');
  binding.setRowBusy(root, descriptor, true);
  testButton.setAttribute('data-setting-busy', '');
  testButton.disabled = true;

  syncTools(root, { fileTools: false, web: false });
  syncTools(root, { fileTools: true, web: true });
  assert.equal(track.disabled, true, 'a write in flight keeps its lock when the parent turns on');
  assert.equal(testButton.disabled, true, 'a running connection test keeps its lock');

  binding.setRowBusy(root, descriptor, false);
  assert.equal(track.disabled, false, 'the release enables the switch under an on parent');
});
