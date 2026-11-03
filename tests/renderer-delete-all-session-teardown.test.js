'use strict';

// Settings > Your data > Delete all chats (row 95) removes sessions behind the renderer's back, so the
// renderer must run the same teardown the single delete does for every chat that went away.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

function loadLifecycle(t, { state, callbacks, multiStream }) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const saved = {
    window: global.window,
    document: global.document,
    requestAnimationFrame: global.requestAnimationFrame,
    cacheUtils: globalThis.rendererSessionCacheUtils,
    multiStream: globalThis.rendererMultiStreamController,
  };
  const cleared = [];
  global.window = dom.window;
  global.document = dom.window.document;
  global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  dom.window.jennyShell = {};
  globalThis.rendererMultiStreamController = multiStream || null;
  globalThis.rendererSessionCacheUtils = {
    createSessionCacheController: () => ({
      collectSessionStreamIds: () => new Set(),
      getPinnedSessionIds: () => new Set(),
      evictColdSessionCaches: async () => {},
      clearSessionStreamState: async (id, options) => { cleared.push({ id, options }); },
    }),
  };
  const modulePath = require.resolve('../renderer/shell/renderer-lifecycle-utils');
  delete require.cache[modulePath];
  const { createLifecycleController } = require('../renderer/shell/renderer-lifecycle-utils');
  const element = () => dom.window.document.createElement('div');
  const controller = createLifecycleController({
    state,
    constants: { APPEARANCE_STORAGE_KEY: 'appearance', TOAST_SOURCE: {}, INTERACTIVE_SEQUENCE_IDLE: 'idle' },
    dom: { chatInput: element(), composerAttachMenu: element(), composerAttachShortcut: element() },
    callbacks: { refreshSettingsSection: () => Promise.resolve(null), ...callbacks },
    controllers: {},
  });
  t.after(() => {
    controller.disposeLifecycleController();
    global.window = saved.window;
    global.document = saved.document;
    global.requestAnimationFrame = saved.requestAnimationFrame;
    globalThis.rendererSessionCacheUtils = saved.cacheUtils;
    globalThis.rendererMultiStreamController = saved.multiStream;
    dom.window.close();
  });
  return { controller, cleared, teardown: dom.window.rendererSessionTeardown };
}

test('forgetDeletedSession runs the single-delete teardown: cancel streams, discard preflight, tombstone, invalidate artifacts', async (t) => {
  const removed = [];
  const invalidated = [];
  const pre = { pending: true };
  const state = { ui: { activeView: 'chat' }, logs: [], sessions: [], runtimeDraft: {}, features: { featureFlags: {} },
    sendPreflight: { sessionId: 'gone-1', pending: true } };
  const h = loadLifecycle(t, {
    state,
    multiStream: { getPreflight: (id) => (id === 'gone-1' ? pre : null) },
    callbacks: {
      removeSessionState: (id, options) => removed.push({ id, options }),
      invalidateSessionArtifacts: (id) => invalidated.push(id),
    },
  });
  assert.equal(typeof h.teardown?.forgetDeletedSession, 'function', 'the teardown is reachable by the Your data page');
  await h.teardown.forgetDeletedSession('gone-1');
  assert.deepEqual(h.cleared, [{ id: 'gone-1', options: { cancelActive: true } }]);
  assert.equal(pre.discarded, true);
  assert.equal(state.sendPreflight.discarded, true);
  assert.deepEqual(removed, [{ id: 'gone-1', options: { tombstone: true } }]);
  assert.deepEqual(invalidated, ['gone-1']);
  await h.teardown.forgetDeletedSession('   ');
  assert.equal(h.cleared.length, 1, 'a blank id does nothing');
});

test('the single delete path still reuses the same teardown pieces', async (t) => {
  const removed = [];
  const invalidated = [];
  const state = { ui: { activeView: 'chat' }, logs: [], sessions: [{ id: 'one' }], runtimeDraft: {}, features: { featureFlags: {} } };
  const h = loadLifecycle(t, {
    state,
    callbacks: {
      removeSessionState: (id, options) => removed.push({ id, options }),
      invalidateSessionArtifacts: (id) => invalidated.push(id),
      renderAll: () => {},
    },
  });
  global.window.jennyShell.sessions = { delete: async () => ({ id: 'one', deleted: true }) };
  const result = await h.controller.handleDeleteSession('one');
  assert.equal(result.deleted, true);
  assert.deepEqual(h.cleared[0], { id: 'one', options: { cancelActive: true } });
  assert.deepEqual(removed, [{ id: 'one', options: { tombstone: true } }]);
  assert.deepEqual(invalidated, ['one']);
});

function loadBindings() {
  const root = {};
  const sourcePath = path.join(__dirname, '..', 'renderer', 'app', 'renderer-app-shell-bindings-controllers.js');
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), { window: root }, { filename: sourcePath });
  return root.rendererAppShellBindingsControllers;
}

test('after Delete all chats every vanished chat is torn down; the Jenny chat, kept chats and local drafts are not', async () => {
  const { createDeleteAllRefresh } = loadBindings();
  const state = {
    currentSessionId: 'a',
    sessions: [
      { id: 'a' }, { id: 'b' }, { id: 'keep' }, { id: 'jenny', session_role: 'primary' }, { id: 'draft', optimistic_local: true },
    ],
  };
  const forgotten = [];
  const loads = [];
  const refresh = createDeleteAllRefresh({
    state,
    loadSessions: async (...args) => { loads.push(args); state.sessions = [{ id: 'keep' }, { id: 'jenny', session_role: 'primary' }]; },
    teardown: () => ({ forgetDeletedSession: async (id) => { forgotten.push(id); } }),
  });
  await refresh();
  assert.deepEqual(loads, [['a']]);
  assert.deepEqual(forgotten, ['a', 'b']);
});

test('the refresh tolerates a missing teardown', async () => {
  const { createDeleteAllRefresh } = loadBindings();
  const state = { currentSessionId: '', sessions: [{ id: 'a' }] };
  await createDeleteAllRefresh({ state, loadSessions: async () => { state.sessions = []; }, teardown: () => undefined })();
});
