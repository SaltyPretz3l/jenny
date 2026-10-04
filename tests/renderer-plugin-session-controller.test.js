'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

global.inventoryActionButton = ({ label = '', dataset = {}, trustedHtml = '' }) => {
  const attrs = Object.entries(dataset).map(([key, value]) => ` data-${key}="${value}"`).join('');
  return `<button type="button"${attrs}>${trustedHtml || label}</button>`;
};
global.inventoryActionButton.escapeHtml = require('../renderer/inventory/action-button').escapeHtml;

const { createPluginSessionController } = require('../renderer/shell/renderer-plugin-session-controller');

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

function harness() {
  const dom = new JSDOM(`<!doctype html><body>
    <span id="pluginSessionProviderActions"></span>
    <div id="pluginSessionFallback" hidden><p data-plugin-session-fallback-copy></p>
      <span id="pluginSessionFallbackAction"></span></div>
  </body>`);
  const { window } = dom;
  let providerQueries = 0;
  window.jennyShell = { plugins: {
    getState: async () => { providerQueries += 1; return { ok: true, plugins: [] }; },
    onChanged: () => { providerQueries += 1; return () => {}; },
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
      setActiveView: (view) => { state.ui.activeView = view; calls.push(['view', view]); },
      showToastMessage: (message) => calls.push(['toast', message]),
      openSettingsSection: (section) => calls.push(['settings', section]),
    } });
  return { controller, window, state, calls, viewHost,
    providerQueries: () => providerQueries,
    activate: (id) => { activeSessionId = id; },
    setCloseResult: (value) => { closeResult = value; },
  };
}

test('a saved plugin session opens as a read-only transcript with the existing toast and notice', async () => {
  const h = harness();
  h.state.sessions = [pluginSession()];
  h.state.currentSessionId = 'session_1';
  h.controller.bind();
  const result = await h.controller.openSessionView('session_1');
  assert.deepEqual(result, { ok: false, reason: 'session_provider_unavailable', fallback: true });
  assert.equal(h.state.ui.activeView, 'chat');
  assert.ok(!h.calls.some(([kind]) => kind === 'open'), 'no provider view is ever opened');
  assert.deepEqual(h.calls.find(([kind]) => kind === 'toast')[1],
    'This plugin is unavailable. The saved transcript remains readable.');
  const notice = h.window.document.getElementById('pluginSessionFallback');
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /missing, disabled, or incompatible/);
  assert.match(notice.textContent, /Manage plugins/);
  h.controller.dispose();
});

test('the notice offers only Manage plugins, and it opens the plugins settings section', async () => {
  const h = harness();
  h.state.sessions = [pluginSession()];
  h.state.currentSessionId = 'session_1';
  h.controller.bind();
  const buttons = h.window.document.querySelectorAll('[data-plugin-session-action]');
  assert.deepEqual([...buttons].map((button) => button.dataset.pluginSessionAction), ['manage-plugins']);
  buttons[0].dispatchEvent(new h.window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(h.calls.find(([kind]) => kind === 'settings'), ['settings', 'plugins']);
  h.controller.dispose();
});

test('non-plugin sessions and background opens do not trigger the fallback', async () => {
  const h = harness();
  h.state.sessions = [{ id: 'chat_1', session_type: 'chat' }, pluginSession()];
  h.controller.bind();
  assert.equal((await h.controller.openSessionView('chat_1')).reason, 'not_plugin_session');
  assert.equal((await h.controller.openSessionView('session_1', { userInitiated: false })).skipped, true);
  assert.equal(h.calls.length, 0);
  assert.equal(h.window.document.getElementById('pluginSessionFallback').hidden, true);
  h.controller.dispose();
});

test('the controller no longer resolves providers or renders create actions', async () => {
  const h = harness();
  h.controller.bind();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.providerQueries(), 0);
  assert.equal(h.window.document.getElementById('pluginSessionProviderActions').innerHTML, '');
  assert.equal(h.controller.createSession, undefined);
  assert.equal(h.controller.syncProviders, undefined);
  h.controller.dispose();
});

test('session leave stays fail-closed if a view host still reports an active session', async () => {
  const h = harness();
  h.state.sessions = [pluginSession()];
  h.state.currentSessionId = 'session_1';
  h.controller.bind();
  assert.equal(await h.controller.guardLeaveSession('session_1', 'switch'), true);
  h.activate('session_1');
  h.setCloseResult({ ok: false, reason: 'tree_death_unproven' });
  assert.equal(await h.controller.guardLeaveSession('session_1', 'switch'), false);
  assert.ok(h.calls.some(([kind]) => kind === 'toast'));
  h.controller.dispose();
});
