'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createPluginSessionController } = require('../renderer/shell/renderer-plugin-session-controller');

function pluginSession(id = 'session_1') {
  return {
    id,
    session_type: 'plugin',
    plugin_session: {
      publisher_id: 'jenny-official',
      plugin_id: 'local-image-generation',
      provider_name: 'Local image generation',
    },
  };
}

function harness() {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="pluginSessionFallback" hidden><p data-plugin-session-fallback-copy></p></div>
  </body>`);
  const { window } = dom;
  const state = { currentSessionId: '', sessions: [], ui: { activeView: 'chat' } };
  const controller = createPluginSessionController({ windowRef: window, documentRef: window.document, state });
  return { controller, window, state, notice: () => window.document.getElementById('pluginSessionFallback') };
}

test('an old image chat shows the read-only notice with no action button', () => {
  const h = harness();
  h.state.sessions = [pluginSession()];
  h.state.currentSessionId = 'session_1';
  h.controller.bind();
  assert.equal(h.notice().hidden, false);
  assert.equal(h.notice().textContent.trim(), 'This chat came from the retired image plugin and is read-only.');
  assert.equal(h.notice().querySelector('button'), null);
  h.controller.dispose();
});

test('the notice stays hidden for ordinary chats and outside the chat view', () => {
  const h = harness();
  h.state.sessions = [{ id: 'chat_1', session_type: 'chat' }, pluginSession('session_1')];
  h.state.currentSessionId = 'chat_1';
  h.controller.bind();
  assert.equal(h.notice().hidden, true);
  assert.equal(h.controller.isPluginSession(), false);
  assert.equal(h.controller.isPluginSession('session_1'), true);

  h.state.currentSessionId = 'session_1';
  h.state.ui.activeView = 'settings';
  h.controller.syncFallbackNotice();
  assert.equal(h.notice().hidden, true);

  h.state.ui.activeView = 'chat';
  h.controller.syncFallbackNotice();
  assert.equal(h.notice().hidden, false);
  h.controller.dispose();
});

test('bind publishes the controller globally and dispose hides the notice and clears it', () => {
  const h = harness();
  h.state.sessions = [pluginSession()];
  h.state.currentSessionId = 'session_1';
  h.controller.bind();
  assert.equal(globalThis.rendererPluginSessions?.instance, h.controller);
  assert.deepEqual(Object.keys(h.controller).sort(), ['bind', 'dispose', 'isPluginSession', 'syncFallbackNotice']);
  h.controller.dispose();
  assert.equal(h.notice().hidden, true);
  assert.equal(globalThis.rendererPluginSessions, null);
});
