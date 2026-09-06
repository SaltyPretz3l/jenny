'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

global.inventoryActionButton = ({ label = '', dataset = {}, trustedHtml = '' }) => {
  const attrs = Object.entries(dataset).map(([key, value]) => ` data-${key}="${value}"`).join('');
  return `<button type="button"${attrs}>${trustedHtml || label}</button>`;
};
global.inventoryActionButton.escapeHtml = require('../renderer/inventory/action-button').escapeHtml;

const {
  createPluginSessionController,
  providerRows,
} = require('../renderer/shell/renderer-plugin-session-controller');

const SNAPSHOT = {
  ok: true,
  plugins: [{
    publisher_id: 'jenny-official',
    plugin_id: 'local-image-generation',
    generation_id: 'generation_1',
    contributions: [{
      contribution_id: 'local_image_generation',
      display_name: 'Image',
      kind: 'session_provider',
      effective_enabled: true,
    }],
  }],
};

function pluginSession(id = 'session_1') {
  return {
    id,
    session_type: 'plugin',
    plugin_session: {
      publisher_id: 'jenny-official',
      plugin_id: 'local-image-generation',
      provider_contribution_id: 'local_image_generation',
      view_contribution_id: 'image_workspace',
      provider_name: 'Local image generation',
      icon_token: 'image',
    },
  };
}

function harness({ snapshot = SNAPSHOT } = {}) {
  const dom = new JSDOM(`<!doctype html><body>
    <span id="pluginSessionProviderActions"></span>
    <div id="pluginSessionFallback" hidden><p data-plugin-session-fallback-copy></p>
      <span id="pluginSessionFallbackAction"></span></div>
  </body>`);
  const { window } = dom;
  let currentSnapshot = snapshot;
  let changed = null;
  window.jennyShell = { plugins: {
    getState: async () => currentSnapshot,
    onChanged: (callback) => { changed = callback; return () => { changed = null; }; },
  } };
  const state = { currentSessionId: '', sessions: [], ui: { activeView: 'chat' } };
  const calls = [];
  let activeSessionId = '';
  let closeResult = { ok: true };
  const viewHost = {
    getActiveSessionId: () => activeSessionId,
    open: async (request) => { calls.push(['open', request]); activeSessionId = request.sessionId; return { ok: true }; },
    close: async (...args) => { calls.push(['close', ...args]); if (closeResult.ok) activeSessionId = ''; return closeResult; },
  };
  const controller = createPluginSessionController({ windowRef: window,
    documentRef: window.document, state, viewHost, callbacks: {
      handleCreateSession: async (request) => {
        calls.push(['create', request]);
        const session = pluginSession();
        state.sessions = [session];
        state.currentSessionId = session.id;
        return session.id;
      },
      setActiveView: (view) => { state.ui.activeView = view; calls.push(['view', view]); },
      showToastMessage: (message) => calls.push(['toast', message]),
      openSettingsSection: (section) => calls.push(['settings', section]),
    } });
  return { controller, window, state, calls, viewHost,
    setSnapshot: (value) => { currentSnapshot = value; },
    emitChanged: () => changed?.(),
    setCloseResult: (value) => { closeResult = value; },
  };
}

test('provider discovery exposes only effective session providers', () => {
  const rows = providerRows({ ok: true, plugins: [{ ...SNAPSHOT.plugins[0], contributions: [
    ...SNAPSHOT.plugins[0].contributions,
    { contribution_id: 'off', kind: 'session_provider', effective_enabled: false },
    { contribution_id: 'panel', kind: 'panel', effective_enabled: true },
  ] }] });
  assert.deepEqual(rows, [{
    publisherId: 'jenny-official', pluginId: 'local-image-generation',
    providerContributionId: 'local_image_generation', generationId: 'generation_1',
    displayName: 'Image',
  }]);
});

test('provider action creates with exact authority then opens the bound panel with session id', async () => {
  const h = harness();
  h.controller.bind();
  await h.controller.syncProviders();
  h.window.document.querySelector('[data-plugin-session-action="new-plugin-session"]')
    .dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setImmediate(resolve));
  const create = h.calls.find(([kind]) => kind === 'create')[1];
  assert.deepEqual(create.providerAuthority, {
    publisher_id: 'jenny-official', plugin_id: 'local-image-generation',
    provider_contribution_id: 'local_image_generation', active_generation_id: 'generation_1',
  });
  const open = h.calls.find(([kind]) => kind === 'open')[1];
  assert.equal(open.contribution_id, 'image_workspace');
  assert.equal(open.sessionId, 'session_1');
  h.controller.dispose();
});

test('missing provider keeps an ordinary read-only transcript and offers plugin management', async () => {
  const h = harness({ snapshot: { ok: true, plugins: [] } });
  h.state.sessions = [pluginSession()];
  h.state.currentSessionId = 'session_1';
  h.controller.bind();
  const result = await h.controller.openSessionView('session_1');
  assert.equal(result.fallback, true);
  assert.equal(h.state.ui.activeView, 'chat');
  const notice = h.window.document.getElementById('pluginSessionFallback');
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /missing, disabled, or incompatible/);
  h.controller.dispose();
});

test('session leave is fail-closed when native cleanup is unproven', async () => {
  const h = harness();
  h.state.sessions = [pluginSession()];
  h.state.currentSessionId = 'session_1';
  h.controller.bind();
  await h.controller.openSessionView('session_1');
  h.setCloseResult({ ok: false, reason: 'tree_death_unproven' });
  assert.equal(await h.controller.guardLeaveSession('session_1', 'switch'), false);
  assert.ok(h.calls.some(([kind]) => kind === 'toast'));
  h.controller.dispose();
});

test('disposed provider refresh cannot mutate the create-action slot', async () => {
  const h = harness();
  h.controller.bind();
  h.controller.dispose();
  h.setSnapshot(SNAPSHOT);
  h.emitChanged();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.window.document.getElementById('pluginSessionProviderActions').innerHTML, '');
});
