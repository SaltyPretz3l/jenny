const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createMessageBranchController,
} = require('../renderer/chat/renderer-chat-branch-utils');

test('F3: branchFromMessage forks the active session and activates the branch', async () => {
  const state = { currentSessionId: 'sess_parent' };
  const calls = [];
  const branchSummary = {
    id: 'sess_branch',
    title: 'Parent (branch)',
    branch_origin: {
      source_session_id: 'sess_parent',
      source_message_id: 'msg_user',
      source_title: 'Parent',
      created_at: '2026-05-12T12:00:00.000Z',
    },
  };
  const controller = createMessageBranchController({
    state,
    jennyShellSessions: {
      forkSession: async (...args) => {
        calls.push(['fork', ...args]);
        return branchSummary;
      },
    },
    getCurrentSessionId: () => state.currentSessionId,
    getCurrentSessionMessages: () => [
      { id: 'msg_user', role: 'user', content: 'Hello' },
      { id: 'msg_assistant', role: 'assistant', content: 'Hi' },
    ],
    upsertSessionSummary: (summary) => calls.push(['upsert', summary.id]),
    loadSessions: async (...args) => calls.push(['loadSessions', ...args]),
    activateWorkspaceSession: async (...args) => {
      calls.push(['activateWorkspaceSession', ...args]);
      state.currentSessionId = String(args[0] || '');
    },
    renderAll: () => calls.push(['renderAll']),
    appendClientLog: (level, eventName, payload) => calls.push(['log', level, eventName, payload?.messageId || payload?.sessionId || '']),
    showToastMessage: (message, options) => calls.push(['toast', options?.title || '', message]),
  });

  const result = await controller.branchFromMessage('msg_user');

  assert.equal(result, branchSummary);
  assert.deepEqual(calls.filter((entry) => entry[0] !== 'renderAll').slice(0, 3), [
    ['fork', 'sess_parent', 'msg_user', {}],
    ['upsert', 'sess_branch'],
    ['loadSessions', 'sess_branch', { skipOpenCurrent: true }],
  ]);
  const activation = calls.find((entry) => entry[0] === 'activateWorkspaceSession');
  assert.equal(activation[1], 'sess_branch');
  assert.equal(activation[2].silent, true);
  assert.equal(typeof activation[2].navigationGuard?.isCurrent, 'function');
  assert.equal(state.currentSessionId, 'sess_branch');
  assert.ok(calls.some((entry) => entry[0] === 'toast' && entry[1] === 'Branch Created'));
});

test('F3: branchFromMessage refuses unsupported rows before IPC', async () => {
  let forkCalls = 0;
  const logs = [];
  const controller = createMessageBranchController({
    state: { currentSessionId: 'sess_parent' },
    jennyShellSessions: {
      forkSession: async () => {
        forkCalls += 1;
        return null;
      },
    },
    getCurrentSessionId: () => 'sess_parent',
    getCurrentSessionMessages: () => [
      { id: 'tool_1', role: 'assistant', kind: 'tool_use', content: 'Reading' },
    ],
    appendClientLog: (level, eventName, payload) => logs.push({ level, eventName, payload }),
  });

  const result = await controller.branchFromMessage('tool_1');

  assert.equal(result, null);
  assert.equal(forkCalls, 0);
  assert.equal(logs[0].eventName, 'chat.branch_blocked');
  assert.equal(logs[0].payload.reason, 'unsupported_message');
});

test('F3: branchFromMessage refuses while current session is busy', async () => {
  let forkCalls = 0;
  const errors = [];
  const controller = createMessageBranchController({
    state: { currentSessionId: 'sess_parent' },
    jennyShellSessions: {
      forkSession: async () => {
        forkCalls += 1;
        return null;
      },
    },
    getCurrentSessionId: () => 'sess_parent',
    getCurrentSessionMessages: () => [
      { id: 'msg_assistant', role: 'assistant', content: 'Hi' },
    ],
    isSessionStreaming: () => true,
    showComposerActionError: (error, title) => errors.push({ message: error.message, title }),
  });

  const result = await controller.branchFromMessage('msg_assistant');

  assert.equal(result, null);
  assert.equal(forkCalls, 0);
  assert.deepEqual(errors, [{
    title: 'Branch Unavailable',
    message: 'Wait for the current response to finish before branching.',
  }]);
});

test('branch completion preserves newer navigation and offers an explicit Open action', async () => {
  const state = { currentSessionId: 'sess_parent', ui: { activeView: 'chat' } };
  let resolveFork;
  const activations = [];
  const toasts = [];
  const controller = createMessageBranchController({
    state,
    jennyShellSessions: {
      forkSession: () => new Promise((resolve) => { resolveFork = resolve; }),
    },
    getCurrentSessionId: () => state.currentSessionId,
    getCurrentSessionMessages: () => [{ id: 'msg_user', role: 'user', content: 'Hello' }],
    loadSessions: async () => {},
    activateWorkspaceSession: async (sessionId) => {
      activations.push(sessionId);
      state.currentSessionId = sessionId;
    },
    showToastMessage: (message, options) => toasts.push({ message, options }),
  });

  const branchPromise = controller.branchFromMessage('msg_user');
  state.currentSessionId = 'sess_other';
  state.navigationIntentOwner.noteUserNavigation();
  resolveFork({ id: 'sess_branch', title: 'Branch' });
  await branchPromise;

  assert.equal(state.currentSessionId, 'sess_other');
  assert.deepEqual(activations, []);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].options.actions[0].label, 'Open');
  await toasts[0].options.actions[0].onClick();
  assert.deepEqual(activations, ['sess_branch']);
});

test('branch activation cannot overwrite navigation that occurs during its await', async () => {
  const state = { currentSessionId: 'sess_parent', ui: { activeView: 'chat' } };
  let resolveActivation;
  let noteActivationStarted;
  const activationStarted = new Promise((resolve) => { noteActivationStarted = resolve; });
  const toasts = [];
  const controller = createMessageBranchController({
    state,
    jennyShellSessions: {
      forkSession: async () => ({ id: 'sess_branch', title: 'Branch' }),
    },
    getCurrentSessionId: () => state.currentSessionId,
    getCurrentSessionMessages: () => [{ id: 'msg_user', role: 'user', content: 'Hello' }],
    loadSessions: async () => {},
    activateWorkspaceSession: async () => {
      noteActivationStarted();
      await new Promise((resolve) => { resolveActivation = resolve; });
    },
    showToastMessage: (message, options) => toasts.push({ message, options }),
  });

  const branchPromise = controller.branchFromMessage('msg_user');
  await activationStarted;
  state.currentSessionId = 'sess_other';
  state.navigationIntentOwner.noteUserNavigation();
  resolveActivation();
  await branchPromise;

  assert.equal(state.currentSessionId, 'sess_other');
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].options.actions[0].label, 'Open');
});

test('duplicate branch activation shares one synchronous pending operation', async () => {
  const state = { currentSessionId: 'sess_parent', ui: {} };
  let resolveFork;
  let forkCalls = 0;
  const controller = createMessageBranchController({
    state,
    jennyShellSessions: {
      forkSession: () => {
        forkCalls += 1;
        return new Promise((resolve) => { resolveFork = resolve; });
      },
    },
    getCurrentSessionId: () => state.currentSessionId,
    getCurrentSessionMessages: () => [{ id: 'msg_user', role: 'user', content: 'Hello' }],
    loadSessions: async () => {},
  });
  const first = controller.branchFromMessage('msg_user');
  const second = controller.branchFromMessage('msg_user');
  assert.equal(first, second);
  assert.equal(state.ui.branchCommitting, true);
  await Promise.resolve();
  assert.equal(forkCalls, 1);
  resolveFork({ id: 'sess_branch', title: 'Branch' });
  await first;
  assert.equal(state.ui.branchCommitting, false);
});

test('dispose prevents a late branch result from mutating renderer state', async () => {
  const state = { currentSessionId: 'sess_parent', ui: {} };
  let resolveFork;
  const upserts = [];
  const controller = createMessageBranchController({
    state,
    jennyShellSessions: { forkSession: () => new Promise((resolve) => { resolveFork = resolve; }) },
    getCurrentSessionId: () => state.currentSessionId,
    getCurrentSessionMessages: () => [{ id: 'msg_user', role: 'user', content: 'Hello' }],
    upsertSessionSummary: (branch) => upserts.push(branch.id),
  });
  const pending = controller.branchFromMessage('msg_user');
  await Promise.resolve();
  controller.dispose();
  resolveFork({ id: 'sess_branch', title: 'Branch' });
  await pending;
  assert.deepEqual(upserts, []);
  assert.equal(state.ui.branchCommitting, false);
});
