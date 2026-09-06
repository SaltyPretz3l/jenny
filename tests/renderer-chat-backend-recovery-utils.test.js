const test = require('node:test');
const assert = require('node:assert/strict');

const {
  collectInflightSendSessionIds,
  markStrandedStreamMessageErrored,
  recoverInflightSendsForUnusableBackend,
} = require('../renderer/chat/renderer-chat-backend-recovery-utils');

function createState() {
  return {
    ui: {
      chatSendLifecycleBySession: new Map([
        ['session-live', 'streaming'],
        ['session-preflight', 'preflight'],
        ['session-idle', 'idle'],
        ['session-settling', 'settling'],
      ]),
    },
    messagesBySession: new Map([
      ['session-live', [
        { id: 'assistant-complete', role: 'assistant', content: 'done', status: 'complete' },
        { id: 'user-old', role: 'user', content: 'old', status: 'complete' },
        { id: 'assistant-hydrated', role: 'assistant', content: 'hydrated', status: '' },
        { id: 'user-live', role: 'user', content: 'latest', status: 'complete' },
        { id: 'assistant-live', role: 'assistant', content: 'partial', status: '', streamId: 'stream-live' },
      ]],
      ['session-preflight', [
        { id: 'user-preflight', role: 'user', content: 'pending', status: 'complete' },
      ]],
    ]),
  };
}

function createMultiStreamController() {
  const streamingIds = ['session-live', 'session-settling'];
  const preflightIds = ['session-preflight', 'session-live', ''];
  const clearedStreams = [];
  const clearedPreflights = [];
  return {
    clearedStreams,
    clearedPreflights,
    getStreamingSessionIds() {
      return streamingIds;
    },
    getPreflightSessionIds() {
      return preflightIds;
    },
    clearSessionStream(sessionId) {
      clearedStreams.push(sessionId);
      return sessionId === 'session-live' ? 'stream-live' : '';
    },
    clearPreflight(sessionId) {
      clearedPreflights.push(sessionId);
    },
  };
}

test('collectInflightSendSessionIds merges busy lifecycles and multi-stream ids', () => {
  const state = createState();
  const controller = createMultiStreamController();

  assert.deepEqual(
    collectInflightSendSessionIds(state, controller),
    ['session-live', 'session-preflight', 'session-settling']
  );
});

test('markStrandedStreamMessageErrored marks only the active assistant reply', () => {
  const state = createState();

  const mutated = markStrandedStreamMessageErrored({
    state,
    sessionId: 'session-live',
    streamId: 'stream-live',
    errorMessage: 'Backend failed',
    nowIso: () => '2026-06-02T12:00:00.000Z',
  });

  assert.equal(mutated, true);
  const messages = state.messagesBySession.get('session-live');
  const byId = new Map(messages.map((message) => [message.id, message]));
  assert.equal(byId.get('assistant-complete').status, 'complete');
  assert.equal(byId.get('assistant-hydrated').status, '');
  assert.equal(byId.get('assistant-hydrated').stream_error, undefined);
  assert.equal(byId.get('assistant-live').status, 'error');
  assert.equal(byId.get('assistant-live').stream_error, 'Backend failed');
  assert.equal(byId.get('assistant-live').finalizedAt, '2026-06-02T12:00:00.000Z');
});

// SP-12: shared terminal-status vocabulary adoption (Wave L1 Packet R).
// A denied message must count as terminal so it's not treated as stranded
// and rewritten to error (aligns with L0.6 denied-is-terminal). Before this
// fix, TERMINAL_MESSAGE_STATUSES did not include 'denied', so a denied
// message that happened to be the last non-terminal assistant reply after
// the last user turn would be silently overwritten to status 'error'.

test('markStrandedStreamMessageErrored treats denied as terminal and does not overwrite it (SP-12)', () => {
  const state = {
    messagesBySession: new Map([
      ['session-denied', [
        { id: 'user-1', role: 'user', content: 'hi', status: 'complete' },
        { id: 'assistant-denied', role: 'assistant', content: 'blocked', status: 'denied' },
      ]],
    ]),
  };

  const mutated = markStrandedStreamMessageErrored({
    state,
    sessionId: 'session-denied',
    streamId: '',
    errorMessage: 'Backend failed',
    nowIso: () => '2026-06-02T12:00:00.000Z',
  });

  assert.equal(mutated, false, 'a denied message is not stranded');
  const message = state.messagesBySession.get('session-denied').find((m) => m.id === 'assistant-denied');
  assert.equal(message.status, 'denied');
  assert.equal(message.stream_error, undefined);
});

test('markStrandedStreamMessageErrored still treats one-l canceled as terminal via the shared vocabulary alias (SP-12)', () => {
  const state = {
    messagesBySession: new Map([
      ['session-canceled', [
        { id: 'user-1', role: 'user', content: 'hi', status: 'complete' },
        { id: 'assistant-canceled', role: 'assistant', content: 'stopped', status: 'canceled' },
      ]],
    ]),
  };

  const mutated = markStrandedStreamMessageErrored({
    state,
    sessionId: 'session-canceled',
    streamId: '',
    errorMessage: 'Backend failed',
    nowIso: () => '2026-06-02T12:00:00.000Z',
  });

  assert.equal(mutated, false, 'a one-l canceled message is not stranded');
  const message = state.messagesBySession.get('session-canceled').find((m) => m.id === 'assistant-canceled');
  assert.equal(message.status, 'canceled');
});

test('recoverInflightSendsForUnusableBackend clears stranded send state with bounded diagnostics', () => {
  const state = createState();
  const controller = createMultiStreamController();
  const clearedLifecycle = [];
  const logs = [];
  const toasts = [];

  const recovered = recoverInflightSendsForUnusableBackend({
    payload: { phase: 'failed', detail: 'sidecar crashed' },
    state,
    clearChatSendLifecycle(sessionId) {
      clearedLifecycle.push(sessionId);
      state.ui.chatSendLifecycleBySession.delete(sessionId);
    },
    getMultiStreamController: () => controller,
    appendClientLog(level, eventName, detail) {
      logs.push({ level, eventName, detail });
    },
    showToastMessage(message, options) {
      toasts.push({ message, options });
    },
    toastSource: 'chat-stream',
    nowIso: () => '2026-06-02T12:00:00.000Z',
  });

  assert.equal(recovered, true);
  assert.deepEqual(clearedLifecycle, ['session-live', 'session-preflight', 'session-settling']);
  assert.deepEqual(controller.clearedStreams, ['session-live', 'session-preflight', 'session-settling']);
  assert.deepEqual(controller.clearedPreflights, ['session-live', 'session-preflight', 'session-settling']);
  assert.equal(state.ui.chatSendLifecycleBySession.has('session-live'), false);
  assert.equal(logs[0].level, 'WARN');
  assert.equal(logs[0].eventName, 'chat.backend_unusable_send_recovery');
  assert.deepEqual(logs[0].detail, {
    phase: 'failed',
    recoveredCount: 3,
    sessionIds: ['session-live', 'session-preflight', 'session-settling'],
  });
  assert.equal(toasts[0].message, 'The backend connection failed before this response finished. sidecar crashed');
  assert.equal(toasts[0].options.title, 'Backend Unavailable');
  assert.equal(toasts[0].options.dedupeKey, 'chat-stream:backend-unusable');
});

test('recoverInflightSendsForUnusableBackend ignores usable phases and empty recovery sets', () => {
  const state = createState();
  const controller = createMultiStreamController();

  assert.equal(recoverInflightSendsForUnusableBackend({
    payload: { phase: 'ready' },
    state,
    getMultiStreamController: () => controller,
  }), false);

  state.ui.chatSendLifecycleBySession.clear();
  assert.equal(recoverInflightSendsForUnusableBackend({
    payload: { phase: 'stopped' },
    state,
    getMultiStreamController: () => null,
  }), false);
});

test('recoverInflightSendsForUnusableBackend routes to the banner and suppresses the toast when intake is active (EH-W9)', () => {
  const state = createState();
  const controller = createMultiStreamController();
  const toasts = [];
  const reports = [];

  const recovered = recoverInflightSendsForUnusableBackend({
    payload: { phase: 'stopped', detail: 'backend exited' },
    state,
    clearChatSendLifecycle() {},
    getMultiStreamController: () => controller,
    appendClientLog() {},
    showToastMessage(message, options) {
      toasts.push({ message, options });
    },
    reportError(input, context) {
      reports.push({ input, context });
      return { route: { ruleId: 3, surface: 'banner' }, toastId: '' };
    },
    toastSource: 'chat-stream',
    nowIso: () => '2026-06-12T12:00:00.000Z',
  });

  assert.equal(recovered, true);
  assert.equal(toasts.length, 0, 'no sticky toast when the intake route succeeds');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].context.origin, 'chat-stream');
  assert.equal(reports[0].context.isInflightTurn, true);
  assert.equal(reports[0].context.backendUnusable, true);
  assert.match(reports[0].input.message, /backend stopped before this response finished/);
  assert.equal(reports[0].input.options.dedupeKey, 'chat-stream:backend-unusable');
  const messages = state.messagesBySession.get('session-live');
  const live = messages.find((message) => message.id === 'assistant-live');
  assert.equal(live.status, 'error', 'row mutation is unconditional');
});

test('recoverInflightSendsForUnusableBackend keeps the legacy toast when the intake route declines (flag off)', () => {
  const state = createState();
  const controller = createMultiStreamController();
  const toasts = [];

  recoverInflightSendsForUnusableBackend({
    payload: { phase: 'failed' },
    state,
    clearChatSendLifecycle() {},
    getMultiStreamController: () => controller,
    appendClientLog() {},
    showToastMessage(message, options) {
      toasts.push({ message, options });
    },
    reportError: () => null,
    toastSource: 'chat-stream',
  });

  assert.equal(toasts.length, 1, 'reportError returning null falls back to the toast');
  assert.equal(toasts[0].options.sticky, true);
  assert.equal(toasts[0].options.tone, 'danger');
});
