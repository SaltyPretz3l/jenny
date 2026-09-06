const test = require('node:test');
const assert = require('node:assert/strict');

const { createChatShellController } = require('../renderer/chat/renderer-chat-shell-controller.js');

function createSelectionLifecycleHarness(overrides = {}) {
  let sendDependencies = null;
  const state = { currentSessionId: 'session_a', ui: {} };
  const shell = createChatShellController({
    state,
    windowRef: overrides.windowRef || { jennyShell: { chat: {} } },
    slashDependencies: {
      getInteractiveComposerStatusNotice() { return null; },
    },
    dom: { chatInput: { value: '', disabled: false } },
    constants: {
      MESSAGE_STATUS: {},
      TOAST_SOURCE: {},
      ACTIVITY_SCOPE: {},
    },
    controllers: {},
    callbacks: {
      renderAll() {},
      appendClientLog() {},
      showToastMessage() {},
      getCurrentSessionMessages() { return []; },
      onUserSendStarted: overrides.onUserSendStarted || (() => {}),
      activateWorkspaceSession: overrides.activateWorkspaceSession || (() => null),
    },
    factories: {
      sendUtils: {
        createSendController(dependencies) {
          sendDependencies = dependencies;
          return {
            startPromptSend: async (payload) => {
              dependencies.callbacks.onUserSendStarted(payload);
              return payload;
            },
          };
        },
      },
      composerFlowUtils: { createComposerV2FlowController() { return {}; } },
    },
  });
  return { sendDependencies, shell, state };
}

test('chat shell exits selection mode before the successful send-start callback repaints', async (t) => {
  const previousSelectionUtils = globalThis.rendererChatSelectionUtils;
  const calls = [];
  globalThis.rendererChatSelectionUtils = {
    createSelectionController() {
      return { onStreamStarted: () => calls.push('selection-stream-started') };
    },
  };
  t.after(() => { globalThis.rendererChatSelectionUtils = previousSelectionUtils; });

  const { shell } = createSelectionLifecycleHarness({
    onUserSendStarted: () => calls.push('send-start-repaint'),
  });
  await shell.startPromptSend({ sessionId: 'session_a' });

  assert.deepEqual(calls, ['selection-stream-started', 'send-start-repaint']);
});

test('chat shell exits selection mode before session activation can repaint', (t) => {
  const previousSelectionUtils = globalThis.rendererChatSelectionUtils;
  const calls = [];
  globalThis.rendererChatSelectionUtils = {
    createSelectionController() {
      return { onSessionSwitch: () => calls.push('selection-session-switch') };
    },
  };
  t.after(() => { globalThis.rendererChatSelectionUtils = previousSelectionUtils; });

  const { sendDependencies } = createSelectionLifecycleHarness({
    activateWorkspaceSession: () => calls.push('session-activation-repaint'),
  });
  sendDependencies.callbacks.activateWorkspaceSession('session_b');

  assert.deepEqual(calls, ['selection-session-switch', 'session-activation-repaint']);
});

test('chat shell routes bulk deletion through the renderer confirmation dialog', async (t) => {
  const previousSelectionUtils = globalThis.rendererChatSelectionUtils;
  const previousBulkUtils = globalThis.rendererChatBulkActionsUtils;
  let bulkDependencies = null;
  let confirmPayload = null;
  globalThis.rendererChatSelectionUtils = {
    createSelectionController() { return {}; },
  };
  globalThis.rendererChatBulkActionsUtils = {
    createBulkActionsController(dependencies) {
      bulkDependencies = dependencies;
      return {};
    },
  };
  t.after(() => {
    globalThis.rendererChatSelectionUtils = previousSelectionUtils;
    globalThis.rendererChatBulkActionsUtils = previousBulkUtils;
  });

  createSelectionLifecycleHarness({
    windowRef: {
      jennyShell: { chat: {} },
      document: {},
      inventoryActionButton() { return ''; },
      inventoryHelpOverlay: { createHelpOverlay() { return {}; } },
      rendererIdeConfirmDialog: {
        createIdeConfirmDialog() {
          return {
            confirm(payload) {
              confirmPayload = payload;
              return Promise.resolve(false);
            },
          };
        },
      },
    },
  });
  const confirmed = await bulkDependencies.confirmDelete('Delete this row and all later history?');

  assert.equal(confirmed, false);
  assert.deepEqual(confirmPayload, {
    title: 'Delete from here?',
    message: 'Delete this row and all later history?',
    confirmLabel: 'Delete',
    cancelLabel: 'Cancel',
    variant: 'danger',
  });
});

test('chat shell fails bulk deletion closed when confirmation is unavailable', async (t) => {
  const previousSelectionUtils = globalThis.rendererChatSelectionUtils;
  const previousBulkUtils = globalThis.rendererChatBulkActionsUtils;
  let bulkDependencies = null;
  globalThis.rendererChatSelectionUtils = {
    createSelectionController() { return {}; },
  };
  globalThis.rendererChatBulkActionsUtils = {
    createBulkActionsController(dependencies) {
      bulkDependencies = dependencies;
      return {};
    },
  };
  t.after(() => {
    globalThis.rendererChatSelectionUtils = previousSelectionUtils;
    globalThis.rendererChatBulkActionsUtils = previousBulkUtils;
  });

  createSelectionLifecycleHarness();
  const confirmed = await bulkDependencies.confirmDelete('Delete history?');

  assert.equal(confirmed, false);
});

test('chat shell disposal releases message-edit and selection controllers exactly once', (t) => {
  const previousMessageEditUtils = globalThis.rendererChatMessageEditUtils;
  const previousSelectionUtils = globalThis.rendererChatSelectionUtils;
  const disposals = { messageEdit: 0, selection: 0 };
  globalThis.rendererChatMessageEditUtils = {
    createMessageEditController() {
      return { dispose: () => { disposals.messageEdit += 1; } };
    },
  };
  globalThis.rendererChatSelectionUtils = {
    createSelectionController() {
      return { dispose: () => { disposals.selection += 1; } };
    },
  };
  t.after(() => {
    globalThis.rendererChatMessageEditUtils = previousMessageEditUtils;
    globalThis.rendererChatSelectionUtils = previousSelectionUtils;
  });

  const { shell } = createSelectionLifecycleHarness();
  shell.bind();
  shell.dispose();
  shell.dispose();

  assert.deepEqual(disposals, { messageEdit: 1, selection: 1 });
});

test('chat shell controller forwards chat zoom callbacks into chat event bindings', () => {
  let receivedCallbacks = null;
  const reasoningBatchCalls = [];

  createChatShellController({
    state: {},
    windowRef: { jennyShell: { chat: {} } },
    composerInteractivePanel: {},
    slashDependencies: {
      estimateTokens() { return 0; },
      areInteractiveQuestionsAnswered() { return false; },
      getInteractiveNextUnansweredIndex() { return 0; },
      getInteractiveQuestionOptions() { return []; },
      isInteractiveQuestionAnswered() { return false; },
      isInteractiveOtherTrigger() { return false; },
      getInteractiveComposerStatusNotice() { return null; },
    },
    dom: {
      chatInput: { value: '', disabled: false },
      chatView: {},
      artifactReviewPanel: {},
    },
    constants: {
      MESSAGE_STATUS: {},
      TOAST_SOURCE: {},
      ACTIVITY_SCOPE: {
        settingsContextPreferences: 'settings.context.preferences',
      },
      MAX_INTERACTIVE_QUESTIONS: 3,
      MAX_INTERACTIVE_ROUNDS: 3,
      INTERACTIVE_GUARDRAIL_PROMPT: 'Guardrail prompt',
      INTERACTIVE_SEQUENCE_IDLE: 'idle',
      INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE: 'structured_active',
      INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED: 'fallback_requested',
    },
    controllers: {
      multiStreamController: {},
      thinkingController: {},
      thinkingIndicator: {},
      toastActionHandlers: {},
    },
    callbacks: {
      renderAll() {},
      appendClientLog() {},
      escapeHtml(value) { return String(value || ''); },
      showToastMessage() {},
      getCurrentSessionMessages() { return []; },
      getCurrentRuntimePreferences() {
        return {
          contextPreferences: {
          },
        };
      },
      getRuntimePreferenceSnapshot() { return {}; },
      runRuntimePreferenceActivity: async () => {},
      adjustChatZoomPercent() {},
      resetChatZoomPercent() {},
      setReasoningPhaseExpandedPreferences(...args) { reasoningBatchCalls.push(args); },
    },
    factories: {
      sendUtils: {
        createSendController() {
          return {};
        },
      },
      composerFlowUtils: {
        createComposerV2FlowController() {
          return {};
        },
      },
      streamHandlerUtils: {
        createStreamHandler() {
          return {
            registerStreamHandler() {},
            dispose() {},
            optimisticAppend() { return {}; },
            flushBufferedStreamEvents: async () => ({ flushedCount: 0, terminal: false }),
            dropBufferedStreamEvents() {},
          };
        },
      },
      chatEventUtils: {
        createChatEventBindings(args) {
          receivedCallbacks = args?.callbacks || null;
          return {
            bind() {},
            dispose() {},
          };
        },
      },
      createSlashCommandRegistry() {
        return {
          register() {},
          listCommands() { return []; },
          tryExecute() { return false; },
          injectOutput() {},
        };
      },
      createContextCommand() {
        return async function noopContextCommand() {};
      },
    },
  });

  assert.equal(typeof receivedCallbacks?.adjustChatZoomPercent, 'function');
  assert.equal(typeof receivedCallbacks?.resetChatZoomPercent, 'function');
  assert.equal(typeof receivedCallbacks?.setReasoningPhaseExpandedPreferences, 'function');
  receivedCallbacks.setReasoningPhaseExpandedPreferences('session_1', [{ messageId: 'message_1' }]);
  assert.deepEqual(reasoningBatchCalls, [['session_1', [{ messageId: 'message_1' }]]]);
});

test('chat shell controller keeps toggleThreadBranch safe when the callback bundle omits it', () => {
  let receivedCallbacks = null;

  createChatShellController({
    state: {},
    windowRef: { jennyShell: { chat: {} } },
    composerInteractivePanel: {},
    slashDependencies: {
      estimateTokens() { return 0; },
      areInteractiveQuestionsAnswered() { return false; },
      getInteractiveNextUnansweredIndex() { return 0; },
      getInteractiveQuestionOptions() { return []; },
      isInteractiveQuestionAnswered() { return false; },
      isInteractiveOtherTrigger() { return false; },
      getInteractiveComposerStatusNotice() { return null; },
    },
    dom: {
      chatInput: { value: '', disabled: false },
    },
    constants: {
      MESSAGE_STATUS: {},
      TOAST_SOURCE: {},
      ACTIVITY_SCOPE: {
        settingsContextPreferences: 'settings.context.preferences',
      },
      MAX_INTERACTIVE_QUESTIONS: 3,
      MAX_INTERACTIVE_ROUNDS: 3,
      INTERACTIVE_GUARDRAIL_PROMPT: 'Guardrail prompt',
      INTERACTIVE_SEQUENCE_IDLE: 'idle',
      INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE: 'structured_active',
      INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED: 'fallback_requested',
    },
    controllers: {
      multiStreamController: {},
      thinkingController: {},
      thinkingIndicator: {},
      toastActionHandlers: {},
    },
    callbacks: {
      renderAll() {},
      appendClientLog() {},
      escapeHtml(value) { return String(value || ''); },
      showToastMessage() {},
      getCurrentSessionMessages() { return []; },
      getCurrentRuntimePreferences() {
        return {
          contextPreferences: {
          },
        };
      },
      getRuntimePreferenceSnapshot() { return {}; },
      runRuntimePreferenceActivity: async () => {},
    },
    factories: {
      sendUtils: {
        createSendController() {
          return {};
        },
      },
      composerFlowUtils: {
        createComposerV2FlowController() {
          return {};
        },
      },
      streamHandlerUtils: {
        createStreamHandler() {
          return {
            registerStreamHandler() {},
            dispose() {},
            optimisticAppend() { return {}; },
            flushBufferedStreamEvents: async () => ({ flushedCount: 0, terminal: false }),
            dropBufferedStreamEvents() {},
          };
        },
      },
      chatEventUtils: {
        createChatEventBindings(args) {
          receivedCallbacks = args?.callbacks || null;
          return {
            bind() {},
            dispose() {},
          };
        },
      },
      createSlashCommandRegistry() {
        return {
          register() {},
          listCommands() { return []; },
          tryExecute() { return false; },
          injectOutput() {},
        };
      },
      createContextCommand() {
        return async function noopContextCommand() {};
      },
    },
  });

  assert.equal(typeof receivedCallbacks?.toggleThreadBranch, 'function');
  assert.doesNotThrow(() => {
    receivedCallbacks.toggleThreadBranch('assistant_stream_1');
  });
});
