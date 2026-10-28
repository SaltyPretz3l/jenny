'use strict';

// The session-scoped optional chat.send fields (extracted from
// managed-sidecar-chat.js) and row 69's `session_role`: present only for the
// primary Jenny chat, never `session_role: null` on the wire.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildChatSendOptionalFields, isPrimaryChatTurn, primaryChatRoleFields, safetyRequestFields,
} = require('../services/backend/chat-send-optional-fields');
const { startManagedSidecarChatStream } = require('../services/backend/managed-sidecar-chat');
const {
  buildManagedChatRequest,
  createManagedChatServiceStub,
} = require('./helpers/managed-sidecar-chat-lifecycle-helpers');
const { cleanupTrackedResources } = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('the role field is primary-only and the kill switch drops it', () => {
  const primary = { id: 'jenny', session_role: 'primary' };
  assert.deepEqual(primaryChatRoleFields({ featureFlags: {} }, primary), { session_role: 'primary' });
  assert.deepEqual(primaryChatRoleFields({ featureFlags: { primary_chat: true } }, primary), { session_role: 'primary' });
  assert.deepEqual(primaryChatRoleFields({ featureFlags: { primary_chat: false } }, primary), {});
  for (const summary of [{ id: 's' }, { session_role: null }, { session_role: 'Primary' }, null]) {
    assert.deepEqual(primaryChatRoleFields({}, summary), {}, JSON.stringify(summary));
    assert.equal(isPrimaryChatTurn({}, summary), false);
  }
  assert.equal(isPrimaryChatTurn({}, primary), true);
});

test('the optional fields compose plan, propose, role and safety without null placeholders', () => {
  const service = { featureFlags: {}, configService: { getChatUiState: () => ({ safetyMode: 'normal', autoApproveStreakCap: 2 }) } };
  const ordinary = buildChatSendOptionalFields(service, {
    sessionId: 's1', sessionSummary: { id: 's1', run_mode: 'ask' }, sessionMessages: [], planMode: false, workspaceRoot: '',
  });
  assert.equal(Object.hasOwn(ordinary, 'session_role'), false);
  assert.equal(ordinary.plan_mode, false);
  assert.equal(ordinary.safety_mode, 'normal');
  assert.equal(ordinary.auto_approve_streak_cap, 2);
  const primary = buildChatSendOptionalFields(service, {
    sessionId: 'jenny', sessionSummary: { id: 'jenny', session_role: 'primary' }, sessionMessages: [], planMode: true,
    workspaceRoot: '', safetyPolicy: { safety_mode: 'paranoid' },
  });
  assert.equal(primary.session_role, 'primary');
  assert.equal(primary.plan_mode, true);
  assert.deepEqual(safetyRequestFields(service, { safety_mode: 'paranoid' }), { safety_mode: 'paranoid' });
  assert.equal(primary.safety_mode, 'paranoid');
});

async function captureChatSend(service) {
  let captured = null;
  service.sidecarClient = {
    async chatSend(params, options = {}) {
      captured = params;
      options.onNotification({ method: 'chat.done', params: { stop_reason: 'stop' } });
      return { status: 'completed' };
    },
  };
  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest());
  await service.activeStreams.get(stream.streamId)._pendingPromise;
  assert.ok(captured, 'chat.send must have been called');
  return captured;
}

test('chat.send carries session_role and the profile overview for the primary chat only', async () => {
  const ordinary = createManagedChatServiceStub();
  const plain = await captureChatSend(ordinary);
  assert.equal(Object.hasOwn(plain, 'session_role'), false);
  assert.equal((plain.context_blocks || []).some((block) => block.kind === 'profile_overview'), false);

  const service = createManagedChatServiceStub();
  service.sessionStore.createSessionWithId('session_managed_chat_request', { title: 'Jenny', session_role: 'primary' });
  const listed = [];
  service.getSessionDirectory = () => ({
    list(request) {
      listed.push(request);
      return { ok: true, scope_kind: 'profile', truncated: false, rows: [
        { session_id: 'docs', title: 'Docs pass', project: { id: 'p1', name: 'Site' }, status: 'running',
          updated_at: new Date().toISOString(), unread_message_count: 1, waiting_on_user: false },
      ] };
    },
  });
  const params = await captureChatSend(service);
  assert.equal(params.session_role, 'primary');
  assert.equal(listed[0].callerSessionId, 'session_managed_chat_request');
  const overview = params.context_blocks.at(-1);
  assert.equal(overview.kind, 'profile_overview');
  assert.match(overview.content, /^## Profile Overview\n/);
  assert.match(overview.content, /- Docs pass \(Site\) · running · just now/);

  service.featureFlags.primary_chat = false;
  const off = await captureChatSend(service);
  assert.equal(Object.hasOwn(off, 'session_role'), false);
  assert.equal((off.context_blocks || []).some((block) => block.kind === 'profile_overview'), false);
});
