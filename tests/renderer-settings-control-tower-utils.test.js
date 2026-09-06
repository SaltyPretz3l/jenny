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

test('Readiness reports the ready state as one visible success row, never an empty list', () => {
  const model = buildSettingsControlTowerModel({ state: { ...READY_STATE, backend: { phase: 'ready' } } });

  assert.equal(model.tone, 'ready');
  assert.equal(model.summaryLabel, 'Ready');
  assert.equal(model.attentionCount, 0);
  assert.deepEqual(itemIds(model), [READY_ITEM_ID]);
  assert.equal(model.items[0].tone, 'success');
  assert.equal(model.items[0].sectionId, 'models');
  assert.equal(model.badgeText, '', 'the nav badge is empty at zero');
  assert.equal(model.badgeTone, '');

  const markup = renderSettingsControlTowerMarkup(model, { escapeHtml, statusRow, actionButton });
  const doc = new JSDOM(`<!doctype html><body>${markup}</body>`).window.document;
  const row = doc.querySelector(`[data-control-tower-item="${READY_ITEM_ID}"]`);
  assert.ok(row, 'the ready row is real markup');
  assert.equal(row.getAttribute('data-tone'), 'success');
  assert.ok(row.querySelector('.inv-status-row-dot'), 'rows lead with the status-row tone dot');
  assert.match(row.textContent, /Everything's ready/);
  assert.equal(doc.querySelector('.settings-control-tower-badge'), null, 'no uppercase pill badges');
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

test('Readiness flags workspace and blocked tools together', () => {
  const model = buildSettingsControlTowerModel({
    state: {
      models: { status: { currentModel: 'llama3' } },
      setup: { loaded: true, setupComplete: true },
      workspaceRoot: { path: 'C:\\dev\\jenny', status: { state: 'invalid' } },
      featureState: {
        tools: { web: true, pythonRuntime: true },
        availability: {
          tools: {
            web: { enabled: false, reason: 'workspace_root_missing' },
            pythonRuntime: { enabled: false, reason: 'workspace_root_missing' },
          },
        },
      },
    },
  });

  assert.deepEqual(itemIds(model), ['workspace-missing', 'tools-blocked']);
  assert.equal(model.items[0].sectionId, 'tools');
  assert.equal(model.items[1].message, '2 enabled tools are blocked by current settings or workspace readiness.');
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
