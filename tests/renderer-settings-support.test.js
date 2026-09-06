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
} = require('../renderer/shell/renderer-settings-support');
const { toggleSwitch } = require('../renderer/inventory/toggle-switch');
const selectField = require('../renderer/inventory/select-field');
const textField = require('../renderer/inventory/text-field');
const actionButton = require('../renderer/inventory/action-button');

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

test('buildSettingsToggleListMarkup renders one inventory switch per field and drops id-less rows', () => {
  const markup = buildSettingsToggleListMarkup({
    fields: [
      { id: 'aToggle', label: 'A', tooltip: 'Hover text', checked: true },
      { id: 'bToggle', label: 'B', checked: false, disabled: true },
      { id: '', label: 'no id' },
    ],
    toggleSwitch,
    escapeHtml,
  });
  const doc = new JSDOM(`<!doctype html><body>${markup}</body>`).window.document;
  const toggles = doc.querySelectorAll('[data-inv-toggle]');
  assert.equal(toggles.length, 2, 'id-less field is dropped');
  assert.equal(doc.querySelector('label.inv-toggle').getAttribute('title'), 'Hover text');
  assert.equal(doc.querySelector('[data-inv-toggle="aToggle"]').getAttribute('aria-checked'), 'true');
  const b = doc.querySelector('[data-inv-toggle="bToggle"]');
  assert.equal(b.getAttribute('aria-checked'), 'false');
  assert.equal(b.disabled, true, 'disabled lands on the track button');
});

test('buildSettingsToggleListMarkup degrades to a note when no toggle renderer is available', () => {
  const markup = buildSettingsToggleListMarkup({ fields: [{ id: 'x', label: 'X' }], escapeHtml });
  assert.match(markup, /class="settings-note"/);
  assert.doesNotMatch(markup, /data-inv-toggle/);
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

  // runtime = the 2 expert diagnostics toggles, both disabled in this case
  assert.equal(runtime.querySelectorAll('[data-inv-toggle]').length, 2);
  assert.equal(runtime.querySelector('[data-inv-toggle="contextTokenBudgetToggle"]').getAttribute('aria-checked'), 'true');
  assert.equal(runtime.querySelector('[data-inv-toggle="contextTokenBudgetToggle"]').disabled, true);
});

test('web search provider markup nests a bounded connection test in Web tools', () => {
  const markup = buildWebSearchSectionMarkup({
    visible: true,
    webSearch: { provider: 'duckduckgo' },
    selectField,
    textField,
    actionButton,
    escapeHtml,
  });
  const doc = new JSDOM(`<!doctype html><body>${markup}</body>`).window.document;
  assert.equal(doc.querySelector('[data-web-search-test]')?.textContent.trim(), 'Test connection');
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
      'imageRead', 'fileTools', 'richFiles', 'web', 'pythonRuntime',
      'worktree', 'subagents', 'bash', 'lsp',
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
  const row = dom.window.document.querySelector('[data-tool-config-key="web"]');
  const toggle = dom.window.document.querySelector('[data-inv-toggle="settings-tool-config-web"]');

  assert.ok(row);
  assert.ok(toggle);
  assert.equal(toggle.getAttribute('aria-checked'), 'true');
  assert.equal(toggle.hasAttribute('disabled'), true);
  assert.match(row.innerHTML, /Live &lt;web&gt;/);
  assert.match(row.innerHTML, /Use &lt;live&gt; lookup\./);
});

test('tool config field list escapes help text with its built-in fallback', () => {
  const markup = buildToolConfigFieldListMarkup({
    fields: [
      {
        key: 'web',
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
