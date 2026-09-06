const test = require('node:test');
const assert = require('node:assert/strict');

const { createChatShellController } = require('../renderer/chat/renderer-chat-shell-controller.js');

function createEventTarget(name) {
  return {
    name,
    added: [],
    removed: [],
    addEventListener(eventName, handler) {
      this.added.push({ eventName, handler });
    },
    removeEventListener(eventName, handler) {
      this.removed.push({ eventName, handler });
    },
  };
}

function createMinimalSlashDependencies() {
  return {
    estimateTokens() { return 0; },
    areInteractiveQuestionsAnswered() { return false; },
    getInteractiveNextUnansweredIndex() { return 0; },
    getInteractiveQuestionOptions() { return []; },
    isInteractiveQuestionAnswered() { return false; },
    isInteractiveOtherTrigger() { return false; },
    getInteractiveComposerStatusNotice() { return null; },
  };
}

test('chat shell controller binds child wiring once', async () => {
  const calls = [];

  const controller = createChatShellController({
    state: { currentSessionId: 'session-1' },
    compactionCoordinator: {
      invoke(sessionId, options) { calls.push(`compact:${sessionId}:${options.source}`); return Promise.resolve({ accepted: true }); },
    },
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
      appendClientLog(level, eventName, payload) {
        calls.push(`log:${level}:${eventName}:${payload?.message || ''}`);
      },
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
      runRuntimePreferenceActivity: async () => {
        calls.push('runRuntimePreferenceActivity');
      },
      openArtifactTarget: async (artifactId, options) => {
        calls.push(`openArtifactTarget:${artifactId}:${options?.source || ''}`);
      },
      setActiveView(nextView) {
        calls.push(`setActiveView:${nextView}`);
      },
    },
    factories: {
      sendUtils: {
        createSendController() {
          calls.push('createSendController');
          return {
            startPromptSend: async () => { calls.push('startPromptSend'); },
            handleStopActiveStream: async () => { calls.push('handleStopActiveStream'); },
            handleCopyMessage: async () => { calls.push('handleCopyMessage'); },
            handleElaborateMessage: async () => { calls.push('handleElaborateMessage'); },
            handleRegenerateMessage: async () => { calls.push('handleRegenerateMessage'); },
          };
        },
      },
      composerFlowUtils: {
        createComposerV2FlowController() {
          calls.push('createComposerV2FlowController');
          return {
            handleInteractiveOptionSelect() {},
            handleInteractiveOtherConfirm() {},
            handleInteractiveOtherInputChange() {},
            handleInteractiveSkip() {},
            handleInteractiveSkipQuestion() {},
            handleInteractiveSkipAll() {},
            handleInteractiveSubmit() {},
            handleSend() { calls.push('handleSend'); },
          };
        },
      },
      streamHandlerUtils: {
        createStreamHandler() {
          calls.push('createStreamHandler');
          return {
            registerStreamHandler(shell) {
              assert.deepEqual(shell, { chat: {} });
              calls.push('streamHandler.register');
            },
            dispose() {
              calls.push('streamHandler.dispose');
            },
            optimisticAppend() { return {}; },
            flushBufferedStreamEvents: async () => ({ flushedCount: 0, terminal: false }),
            dropBufferedStreamEvents() {},
          };
        },
      },
      chatEventUtils: {
        createChatEventBindings() {
          calls.push('createChatEventBindings');
          return {
            bind() { calls.push('chatEvents.bind'); },
            dispose() { calls.push('chatEvents.dispose'); },
          };
        },
      },
      createSlashCommandRegistry() {
        const commands = [];
        return {
          register(commandName, _description, handler) {
            commands.push({ commandName, handler });
          },
          listCommands() {
            return commands.map((entry) => entry.commandName);
          },
          tryExecute(prompt) {
            const commandName = String(prompt || '').trim().split(/\s+/, 1)[0];
            const command = commands.find((entry) => entry.commandName === commandName);
            return command ? command.handler({ sessionId: 'session-1' }) : false;
          },
          injectOutput(message, commandName) {
            calls.push(`slashOutput:${commandName}:${message}`);
          },
        };
      },
      createContextCommand() {
        return async function noopContextCommand() {};
      },
    },
  });

  controller.bind();
  controller.bind();

  assert.deepEqual(controller.listSlashCommands(), ['/help', '/context', '/compact', '/note']);
  await controller.tryExecuteSlashCommand('/compact');

  await controller.handleStopActiveStream();
  controller.handleSend();

  controller.dispose();
  controller.dispose();

  assert.deepEqual(calls, [
    'createSendController',
    'createComposerV2FlowController',
    'createStreamHandler',
    'createChatEventBindings',
    'streamHandler.register',
    'chatEvents.bind',
    'compact:session-1:slash',
    'handleStopActiveStream',
    'handleSend',
    'chatEvents.dispose',
    'streamHandler.dispose',
  ]);
});

test('F10: chat shell wires unread orientation controller into stream and event layers', () => {
  const previousUnreadApi = global.rendererChatUnreadOrientationUtils;
  const unreadCalls = [];
  const wayfinderCalls = [];
  const unreadController = {
    noteTimelineMessageCreated(event) {
      unreadCalls.push(event);
      return true;
    },
    jumpToFirstUnread() {},
    handleScroll() {},
    attachAffordance() {},
    dispose() {},
  };
  global.rendererChatUnreadOrientationUtils = {
    createUnreadOrientationController(options) {
      assert.equal(options.state.currentSessionId, 'session-1');
      assert.equal('renderAffordance' in options, false, 'the legacy affordance option is retired - Wayfinder owns unread UI');
      options.onStateChange({ visible: true, hasUnread: true, sessionId: 'session-1', messageId: 'a1' });
      return unreadController;
    },
  };

  try {
    let streamCallbacks = null;
    let eventControllers = null;
    const scrollCoordinator = {};
    const controllers = {
      multiStreamController: {},
      thinkingController: {},
      thinkingIndicator: {},
      toastActionHandlers: {},
      timelineVirtualizer: {},
      chatScrollCoordinator: scrollCoordinator,
    };
    const controller = createChatShellController({
      state: { currentSessionId: 'session-1', ui: { activeView: 'chat' } },
      windowRef: { jennyShell: { chat: {} } },
      composerInteractivePanel: {},
      slashDependencies: createMinimalSlashDependencies(),
      dom: {
        chatInput: { value: '', disabled: false },
        chatTimeline: {},
        chatThreadScroll: {},
      },
      constants: {
        MESSAGE_STATUS: {},
        TOAST_SOURCE: {},
        ACTIVITY_SCOPE: { settingsContextPreferences: 'settings.context.preferences' },
        MAX_INTERACTIVE_QUESTIONS: 3,
        MAX_INTERACTIVE_ROUNDS: 3,
        INTERACTIVE_GUARDRAIL_PROMPT: 'Guardrail prompt',
        INTERACTIVE_SEQUENCE_IDLE: 'idle',
        INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE: 'structured_active',
        INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED: 'fallback_requested',
      },
      controllers,
      callbacks: {
        renderAll() {},
        appendClientLog() {},
        escapeHtml(value) { return String(value || ''); },
        showToastMessage() {},
        getCurrentSessionMessages() { return []; },
        getCurrentRuntimePreferences() { return { contextPreferences: {} }; },
        getRuntimePreferenceSnapshot() { return {}; },
        runRuntimePreferenceActivity: async () => {},
        getScrollMetrics() { return { scrollTop: 0, scrollHeight: 0, clientHeight: 0 }; },
        onUnreadOrientationStateChange(nextState) {
          wayfinderCalls.push(['state', nextState.messageId]);
        },
        setUnreadOrientationController(nextController) {
          wayfinderCalls.push(['controller', nextController === unreadController]);
        },
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
          createStreamHandler(deps) {
            streamCallbacks = deps.callbacks;
            return {
              registerStreamHandler() {},
              dispose() {},
            };
          },
        },
        chatEventUtils: {
          createChatEventBindings(deps) {
            eventControllers = deps.controllers;
            return { bind() {}, dispose() {} };
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

    assert.equal(controllers.unreadOrientationController, unreadController);
    assert.equal(eventControllers.unreadOrientationController, unreadController);
    assert.equal(eventControllers.chatScrollCoordinator, scrollCoordinator);
    assert.deepEqual(wayfinderCalls, [['state', 'a1'], ['controller', true]]);
    streamCallbacks.noteTimelineMessageCreated({
      sessionId: 'session-1',
      messageId: 'a1',
      role: 'assistant',
      kind: '',
      visible: true,
    });
    assert.deepEqual(unreadCalls, [{
      sessionId: 'session-1',
      messageId: 'a1',
      role: 'assistant',
      kind: '',
      visible: true,
    }]);

    controller.dispose();
  } finally {
    global.rendererChatUnreadOrientationUtils = previousUnreadApi;
  }
});



test('chat shell controller forwards toggleThreadBranch into chat event bindings', () => {
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
      toggleThreadBranch() {},
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
});

test('chat shell controller forwards composer paste guard into chat event bindings', () => {
  let receivedCallbacks = null;
  const pasteGuard = () => ({ accepted: true, sizeBytes: 0, warned: false });

  createChatShellController({
    state: {},
    windowRef: { jennyShell: { chat: {} } },
    composerInteractivePanel: {},
    slashDependencies: createMinimalSlashDependencies(),
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
          return { handleComposerPaste: pasteGuard };
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

  assert.equal(receivedCallbacks?.handleComposerPaste, pasteGuard);
});

test('stream handler wiring receives the chat timeline node and virtualizer (live tool patch gate)', () => {
  // Regression: the createStreamHandler call passed dom: { chatInput } only, so
  // renderer-stream-handler's `const { chatTimeline } = deps.dom` was always
  // undefined and createLiveToolPatchController hit the missing_timeline
  // fallback on every tool event — the in-place patch path was dead in the
  // packaged app even though it was fully covered at the unit level.
  const chatTimeline = { id: 'chatTimeline' };
  const timelineVirtualizer = { id: 'timelineVirtualizer' };
  let streamHandlerDeps = null;

  createChatShellController({
    state: {},
    windowRef: { jennyShell: { chat: {} } },
    composerInteractivePanel: {},
    slashDependencies: createMinimalSlashDependencies(),
    dom: {
      chatInput: { value: '', disabled: false },
      chatTimeline,
    },
    constants: {
      MESSAGE_STATUS: {},
      TOAST_SOURCE: {},
      ACTIVITY_SCOPE: { settingsContextPreferences: 'settings.context.preferences' },
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
      timelineVirtualizer,
    },
    callbacks: {
      renderAll() {},
      appendClientLog() {},
      escapeHtml(value) { return String(value || ''); },
      showToastMessage() {},
      getCurrentSessionMessages() { return []; },
      getCurrentRuntimePreferences() { return { contextPreferences: {} }; },
      getRuntimePreferenceSnapshot() { return {}; },
      runRuntimePreferenceActivity: async () => {},
    },
    factories: {
      sendUtils: {
        createSendController() { return {}; },
      },
      composerFlowUtils: {
        createComposerV2FlowController() { return {}; },
      },
      streamHandlerUtils: {
        createStreamHandler(deps) {
          streamHandlerDeps = deps;
          return {
            registerStreamHandler() {},
            dispose() {},
          };
        },
      },
      chatEventUtils: {
        createChatEventBindings() {
          return { bind() {}, dispose() {} };
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

  assert.ok(streamHandlerDeps, 'createStreamHandler must be invoked');
  assert.equal(streamHandlerDeps.dom.chatTimeline, chatTimeline);
  assert.equal(streamHandlerDeps.dom.chatInput.disabled, false);
  assert.equal(streamHandlerDeps.timelineVirtualizer, timelineVirtualizer);
});
