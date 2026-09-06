'use strict';

/* isChatSurfaceLive — the widened render-gate predicate (Workspace Chat Dock).
 * The four arms: chat view is always live; the IDE view is live only when the
 * ide_chat_dock flag is ON and the dock is open; everything else is dead.
 * Flag-off must collapse to exactly `activeView === 'chat'`. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isChatSurfaceLive } = require('../renderer/chat/renderer-chat-surface-live-utils');

function makeState({ view, flag, open } = {}) {
  return {
    ui: { activeView: view, ideChatDockOpen: open },
    features: { featureFlags: { ide_chat_dock: flag } },
  };
}

test('chat view is live regardless of flag or dock state', () => {
  assert.equal(isChatSurfaceLive(makeState({ view: 'chat', flag: false, open: false })), true);
  assert.equal(isChatSurfaceLive(makeState({ view: 'chat', flag: true, open: true })), true);
});

test('ide view + flag ON + dock open is live', () => {
  assert.equal(isChatSurfaceLive(makeState({ view: 'ide', flag: true, open: true })), true);
});

test('ide view + flag ON + dock closed is NOT live', () => {
  assert.equal(isChatSurfaceLive(makeState({ view: 'ide', flag: true, open: false })), false);
  assert.equal(isChatSurfaceLive(makeState({ view: 'ide', flag: true, open: undefined })), false);
});

test('ide view + flag OFF is NOT live even with the dock marked open (flag-off collapse)', () => {
  assert.equal(isChatSurfaceLive(makeState({ view: 'ide', flag: false, open: true })), false);
  assert.equal(isChatSurfaceLive(makeState({ view: 'ide', flag: undefined, open: true })), false);
});

test('other views and hostile states are NOT live', () => {
  assert.equal(isChatSurfaceLive(makeState({ view: 'settings', flag: true, open: true })), false);
  assert.equal(isChatSurfaceLive(makeState({ view: 'logs', flag: true, open: true })), false);
  assert.equal(isChatSurfaceLive(undefined), false);
  assert.equal(isChatSurfaceLive({}), false);
  assert.equal(isChatSurfaceLive({ ui: {} }), false);
  // Missing features branch on the ide path never throws.
  assert.equal(isChatSurfaceLive({ ui: { activeView: 'ide', ideChatDockOpen: true } }), false);
});
