const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  READINESS_SECTION_ID,
  READY_ITEM_ID,
  buildSettingsControlTowerModel,
  renderSettingsControlTowerMarkup,
  syncSettingsControlTowerIndicators,
} = require('../renderer/shell/renderer-settings-control-tower-utils');
const statusRow = require('../renderer/inventory/status-row');
const actionButton = require('../renderer/inventory/action-button');
const badge = require('../renderer/inventory/badge');

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function itemIds(model) {
  return model.items.map((item) => item.id);
}

const READY_STATE = Object.freeze({
  models: { status: { currentModel: 'llama3' } },
  setup: { loaded: true, setupComplete: true },
  featureState: {
    tools: { web: true },
    availability: { web: { enabled: true } },
  },
  workspaceRoot: { path: 'C:\\dev\\jenny', status: 'ready' },
  offline: { localOnly: false, localReady: true },
  speech: { available: true },
  memories: { ready: true },
  proactive: { ready: true },
  skills: { ready: true },
});

test('Readiness lists each area as a success row when nothing needs attention', () => {
  const model = buildSettingsControlTowerModel({ state: { ...READY_STATE, backend: { phase: 'ready' } } });

  assert.equal(model.tone, 'ready');
  assert.equal(model.summaryLabel, 'Ready');
  assert.equal(model.attentionCount, 0);
  assert.equal(model.readyCount, 7);
  assert.deepEqual(itemIds(model), ['model-ready', 'workspace-ready', 'tools-ready', 'setup-ready', 'memory-ready', 'proactive-ready', 'skills-ready']);
  assert.equal(READY_ITEM_ID, 'model-ready');
  assert.ok(model.items.every((item) => item.tone === 'success'));
  assert.deepEqual(model.items.map((item) => item.sectionId), ['models', 'tools', 'tools', 'account', '__memory', 'proactive', 'skills']);
  assert.deepEqual(model.items.map((item) => item.actionLabel), ['Review models', 'Open tools', 'Review tools', 'Open profile', 'Open memories', 'Check proactive', 'Open skills']);
  assert.equal(model.items[0].message, 'llama3 is the active model.');
  assert.equal(model.items[1].message, 'C:\\dev\\jenny');
  assert.equal(model.items[2].message, 'No enabled tool is blocked.');
  assert.equal(model.items[3].message, 'First-run setup is complete.');
  assert.equal(model.badgeText, '', 'the nav badge is empty at zero');
  assert.equal(model.badgeTone, '');

  const markup = renderSettingsControlTowerMarkup(model, { escapeHtml, statusRow, actionButton });
  const doc = new JSDOM(`<!doctype html><body>${markup}</body>`).window.document;
  const rows = [...doc.querySelectorAll('.settings-control-tower-row')];
  assert.equal(rows.length, 7);
  rows.forEach((row, index) => {
    assert.equal(row.getAttribute('data-tone'), 'success');
    assert.ok(row.querySelector('.inv-status-row-dot'), 'rows lead with the status-row tone dot');
    assert.equal(
      row.querySelector('[data-settings-control-section]').getAttribute('data-settings-control-section'),
      model.items[index].sectionId,
    );
  });
  assert.match(rows[0].textContent, /llama3/);
  assert.match(rows[1].textContent, /C:\\dev\\jenny/);
  assert.equal(doc.querySelector('.settings-control-tower-badge'), null, 'no uppercase pill badges');
});

test('Readiness lists Force local as ready only while it is on', () => {
  const on = buildSettingsControlTowerModel({ state: { ...READY_STATE, offline: { localOnly: true, localReady: true } } });
  assert.equal(on.attentionCount, 0);
  assert.deepEqual(itemIds(on).slice(4), ['local-only-ready', 'memory-ready', 'proactive-ready', 'skills-ready']);
  const row = on.items.find((item) => item.id === 'local-only-ready');
  assert.deepEqual([row.sectionId, row.tone, row.actionLabel], ['offline', 'success', 'Check local model']);
  assert.equal(itemIds(buildSettingsControlTowerModel({ state: READY_STATE })).includes('local-only-ready'), false);
});

test('Readiness omits the rows whose state is not known', () => {
  const model = buildSettingsControlTowerModel({
    state: {
      models: { status: { currentModel: 'llama3' } },
      setup: { loaded: false },
    },
  });

  assert.equal(model.attentionCount, 0);
  assert.deepEqual(itemIds(model), ['model-ready', 'tools-ready']);
  assert.equal(model.readyCount, 2);
});

test('Readiness lists only the warning when one area needs attention', () => {
  const model = buildSettingsControlTowerModel({
    state: { ...READY_STATE, models: { status: { currentModel: '' } } },
  });

  assert.deepEqual(itemIds(model), ['model-unavailable']);
  assert.equal(model.readyCount, 0);
  assert.equal(model.items[0].tone, 'warning');
});

test('backend phase is not a readiness check: starting and ready produce identical models', () => {
  // The toprail health pill owns runtime state. A positive equality assertion,
  // not an absence check on an id that a rename would make vacuous.
  const starting = buildSettingsControlTowerModel({ state: { ...READY_STATE, backend: { phase: 'starting' } } });
  const ready = buildSettingsControlTowerModel({ state: { ...READY_STATE, backend: { phase: 'ready' } } });
  assert.deepEqual(starting, ready);
  assert.equal(starting.attentionCount, 0);

  const noModel = buildSettingsControlTowerModel({
    state: { backend: { phase: 'starting' }, models: { status: { currentModel: '' } }, setup: { loaded: true, setupComplete: true } },
  });
  assert.deepEqual(itemIds(noModel), ['model-unavailable'], 'only the model check fires while the backend starts');
  assert.equal(noModel.items[0].actionLabel, 'Choose a model');
  assert.equal(noModel.summaryLabel, '1 to review');
  assert.equal(noModel.badgeText, '1');
  assert.equal(noModel.badgeTone, 'warning');
});

test('Readiness groups missing workspace and blocked tools as one cause', () => {
  const model = buildSettingsControlTowerModel({
    state: {
      models: { status: { currentModel: 'llama3' } },
      setup: { loaded: true, setupComplete: true },
      workspaceRoot: { path: 'C:\\dev\\jenny', status: { state: 'invalid' } },
      featureState: {
        tools: { read_file: true, write_file: true },
        availability: {
          tools: {
            read_file: { enabled: false, workspaceRootRequired: true },
            write_file: { enabled: false, workspaceRootRequired: true },
          },
        },
      },
    },
  });

  assert.deepEqual(itemIds(model), ['workspace-missing']);
  assert.equal(model.attentionCount, 1);
  assert.equal(model.summaryLabel, '1 to review');
  assert.equal(model.badgeText, '1');
  assert.equal(model.items[0].sectionId, 'tools');
  assert.equal(model.items[0].label, 'No workspace folder');
  assert.equal(model.items[0].message, 'File tools need a folder to work in. Also blocks: 2 enabled tools (read_file, write_file).');
});

test('Readiness explains chat and file capabilities instead of an attention summary', () => {
  const model = buildSettingsControlTowerModel({ state: { ...READY_STATE, workspaceRoot: { status: 'missing' } } });
  const doc = new JSDOM(renderSettingsControlTowerMarkup(model, { statusRow, actionButton, badge })).window.document;
  const chips = [...doc.querySelectorAll('.inv-badge')];
  assert.deepEqual(chips.map((chip) => chip.textContent), ['Chat ready', 'File tools need a folder']);
  assert.ok(chips[0].classList.contains('inv-badge--success'));
  assert.ok(chips[1].classList.contains('inv-badge--warning'));
  assert.equal(doc.querySelector('.settings-control-tower-summary'), null);
});

test('Readiness setup action resumes setup and retains its account fallback', () => {
  const model = buildSettingsControlTowerModel({ state: { ...READY_STATE, setup: { loaded: true, setupComplete: false } } });
  const doc = new JSDOM(renderSettingsControlTowerMarkup(model, { statusRow, actionButton, badge })).window.document;
  const row = doc.querySelector('[data-control-tower-item="setup-incomplete"]');
  assert.equal(row.querySelector('.inv-status-row-label').textContent, 'Setup not finished');
  const action = row.querySelector('[data-settings-control-action="resume-setup"]');
  assert.ok(action);
  assert.equal(action.textContent, 'Resume setup');
  assert.equal(action.dataset.settingsControlSection, 'account');
});

test('Readiness capabilities cover ready, unknown, and independently blocked tools', () => {
  const cases = [
    [READY_STATE, ['Chat ready', 'File tools ready'], true],
    [{ models: { currentModel: 'llama3' } }, ['Chat ready'], true],
    [{ ...READY_STATE, models: {} }, ['Chat needs a model', 'File tools ready'], false],
    [{ ...READY_STATE, featureState: { tools: { web: true }, availability: { tools: { web: { enabled: false } } } } }, ['Chat ready', 'Some tools are blocked'], false],
  ];
  for (const [state, labels, ready] of cases) {
    const model = buildSettingsControlTowerModel({ state });
    const doc = new JSDOM(renderSettingsControlTowerMarkup(model, { statusRow, actionButton, badge })).window.document;
    assert.deepEqual([...doc.querySelectorAll('.inv-badge')].map((chip) => chip.textContent), labels);
    assert.equal(Boolean(doc.querySelector('.settings-control-tower-summary')), ready);
    if (ready) assert.equal(doc.querySelector('.settings-control-tower-summary').textContent, 'Settings are ready for the current local-first workflow.');
    if (labels.includes('Some tools are blocked')) assert.deepEqual(itemIds(model), ['tools-blocked']);
  }
});

test('Readiness groups only enabled blocked tools, with singular copy and at most three escaped names', () => {
  const state = { ...READY_STATE, workspaceRoot: { status: 'missing' }, tools: { one: true, disabled: false }, toolAvailability: { one: { enabled: false, workspaceRootRequired: true }, disabled: { enabled: false, workspaceRootRequired: true } }, featureState: undefined };
  const single = buildSettingsControlTowerModel({ state });
  assert.equal(single.items[0].message, 'File tools need a folder to work in. Also blocks: 1 enabled tool (one).');
  const names = ['<read>', 'write', 'list', 'search'];
  const many = buildSettingsControlTowerModel({ state: { ...state, tools: Object.fromEntries(names.map((name) => [name, true])), toolAvailability: Object.fromEntries(names.map((name) => [name, { enabled: false, workspaceRootRequired: true }])) } });
  assert.equal(many.items[0].message, 'File tools need a folder to work in. Also blocks: 4 enabled tools (<read>, write, list, …).');
  const doc = new JSDOM(renderSettingsControlTowerMarkup(many, { statusRow, actionButton, badge })).window.document;
  assert.equal(doc.querySelector('read'), null);
  assert.match(doc.body.textContent, /\(<read>, write, list, …\)/);
});

test('Readiness keeps tools blocked for other reasons in their own row while the folder is missing', () => {
  const model = buildSettingsControlTowerModel({ state: { ...READY_STATE, workspaceRoot: { status: 'missing' }, featureState: undefined,
    tools: { read_file: true, mac_only: true },
    toolAvailability: { read_file: { enabled: false, workspaceRootRequired: true }, mac_only: { enabled: false } } } });
  assert.deepEqual(model.items.map((item) => item.id), ['workspace-missing', 'tools-blocked']);
  assert.match(model.items[0].message, /Also blocks: 1 enabled tool \(read_file\)\./);
  assert.match(model.items[1].message, /^1 enabled tool is blocked/);
});

test('Readiness resume dispatch uses the existing setup callback and falls back to account', async (t) => {
  const { createSettingsEventBindings } = require('../renderer/shell/renderer-settings-event-utils');
  const dom = new JSDOM('<div id="settings"><span role="button" tabindex="0" data-settings-control-section="account" data-settings-control-action="resume-setup">Resume setup</span></div>');
  const previous = { window: global.window, document: global.document, AbortController: global.AbortController };
  Object.assign(global, { window: dom.window, document: dom.window.document, AbortController: dom.window.AbortController });
  const settingsView = dom.window.document.getElementById('settings');
  const calls = [];
  let bindings;
  t.after(() => { bindings?.dispose(); Object.assign(global, previous); dom.window.close(); });
  function bind(callbacks) {
    bindings = createSettingsEventBindings({
      state: { ui: {}, features: {} }, dom: { settingsView }, constants: { TOAST_SOURCE: {} },
      callbacks: { openSettingsSection: (...args) => calls.push(args), ...callbacks },
    });
    bindings.bind();
  }
  bind({ handleRunSetupAgain: () => calls.push('resume') });
  const action = settingsView.firstElementChild;
  action.click();
  action.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await Promise.resolve();
  assert.deepEqual(calls, ['resume', 'resume']);
  bindings.dispose();
  action.click();
  assert.equal(calls.length, 2, 'dispose removes readiness handlers');
  calls.length = 0;
  bind({});
  action.click();
  assert.deepEqual(calls, [['account', { source: 'control_tower' }]]);
});

test('Readiness workspace row opens the folder picker and falls back to Tools', async (t) => {
  const { createSettingsEventBindings } = require('../renderer/shell/renderer-settings-event-utils');
  const model = buildSettingsControlTowerModel({ state: { models: { status: { currentModel: 'llama3' } }, workspaceRoot: '' } });
  const html = renderSettingsControlTowerMarkup(model, { actionButton, statusRow, badge });
  const dom = new JSDOM('<div id="settings">' + html + '</div>');
  const previous = { window: global.window, document: global.document, AbortController: global.AbortController };
  Object.assign(global, { window: dom.window, document: dom.window.document, AbortController: dom.window.AbortController });
  const settingsView = dom.window.document.getElementById('settings');
  const calls = [];
  let bindings;
  t.after(() => { bindings?.dispose(); Object.assign(global, previous); dom.window.close(); });
  function bind(callbacks) {
    bindings = createSettingsEventBindings({
      state: { ui: {}, features: {} }, dom: { settingsView }, constants: { TOAST_SOURCE: {} },
      callbacks: { openSettingsSection: (...args) => calls.push(args), ...callbacks },
    });
    bindings.bind();
  }
  const action = settingsView.querySelector('[data-control-tower-item="workspace-missing"] [data-settings-control-action="choose-workspace"]');
  assert.ok(action, 'the workspace row carries the choose-folder action');
  assert.equal(action.textContent.trim(), 'Choose folder');
  bind({ handleWorkspaceRootChoose: () => calls.push('choose') });
  action.click();
  await Promise.resolve();
  assert.deepEqual(calls, ['choose']);
  bindings.dispose();
  calls.length = 0;
  bind({});
  action.click();
  assert.deepEqual(calls, [['tools', { source: 'control_tower' }]]);
});

test('Readiness flags setup, local-only, and partial panes; partial panes are informational', () => {
  const model = buildSettingsControlTowerModel({
    state: {
      models: { status: { currentModel: 'llama3' } },
      setup: { loaded: true, setupComplete: false },
      workspaceRoot: { path: 'C:\\dev\\jenny', status: 'ready' },
      offline: { mode: 'local_only', localChatReady: false },
      settingsRefresh: {
        degradedBySection: {
          diagnostics: [{ source: 'phase_percentiles', message: 'offline' }],
          cost: [{ source: 'observability', message: 'offline' }],
        },
      },
    },
  });

  assert.deepEqual(itemIds(model), ['setup-incomplete', 'local-only-not-ready', 'settings-refresh-degraded']);
  assert.equal(model.items[0].sectionId, 'account');
  assert.equal(model.items[1].sectionId, 'offline');
  assert.equal(model.items[2].tone, 'pending');
  assert.equal(model.items[2].sectionId, '__diagnostics');
  assert.equal(model.items[2].message, '2 settings panes have partial data. The rows you can see are still current.');
  assert.equal(model.badgeTone, 'warning', 'any warning row makes the badge amber');
});

test('only informational rows give the badge the pending tone', () => {
  const model = buildSettingsControlTowerModel({
    state: {
      ...READY_STATE,
      settingsRefresh: { degradedBySection: { cost: [{ source: 'observability' }] } },
    },
  });
  assert.deepEqual(itemIds(model), ['settings-refresh-degraded']);
  assert.equal(model.badgeText, '1');
  assert.equal(model.badgeTone, 'pending');
});

test('Readiness accepts current renderer model and memory manager shapes', () => {
  const model = buildSettingsControlTowerModel({
    state: {
      modelList: { active_model: 'llama3.1' },
      setup: { loaded: true, setupComplete: true },
      workspaceRoot: { path: 'C:\\dev\\jenny', status: { state: 'ready' } },
      featureState: {
        tools: { web: true },
        availability: { tools: { web: { enabled: true } } },
      },
      memoryManager: { unavailable: true, status: 'Sidecar unavailable' },
    },
  });

  assert.equal(model.tone, 'attention');
  assert.deepEqual(itemIds(model), ['memory-not-ready']);
  assert.equal(model.items[0].sectionId, '__memory');
});

test('Readiness renders safe deep-link actions', () => {
  const markup = renderSettingsControlTowerMarkup({
    summaryLabel: '1 to review',
    summaryMessage: 'Review <settings>',
    tone: 'attention',
    attentionCount: 1,
    items: [
      {
        id: 'unsafe',
        label: 'Workspace <root>',
        message: 'Set a workspace root',
        tone: 'warning',
        sectionId: 'tools',
        actionLabel: 'Set a workspace root',
      },
    ],
  }, { escapeHtml, statusRow, actionButton });
  const dom = new JSDOM(`<!doctype html><body>${markup}</body>`);
  const action = dom.window.document.querySelector('[data-settings-control-section="tools"]');

  assert.ok(action);
  assert.equal(action.textContent.trim(), 'Set a workspace root');
  assert.equal(dom.window.document.body.textContent.includes('Workspace <root>'), true);
  assert.equal(dom.window.document.body.innerHTML.includes('Workspace <root>'), false);
  assert.equal(dom.window.document.body.innerHTML.includes('Review <settings>'), false);
});

test('indicator sync paints the card-header badge and the nav count badge from one model', () => {
  const dom = new JSDOM(`<!doctype html><body>
    <nav class="settings-nav">
      <button class="settings-nav-item" data-settings-section="readiness"><span class="settings-nav-item-label">Readiness</span><span class="settings-nav-item-badge" data-tone=""></span></button>
    </nav>
    <span class="settings-badge" id="readinessBadge" data-state="pending">Checking</span>
  </body>`);
  const documentRef = dom.window.document;
  const { setNavItemBadge } = require('../renderer/shell/renderer-settings-nav-utils.js');
  const headerBadge = documentRef.getElementById('readinessBadge');
  const navBadge = documentRef.querySelector('.settings-nav-item-badge');

  const attention = buildSettingsControlTowerModel({
    state: { models: { status: { currentModel: '' } }, setup: { loaded: true, setupComplete: true } },
  });
  syncSettingsControlTowerIndicators(attention, { documentRef, setNavItemBadge });
  assert.equal(headerBadge.textContent, '1 to review');
  assert.equal(headerBadge.getAttribute('data-state'), 'warning');
  assert.equal(navBadge.textContent, '1');
  assert.equal(navBadge.getAttribute('data-tone'), 'warning');

  const ready = buildSettingsControlTowerModel({ state: READY_STATE });
  syncSettingsControlTowerIndicators(ready, { documentRef, setNavItemBadge });
  assert.equal(headerBadge.textContent, 'Ready');
  assert.equal(headerBadge.getAttribute('data-state'), 'success');
  assert.equal(navBadge.textContent, '', 'slot stays in the DOM, empty');
  assert.equal(navBadge.getAttribute('data-tone'), '');
  assert.ok(documentRef.querySelector('.settings-nav-item-badge'), 'slot never removed');
  assert.equal(READINESS_SECTION_ID, 'readiness');
});

test('Readiness names folder-blocked tools by their Tools-page labels', () => {
  const model = buildSettingsControlTowerModel({ state: { ...READY_STATE, workspaceRoot: { status: 'missing' }, featureState: undefined,
    tools: { richFiles: true, subagents: true },
    toolAvailability: { richFiles: { enabled: false, workspaceRootRequired: true }, subagents: { enabled: false, workspaceRootRequired: true } } } });
  assert.match(model.items[0].message, /\(Rich file reading, Delegated research\)\./);
});
