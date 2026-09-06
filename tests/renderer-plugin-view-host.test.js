'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

global.inventoryActionButton = ({ label, ariaLabel, title, dataset = {} }) => {
  const attrs = Object.entries(dataset).map(([key, value]) => ` data-${key}="${value}"`).join('');
  return `<button type="button"${ariaLabel ? ` aria-label="${ariaLabel}"` : ''}${title ? ` title="${title}"` : ''}${attrs}>${label}</button>`;
};
const { createPluginViewHostController } = require('../renderer/shell/renderer-plugin-view-host');
const activeViewPersistence = require('../renderer/shell/renderer-active-view-persistence');

function harness() {
  const dom = new JSDOM(`<!doctype html><body>
    <section id="pluginView"><header id="pluginViewTrustChrome" tabindex="-1">
      <h2 id="pluginViewTitle"></h2><span id="pluginViewIdentity"></span>
      <span id="pluginViewStatus"></span><div id="pluginViewActions"></div>
    </header><div id="pluginViewContentSlot"></div></section></body>`);
  const { window } = dom;
  const content = window.document.getElementById('pluginViewContentSlot');
  content.getBoundingClientRect = () => ({ left: 320, top: 120, width: 700, height: 500 });
  window.requestAnimationFrame = (callback) => { callback(); return 1; };
  window.ResizeObserver = class { observe() {} disconnect() {} };
  const calls = [];
  let hostCommand = null;
  let changed = null;
  let pluginState = { ok: true, plugins: [] };
  let closeResult = { ok: true };
  let openResult = { ok: true };
  window.jennyShell = { plugins: {
    openView: async (value) => { calls.push(['open', value]); return openResult; },
    closeView: async () => { calls.push(['close']); return closeResult; },
    setViewBounds: async (value) => { calls.push(['bounds', value]); return { ok: true }; },
    setViewZoom: async (value) => ({ ok: true, zoom_factor: value.zoom_factor }),
    focusView: () => calls.push(['focus']),
    getState: async () => pluginState,
    onViewHostCommand: (callback) => { hostCommand = callback; return () => {}; },
    onChanged: (callback) => { changed = callback; return () => { changed = null; }; },
  } };
  const state = { ui: { activeView: 'chat' } };
  const destinations = [];
  const controller = createPluginViewHostController({ windowRef: window,
    documentRef: window.document, state,
    setActiveView: (view) => { state.ui.activeView = view; destinations.push(view); },
    openSettingsSection: (section) => calls.push(['settings', section]),
  });
  controller.bind();
  return { controller, window, state, calls, destinations, hostCommand: () => hostCommand,
    setPluginState: (value) => { pluginState = value; },
    setCloseResult: (value) => { closeResult = value; },
    setOpenResult: (value) => { openResult = value; },
    emitChanged: () => changed?.({}), };
}

test('the renderer opens an ephemeral plugin stage below trusted bounds and returns to the prior view', async () => {
  assert.equal(activeViewPersistence.PERSISTABLE_VIEW_IDS.includes('plugin'), false);
  const h = harness();
  const result = await h.controller.open({ publisher_id: 'jenny-official', plugin_id: 'chatgpt-subscription',
    contribution_id: 'chatgpt-setup', generation_id: 'generation_1', display_name: 'ChatGPT setup' });
  assert.equal(result.ok, true);
  assert.equal(h.state.ui.activeView, 'plugin');
  const request = h.calls.find(([kind]) => kind === 'open')[1];
  assert.deepEqual(request.bounds, { x: 320, y: 120, width: 700, height: 500 });
  assert.match(h.window.document.getElementById('pluginViewStatus').textContent, /Sandboxed/);
  await h.controller.close('test');
  assert.equal(h.state.ui.activeView, 'chat');
  assert.deepEqual(h.destinations, ['plugin', 'chat']);
});

test('an inactive contribution is named as such instead of reading as a broken view', async () => {
  const h = harness();
  const identity = { publisher_id: 'jenny-official', plugin_id: 'chatgpt-subscription',
    contribution_id: 'chatgpt-setup', generation_id: 'generation_1', display_name: 'ChatGPT setup' };
  h.setOpenResult({ ok: false, reason: 'view_contribution_not_active' });
  assert.equal((await h.controller.open(identity)).reason, 'view_contribution_not_active');
  const status = h.window.document.getElementById('pluginViewStatus');
  assert.match(status.textContent, /plugin is not running/);
  assert.equal(status.dataset.state, 'error');
  h.setOpenResult({ ok: false, reason: 'view_host_commit_failed' });
  await h.controller.open(identity);
  assert.match(status.textContent, /could not open this isolated view/);
});

test('session-bound views forward identity once and fail closed until teardown succeeds', async () => {
  const h = harness();
  await h.controller.open({
    publisher_id: 'jenny-official',
    plugin_id: 'local-image-generation',
    contribution_id: 'image_workspace',
    generation_id: 'generation_1',
    display_name: 'Image',
    sessionId: 'plugin-session',
  });
  const request = h.calls.find(([kind]) => kind === 'open')[1];
  assert.equal(request.sessionId, 'plugin-session');
  assert.equal(request.publisher_id, 'jenny-official');
  assert.equal(h.controller.getActiveSessionId(), 'plugin-session');

  h.setCloseResult({ ok: false, reason: 'tree_death_unproven' });
  assert.equal((await h.controller.close('session_left')).reason, 'tree_death_unproven');
  assert.equal(h.controller.getActiveSessionId(), 'plugin-session');
  assert.equal(h.state.ui.activeView, 'plugin');

  h.setCloseResult({ ok: true });
  assert.equal((await h.controller.close('session_left')).ok, true);
  assert.equal(h.controller.getActiveSessionId(), '');
  assert.equal(h.state.ui.activeView, 'chat');
});

test('ephemeral view teardown remains fail-open because it owns no provider operation', async () => {
  const h = harness();
  await h.controller.open({ publisher_id: 'acme', plugin_id: 'panel', contribution_id: 'main' });
  h.setCloseResult({ ok: false, reason: 'view_close_failed' });
  assert.equal((await h.controller.close('user_closed')).reason, 'view_close_failed');
  assert.equal(h.controller.getActiveSessionId(), '');
  assert.equal(h.state.ui.activeView, 'chat');
});

test('F6 transfers focus into content and host commands restore trust-chrome focus', async () => {
  const h = harness();
  await h.controller.open({ publisher_id: 'acme', plugin_id: 'panel', contribution_id: 'main' });
  h.window.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'F6', bubbles: true }));
  assert.ok(h.calls.some(([kind]) => kind === 'focus'));
  h.hostCommand()({ command: 'focus_chrome' });
  const actions = h.window.document.getElementById('pluginViewActions');
  assert.equal(h.window.document.activeElement.dataset.pluginViewAction, 'back');
  assert.equal(actions.querySelector('[data-plugin-view-action="back"]').getAttribute('aria-label'), 'Back');
  assert.equal(actions.querySelector('[data-plugin-view-action="back"]').getAttribute('title'), 'Go back in the plugin view');
  assert.equal(actions.querySelector('[data-plugin-view-action="zoom-out"]').getAttribute('title'), 'Zoom out');
  assert.equal(actions.querySelector('[data-plugin-view-action="zoom-in"]').getAttribute('title'), 'Zoom in');
  assert.equal(actions.querySelector('[data-plugin-view-action="zoom-reset"]').getAttribute('title'), 'Reset zoom');
  assert.equal(actions.querySelector('[data-plugin-view-action="close"]').getAttribute('aria-label'), 'Close');
  assert.equal(actions.querySelector('[data-plugin-view-action="close"]').getAttribute('title'), 'Close the plugin view');
  h.controller.dispose();
});

test('trusted host commands announce crash restart and terminal failure states', async () => {
  const h = harness();
  await h.controller.open({ publisher_id: 'acme', plugin_id: 'panel', contribution_id: 'main' });
  const status = h.window.document.getElementById('pluginViewStatus');
  h.hostCommand()({ command: 'view_state', state: 'restarting' });
  assert.match(status.textContent, /restarting it safely/);
  assert.equal(status.dataset.state, 'loading');
  h.hostCommand()({ command: 'view_state', state: 'crashed' });
  assert.match(status.textContent, /could not be restarted/);
  assert.equal(status.dataset.state, 'error');
  h.controller.dispose();
});

test('successful provider activation closes the ephemeral setup view and opens chat', async () => {
  const h = harness();
  h.state.ui.activeView = 'settings';
  await h.controller.open({ publisher_id: 'jenny-official', plugin_id: 'chatgpt-subscription',
    contribution_id: 'chatgpt-setup' });
  h.hostCommand()({ command: 'provider_activated', provider_id: 'chatgpt' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.state.ui.activeView, 'chat');
  assert.ok(h.calls.some(([kind]) => kind === 'close'));
  h.controller.dispose();
});

test('a committed authority withdrawal closes the ephemeral trusted stage', async () => {
  const h = harness();
  await h.controller.open({ publisher_id: 'acme', plugin_id: 'panel', contribution_id: 'main' });
  h.setPluginState({ ok: true, plugins: [{
    publisher_id: 'acme', plugin_id: 'panel',
    contributions: [{ contribution_id: 'main', effective_enabled: false }],
  }] });
  h.emitChanged();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.state.ui.activeView, 'chat');
  assert.ok(h.calls.some(([kind]) => kind === 'close'));
  h.controller.dispose();
});

test('disposing during a renderer-registry refresh prevents post-dispose registration', async (t) => {
  const dom = new JSDOM('<!doctype html><body><section id="pluginView"><div id="pluginViewContentSlot"></div>'
    + '<div id="pluginViewActions"></div></section></body>');
  let resolveState;
  let registrations = 0;
  const previousRegistry = globalThis.rendererArtifactsRendererRegistry;
  globalThis.rendererArtifactsRendererRegistry = {
    registerPluginRenderer() { registrations += 1; },
    clearPluginRenderers() {},
  };
  t.after(() => {
    globalThis.rendererArtifactsRendererRegistry = previousRegistry;
    dom.window.close();
  });
  dom.window.jennyShell = { plugins: {
    getState: () => new Promise((resolve) => { resolveState = resolve; }),
    closeView: async () => ({ ok: true }),
  } };
  const controller = createPluginViewHostController({ windowRef: dom.window,
    documentRef: dom.window.document, state: { ui: { activeView: 'settings' } } });

  controller.bind();
  controller.dispose();
  resolveState({ plugins: [{ publisher_id: 'acme', plugin_id: 'charts', generation_id: 'g1',
    contributions: [{ effective_enabled: true, kind: 'artifact_renderer', contribution_id: 'chart',
      view: { artifact_kinds: ['chart:bar'] } }] }] });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(registrations, 0);
});
