const test = require('node:test');
const assert = require('node:assert/strict');

const { createSendController } = require('../renderer/chat/renderer-send-utils');
const { createMultiStreamController } = require('../renderer/chat/renderer-multi-stream-utils');

// Atomic edit-and-regenerate regressions: startPromptSend with an
// editedMessageId bypasses slash interception, invokes one dedicated backend
// command, and requires that command's authoritative edited-message identity.
// Local
// harness modeled on tests/renderer-send-utils-draft-restore.test.js (that
// file also duplicates its own harness rather than sharing
// tests/helpers/send-controller-harness.js) because this file needs a
// configurable slashCommandRegistry, which the shared helper hardcodes to null.

function createHarness(options = {}) {
  const state = {
    activeStreamId: '',
    activeStreamSessionId: '',
    backend: { phase: 'ready' },
    auth: { authenticated: true },
    attachments: { queued: [] },
    currentSessionId: options.currentSessionId !== undefined ? options.currentSessionId : 'session-1',
    queuedSendBySession: new Map(),
    sessions: Array.isArray(options.sessions)
      ? options.sessions.map((session) => ({ ...session }))
      : [{ id: 'session-1', title: 'Session 1' }],
    messagesBySession: new Map(options.messagesBySession || [['session-1', []]]),
    turnEventsBySession: new Map(),
    interactiveDraftsBySession: new Map(),
    sessionMessageAccessOrder: new Map(),
    bufferedStreamEventsByStream: new Map(),
    streamThinkingStatusByStream: new Map(),
    pendingStreams: new Map(),
    pendingToolApprovals: new Map(),
    sendPreflight: null,
    ui: { chatSendLifecycleBySession: new Map() },
  };
  const chatInput = { value: String(options.chatInputValue || ''), disabled: false };
  const calls = {
    startStream: [],
    editAndRegenerate: [],
    cancelStream: [],
    flushedBufferedStreams: [],
    droppedBufferedStreams: [],
    errors: [],
    logs: [],
    resetQueue: 0,
    slashTryExecute: [],
  };
  const originalWindow = global.window;
  const multiStreamController = createMultiStreamController({
    getState: () => state,
    appendClientLog() {},
  });

  const chatBridge = {
    async startStream(payload) {
      calls.startStream.push(payload);
      if (typeof options.startStream === 'function') {
        return options.startStream(payload);
      }
      return { sessionId: payload.sessionId || 'session-1', streamId: 'stream-normal' };
    },
    async cancelStream(streamId) {
      calls.cancelStream.push(streamId);
      return { ok: true };
    },
  };
  if (options.omitEditAndRegenerate !== true) {
    chatBridge.editAndRegenerate = async (payload) => {
      calls.editAndRegenerate.push(payload);
      if (typeof options.editAndRegenerate === 'function') {
        return options.editAndRegenerate(payload);
      }
      return {
        sessionId: payload.sessionId || 'session-1',
        streamId: 'stream-edit',
        identity: { userMessageId: payload.editedMessageId },
      };
    };
  }
  global.window = {
    jennyShell: { chat: chatBridge },
  };

  const slashCommandRegistry = options.slashCommandRegistry || {
    tryExecute: (text) => {
      calls.slashTryExecute.push(text);
      return false;
    },
  };

  const controller = createSendController({
    state,
    dom: { chatInput },
    multiStreamController,
    slashCommandRegistry,
    constants: {
      MESSAGE_STATUS: { STREAMING: 'streaming', COMPLETE: 'complete', ERROR: 'error' },
      INTERACTIVE_GUARDRAIL_PROMPT: 'Guardrail prompt',
      INTERACTIVE_SEQUENCE_IDLE: 'idle',
      INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE: 'structured_active',
      INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED: 'fallback_requested',
      TOAST_SOURCE: { attachments: 'attachments' },
      MAX_INTERACTIVE_ROUNDS: 3,
    },
    callbacks: {
      getActiveSession: () => state.sessions.find((session) => session.id === state.currentSessionId) || null,
      getPendingQuestionBatch: () => null,
      normalizePendingQuestionBatch: () => null,
      shouldForceInteractiveGuardrail: () => false,
      getInteractiveSequenceState: () => 'idle',
      clearInteractiveDraft: () => {},
      patchSessionSummary: () => {},
      getCurrentRuntimePreferences: () => ({
        preferredModel: '',
        reasoningEffort: 'default',
        conversationMode: 'chat',
        contextPreferences: {
          historyScope: 'session',
          includePersonality: true,
          includeMemory: true,
        },
        planMode: false,
      }),
      getCurrentVisibleMessages: () => state.messagesBySession.get(state.currentSessionId) || [],
      getCurrentSessionMessages: () => state.messagesBySession.get(state.currentSessionId) || [],
      getSessionTurnEventState: () => ({ turnEvents: [] }),
      getSessionMessages: (sessionId) => state.messagesBySession.get(String(sessionId || '').trim()) || [],
      setSessionMessages: (sessionId, nextMessages) => {
        state.messagesBySession.set(String(sessionId || '').trim(), nextMessages);
      },
      createNormalizedMessage: (role, content, extra = {}) => ({
        id: extra.id || `${role}_local`,
        role,
        content,
        ...extra,
        attachments: extra.attachments || [],
        status: extra.status || 'complete',
      }),
      resolveSessionId: (sessionId) => String(sessionId || '').trim(),
      buildAttachmentBudget: (entries) => ({
        accepted: Array.isArray(entries) ? entries.map((entry) => ({ ...entry })) : [],
        skipped: [],
      }),
      resetAttachmentQueue: () => {
        calls.resetQueue += 1;
        state.attachments.queued = [];
      },
      showToastMessage: () => {},
      clearComposerStatusNotice: () => {},
      setComposerStatusNotice: () => {},
      showComposerActionError: (error, title) => {
        calls.errors.push({ title, message: error?.message || String(error) });
      },
      renderComposerState: () => {},
      renderMessages: () => {},
      renderSessions: () => {},
      renderHeader: () => {},
      syncComposerInputHeight: () => {},
      syncComposerVisualState: () => {},
      setFollowLatest: () => {},
      appendClientLog: (level, event, details) => {
        calls.logs.push({ level, event, details });
      },
      refreshSessionSummaries: async () => ({
        currentSessionId: state.currentSessionId,
        validSessionIds: new Set(state.sessions.map((session) => session.id)),
      }),
      thinkingController: { resumeAutoScroll: () => {} },
      optimisticAppend: (sessionId, role, content, extra = {}) => {
        const message = {
          id: extra.id || `${role}_${Date.now()}`,
          role,
          content,
          attachments: extra.attachments || [],
        };
        state.messagesBySession.set(sessionId, [...(state.messagesBySession.get(sessionId) || []), message]);
        return message;
      },
      flushBufferedStreamEvents: async (streamId) => {
        calls.flushedBufferedStreams.push(streamId);
        return { flushedCount: 0, terminal: false };
      },
      dropBufferedStreamEvents: (streamId) => {
        calls.droppedBufferedStreams.push(streamId);
      },
      isSendBusy: () => false,
      isSessionStreaming: () => false,
      hasPendingToolApprovalForSession: () => false,
      getCurrentMessageById: () => null,
      getElaboratePrompt: () => '',
      getLatestReplyAssistantMessageId: () => '',
      resolveRegenerateRequest: () => null,
      showCopyFeedback: () => {},
      upsertSessionSummary: (summary) => {
        const normalized = summary && typeof summary === 'object' ? { ...summary } : null;
        const sessionId = String(normalized?.id || '').trim();
        if (!sessionId) return null;
        const existingIndex = state.sessions.findIndex((session) => String(session?.id || '').trim() === sessionId);
        if (existingIndex === -1) {
          state.sessions = [normalized, ...state.sessions];
          return normalized;
        }
        state.sessions[existingIndex] = { ...state.sessions[existingIndex], ...normalized };
        return state.sessions[existingIndex];
      },
      removeSessionState: () => {},
      rekeySessionState: (_from, to) => to,
      attachPendingOriginToSession: () => {},
      rekeySessionOrigin: () => {},
      onUserSendStarted: () => {},
      getToolPreferences: () => ({}),
      setChatSendLifecycle: (sessionId, lifecycle) => {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) return 'idle';
        state.ui.chatSendLifecycleBySession.set(normalizedSessionId, lifecycle);
        return lifecycle;
      },
      clearChatSendLifecycle: (sessionId) => state.ui.chatSendLifecycleBySession.delete(String(sessionId || '').trim()),
      moveChatSendLifecycle: (_from, to) => {
        if (to) state.ui.chatSendLifecycleBySession.set(to, 'preflight');
        return 'preflight';
      },
    },
  });

  return {
    controller,
    state,
    chatInput,
    calls,
    restore() {
      global.window = originalWindow;
    },
  };
}

// ---- Atomic edit-and-regenerate routing and identity ----------------------

test('startPromptSend sends edited slash-shaped content through one editAndRegenerate command', async (t) => {
  const anchor = { id: 'custom-user-anchor', role: 'user', content: 'original prompt' };
  const harness = createHarness({
    chatInputValue: '',
    messagesBySession: [['session-1', [anchor]]],
  });
  t.after(() => harness.restore());

  const result = await harness.controller.startPromptSend('/help something', {
    visiblePrompt: '/help something',
    editedMessageId: 'custom-user-anchor',
    sessionIdOverride: 'session-1',
    preserveComposerDraft: true,
  });

  assert.equal(harness.calls.slashTryExecute.length, 0);
  assert.equal(harness.calls.startStream.length, 0, 'ordinary startStream must not run');
  assert.equal(harness.calls.editAndRegenerate.length, 1);
  assert.equal(harness.calls.editAndRegenerate[0].prompt, '/help something');
  assert.equal(harness.calls.editAndRegenerate[0].editedMessageId, 'custom-user-anchor');
  assert.deepEqual(
    harness.state.messagesBySession.get('session-1'),
    [anchor],
    'the existing anchor is reused without a transient optimistic user row'
  );
  assert.equal(result?.streamId, 'stream-edit');
  assert.equal(result?.identity?.userMessageId, 'custom-user-anchor');
});

test('startPromptSend still intercepts slash commands for an ordinary (non-edit) send (no regression)', async (t) => {
  const interceptedTexts = [];
  const slashCommandRegistry = {
    tryExecute: (text) => {
      interceptedTexts.push(text);
      return true;
    },
  };
  const harness = createHarness({ chatInputValue: '/help', slashCommandRegistry });
  t.after(() => harness.restore());

  const result = await harness.controller.startPromptSend('/help');

  assert.deepEqual(interceptedTexts, ['/help']);
  assert.equal(result, null);
  assert.equal(harness.calls.startStream.length, 0);
  assert.equal(harness.calls.editAndRegenerate.length, 0);
  assert.equal(harness.chatInput.value, '');
});

test('failed slash command completion preserves the exact composer draft', async (t) => {
  const slashCommandRegistry = {
    execute: () => ({
      matched: true,
      accepted: true,
      clearPolicy: 'on_success',
      invocation: { sessionId: 'session-1', generation: 0 },
      completion: Promise.resolve({ ok: false, code: 'capture_failed' }),
    }),
  };
  const harness = createHarness({ chatInputValue: '  /note keep this  ', slashCommandRegistry });
  t.after(() => harness.restore());

  await harness.controller.startPromptSend('/note keep this');

  assert.equal(harness.chatInput.value, '  /note keep this  ');
  assert.equal(harness.calls.startStream.length, 0);
});

test('successful slash completion never clears text typed while the command was pending', async (t) => {
  let settle;
  const slashCommandRegistry = {
    execute: () => ({
      matched: true,
      accepted: true,
      clearPolicy: 'on_success',
      invocation: { sessionId: 'session-1', generation: 0 },
      completion: new Promise((resolve) => { settle = resolve; }),
    }),
  };
  const harness = createHarness({ chatInputValue: '/note original', slashCommandRegistry });
  t.after(() => harness.restore());

  const pending = harness.controller.startPromptSend('/note original');
  harness.chatInput.value = 'new draft';
  settle({ ok: true, code: 'note_saved' });
  await pending;

  assert.equal(harness.chatInput.value, 'new draft');
  assert.equal(harness.calls.startStream.length, 0);
});

// ---- Atomic failure leaves the existing anchor untouched ------------------

test('failed editAndRegenerate keeps the composer and existing anchor untouched', async (t) => {
  const anchor = { id: 'msg_1', role: 'user', content: 'original prompt' };
  const harness = createHarness({
    chatInputValue: '',
    messagesBySession: [['session-1', [anchor]]],
    editAndRegenerate: async () => {
      throw new Error('sidecar unavailable');
    },
  });
  t.after(() => harness.restore());

  const result = await harness.controller.startPromptSend('edited prompt body', {
    visiblePrompt: 'edited prompt body',
    editedMessageId: 'msg_1',
    sessionIdOverride: 'session-1',
    preserveComposerDraft: true,
  });

  assert.equal(result, null);
  assert.equal(harness.chatInput.value, '', 'the inline editor, not the composer, owns the retry draft');
  assert.deepEqual(harness.state.messagesBySession.get('session-1'), [anchor]);
  assert.equal(harness.calls.startStream.length, 0);
  assert.equal(harness.calls.editAndRegenerate.length, 1);
  assert.equal(harness.calls.errors.length, 1, 'exactly one notice fires');
  assert.equal(harness.calls.errors[0].title, 'Edit Failed');
  assert.match(harness.calls.errors[0].message, /retry|replacement/i);
  const lifecycleEvents = harness.calls.logs.filter((entry) => entry.event === 'lifecycle.edit_transaction_half');
  assert.equal(lifecycleEvents.length, 0, 'the split-transaction diagnostic is retired on the atomic path');
});

test('editAndRegenerate without authoritative identity fails closed and cancels the returned stream', async (t) => {
  const anchor = { id: 'msg_1', role: 'user', content: 'original prompt' };
  const harness = createHarness({
    chatInputValue: '',
    messagesBySession: [['session-1', [anchor]]],
    editAndRegenerate: async () => ({
      sessionId: 'session-1',
      streamId: 'stream-missing-identity',
    }),
  });
  t.after(() => harness.restore());

  const result = await harness.controller.startPromptSend('edited prompt body', {
    visiblePrompt: 'edited prompt body',
    editedMessageId: 'msg_1',
    sessionIdOverride: 'session-1',
    preserveComposerDraft: true,
  });

  assert.equal(result, null);
  assert.deepEqual(harness.calls.cancelStream, ['stream-missing-identity']);
  assert.deepEqual(harness.state.messagesBySession.get('session-1'), [anchor]);
  assert.equal(
    harness.calls.logs.some((entry) => entry.event === 'chat.start_identity_legacy_fallback'),
    false,
    'edit-regenerate never guesses user_<streamId>'
  );
});

test('editAndRegenerate rejects an authoritative identity that differs from the edited anchor', async (t) => {
  const anchor = { id: 'msg_1', role: 'user', content: 'original prompt' };
  const harness = createHarness({
    messagesBySession: [['session-1', [anchor]]],
    editAndRegenerate: async () => ({
      sessionId: 'session-1',
      streamId: 'stream-wrong-anchor',
      identity: { userMessageId: 'different-user-id' },
    }),
  });
  t.after(() => harness.restore());

  const result = await harness.controller.startPromptSend('edited prompt body', {
    visiblePrompt: 'edited prompt body',
    editedMessageId: 'msg_1',
    sessionIdOverride: 'session-1',
    preserveComposerDraft: true,
  });

  assert.equal(result, null);
  assert.deepEqual(harness.calls.cancelStream, ['stream-wrong-anchor']);
  assert.deepEqual(harness.state.messagesBySession.get('session-1'), [anchor]);
});

for (const [label, onAuthoritativeStart] of [
  ['returns false', () => false],
  ['throws', () => { throw new Error('renderer cache unavailable'); }],
]) {
  test(`failed authoritative retry reconciliation (${label}) cancels before buffered events flush`, async (t) => {
    const anchor = { id: 'msg_1', role: 'user', content: 'original prompt' };
    const errorMessage = { id: 'error_1', role: 'assistant', status: 'error', stream_error: 'failed' };
    const harness = createHarness({
      messagesBySession: [['session-1', [anchor, errorMessage]]],
    });
    t.after(() => harness.restore());

    const result = await harness.controller.startPromptSend('edited prompt body', {
      visiblePrompt: 'edited prompt body',
      editedMessageId: 'msg_1',
      sessionIdOverride: 'session-1',
      preserveComposerDraft: true,
      onAuthoritativeStart,
    });

    assert.equal(result, null);
    assert.deepEqual(harness.calls.cancelStream, ['stream-edit']);
    assert.deepEqual(harness.calls.droppedBufferedStreams, ['stream-edit']);
    assert.deepEqual(harness.calls.flushedBufferedStreams, []);
    assert.deepEqual(harness.state.messagesBySession.get('session-1'), [anchor, errorMessage]);
  });
}

test('missing editAndRegenerate bridge fails closed without falling back to startStream', async (t) => {
  const harness = createHarness({ omitEditAndRegenerate: true });
  t.after(() => harness.restore());

  const result = await harness.controller.startPromptSend('edited prompt body', {
    visiblePrompt: 'edited prompt body',
    editedMessageId: 'msg_1',
    sessionIdOverride: 'session-1',
    preserveComposerDraft: true,
  });

  assert.equal(result, null);
  assert.equal(harness.calls.startStream.length, 0);
  assert.equal(harness.calls.editAndRegenerate.length, 0);
  const failureLog = harness.calls.logs.find(
    (entry) => entry.event === 'chat.send_failed'
      && entry.details.failureClass === 'edit_regenerate_rejected'
  );
  assert.ok(failureLog);
  assert.equal(Object.hasOwn(failureLog.details, 'message'), false, 'edit failures are logged without backend error text');
});

test('a normal (non-edit) send failure still shows the generic "Send Failed" notice (no regression)', async (t) => {
  const harness = createHarness({
    currentSessionId: 'session-1',
    chatInputValue: '',
    startStream: async () => {
      throw new Error('sidecar unavailable');
    },
  });
  t.after(() => harness.restore());

  const result = await harness.controller.startPromptSend('a normal prompt', { restoreInputOnError: true });

  assert.equal(result, null);
  assert.equal(harness.calls.errors.length, 1);
  assert.equal(harness.calls.errors[0].title, 'Send Failed');
  assert.equal(
    harness.calls.logs.some((entry) => entry.event === 'lifecycle.edit_transaction_half'),
    false,
    'a non-edit send failure is not an edit-transaction — the counter must not fire'
  );
});

test('ordinary legacy start fakes may use the logged user_<streamId> identity fallback', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  const result = await harness.controller.startPromptSend('ordinary prompt');

  assert.equal(result?.streamId, 'stream-normal');
  assert.equal(harness.calls.startStream.length, 1);
  assert.equal(harness.calls.editAndRegenerate.length, 0);
  assert.equal(harness.state.messagesBySession.get('session-1')[0].id, 'user_stream-normal');
  assert.ok(harness.calls.logs.find(
    (entry) => entry.event === 'chat.start_identity_legacy_fallback'
      && entry.details.streamId === 'stream-normal'
  ));
});
