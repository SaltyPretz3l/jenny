'use strict';

/* The primary-chat composition (row 76): attachPrimaryChat wires the controls service and
 * the activity log over a backend-shaped object with a real ElectronSessionStore, so the
 * ports the other slices rely on (the wake gate's isPaused, the IPC's getState / list /
 * permissions, the bridge invalidation) answer against real records, not stubs. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { attachPrimaryChat } = require('../services/main/primary-chat-wiring');
const { normalizePrimaryChat } = require('../services/shell-config-primary-chat');
const { GENERAL_PROJECT_ID } = require('../services/projects/project-schema');
const { freshStore, seedConversation } = require('./helpers/session-truncate-fixtures');

function fakeConfigService() {
  let block = normalizePrimaryChat({});
  return {
    getState: () => ({ primaryChat: block }),
    updatePrimaryChat(patch) { block = normalizePrimaryChat({ ...block, ...patch }); return block; },
  };
}

function setup(t) {
  const { store } = freshStore();
  t.after(() => store.dispose());
  const primary = store.createSession({ title: 'Jenny', projectId: GENERAL_PROJECT_ID, sessionRole: 'primary' });
  const other = store.createSession({ title: 'Other chat', projectId: GENERAL_PROJECT_ID });
  seedConversation(store, primary.id);
  const events = [];
  const logs = [];
  const config = fakeConfigService();
  const backendService = {
    sessionStore: store,
    featureFlags: {},
    projectService: { get: (id) => (id === GENERAL_PROJECT_ID ? { id, name: 'General' } : null) },
    chatMessages: { resumeWake: (id) => ({ outcome: 'none', session_id: id }) },
  };
  attachPrimaryChat(backendService, {
    configService: () => config,
    emit: (event) => events.push(event),
    log: (level, event, details) => logs.push({ level, event, details }),
  });
  return { store, backendService, primary, other, events, logs };
}

test('attaches both services and the controls find the primary through the real store', (t) => {
  const { backendService, primary, other } = setup(t);
  assert.equal(typeof backendService.primaryChatControls.isPaused, 'function');
  assert.equal(typeof backendService.primaryActivityLog.list, 'function');
  assert.equal(backendService.primaryChatControls.primarySessionId(), primary.id);
  assert.equal(backendService.primaryChatControls.isPaused(primary.id), false);
  assert.equal(backendService.primaryChatControls.isPaused(other.id), false);
});

test('pause writes the config block, emits the invalidation, and the activity log reads it back', async (t) => {
  const { backendService, primary, events } = setup(t);
  const paused = backendService.primaryChatControls.pause();
  assert.equal(paused.ok, true, JSON.stringify(paused));
  assert.equal(backendService.primaryChatControls.isPaused(primary.id), true);
  assert.equal(events.at(-1).paused, true);
  assert.equal(events.at(-1).session_id, primary.id);

  const activity = backendService.primaryActivityLog.list({ limit: 10 });
  assert.equal(activity.ok, true, JSON.stringify(activity));
  assert.equal(activity.session_id, primary.id);
  assert.deepEqual(activity.entries.map((entry) => entry.kind), ['paused']);

  const resumed = await backendService.primaryChatControls.resume();
  assert.equal(resumed.ok, true);
  assert.deepEqual(resumed.woke, { outcome: 'none', session_id: primary.id });
  assert.equal(backendService.primaryChatControls.isPaused(primary.id), false);
});

test('permissions read the real containers: no grants, no permissions, ok envelope', (t) => {
  const { backendService } = setup(t);
  const permissions = backendService.primaryActivityLog.permissions();
  assert.equal(permissions.ok, true, JSON.stringify(permissions));
  assert.deepEqual(permissions.launch, []);
  assert.deepEqual(permissions.message_grants, []);
  assert.deepEqual(permissions.turn_grants, []);
});

test('the kill switch turns both services off without throwing', (t) => {
  const { backendService, primary } = setup(t);
  backendService.featureFlags = { primary_chat: false };
  assert.equal(backendService.primaryChatControls.isPaused(primary.id), false);
  assert.deepEqual(backendService.primaryChatControls.pause(), { ok: false, reason: 'disabled' });
  assert.deepEqual(backendService.primaryActivityLog.list(), { ok: false, reason: 'disabled' });
});
