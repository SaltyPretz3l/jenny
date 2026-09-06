const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createComposerV2Factory } = require('../renderer/chat/renderer-composer-v2-factory');

const COMPOSER_FACTORY_KEYS = [
  'sendUtils',
  'composerFlowUtils',
  'streamHandlerUtils',
  'chatEventUtils',
  'createSlashCommandRegistry',
  'createContextCommand',
];

function buildStubBaseFactories() {
  const legacyController = {
    startPromptSend: async () => null,
    handleStopActiveStream: async () => null,
    getQueuedSend: () => null,
    clearQueuedSendForSession: () => {},
    restoreQueuedSendDraft: () => null,
    dispatchQueuedSendForSession: async () => null,
    handleElaborateMessage: async () => null,
    handleRegenerateMessage: async () => null,
    handleCopyMessage: async () => null,
  };
  return {
    sendUtils: { createSendController: () => legacyController },
    streamHandlerUtils: {},
    chatEventUtils: {},
    createSlashCommandRegistry: () => ({
      register() {}, listCommands() { return []; }, tryExecute() { return false; }, injectOutput() {},
    }),
    createContextCommand: () => async () => {},
    legacyController,
  };
}

test('base send factory shape has no composerV2 attached before wrapping', () => {
  const base = buildStubBaseFactories();
  const controller = base.sendUtils.createSendController({ state: {}, constants: {} });
  assert.equal(typeof controller.startPromptSend, 'function');
  assert.equal(controller.composerV2, undefined);
});

test('V2 factory returns the shell factory keyset and V2 flow module', () => {
  const base = buildStubBaseFactories();
  const v2 = createComposerV2Factory({
    sendUtils: base.sendUtils,
    streamHandlerUtils: base.streamHandlerUtils,
    chatEventUtils: base.chatEventUtils,
    createSlashCommandRegistry: base.createSlashCommandRegistry,
    createContextCommand: base.createContextCommand,
  });
  assert.deepEqual(Object.keys(v2).sort(), COMPOSER_FACTORY_KEYS.slice().sort());
  assert.equal(typeof v2.composerFlowUtils.createComposerV2FlowController, 'function');
});

test('V2 factory initializes state and attaches an explicit decoration marker', () => {
  const base = buildStubBaseFactories();
  const v2 = createComposerV2Factory({
    sendUtils: base.sendUtils,
    streamHandlerUtils: base.streamHandlerUtils,
    chatEventUtils: base.chatEventUtils,
    createSlashCommandRegistry: base.createSlashCommandRegistry,
    createContextCommand: base.createContextCommand,
  });
  const state = { ui: {} };
  const controller = v2.sendUtils.createSendController({ state });
  assert.equal(typeof controller.startPromptSend, 'function', 'base startPromptSend preserved');
  assert.deepEqual(controller.composerV2, { decorationsEnabled: true });
  assert.equal(Object.isFrozen(controller.composerV2), true, 'decoration marker is immutable');
  assert.ok(state.ui.composerV2.modeListeners instanceof Map, 'Composer V2 state is initialized');
});

test('V2 factory throws if sendUtils.createSendController is missing', () => {
  assert.throws(() => createComposerV2Factory({ sendUtils: {} }), /createSendController/);
});

test('renderer bootstrap contains zero references to the removed composer flag', () => {
  const shellSource = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'chat', 'renderer-chat-shell-controller.js'),
    'utf8',
  );
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  const removedFlag = ['composer', 'v2'].join('_');
  const removedEnv = ['JENNY_ENABLE_COMPOSER', 'V2'].join('_');
  for (const source of [shellSource, appSource]) {
    assert.equal(source.includes(removedFlag), false, 'renderer must not branch on the removed composer flag');
    assert.equal(source.toUpperCase().includes(removedEnv), false, 'renderer must not read removed composer env');
  }
});

test('renderer-chat-shell-controller.js forwards sendController.composerV2 on its return', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'chat', 'renderer-chat-shell-controller.js'),
    'utf8',
  );
  assert.match(source, /composerV2:\s*sendController\?\.composerV2/);
});

test('createChatShellController exposes composerV2 when V2 factory is supplied', () => {
  const base = buildStubBaseFactories();
  const v2Factories = createComposerV2Factory({
    sendUtils: base.sendUtils,
    streamHandlerUtils: base.streamHandlerUtils,
    chatEventUtils: base.chatEventUtils,
    createSlashCommandRegistry: base.createSlashCommandRegistry,
    createContextCommand: base.createContextCommand,
  });
  const { createChatShellController } = require('../renderer/chat/renderer-chat-shell-controller');
  const shell = createChatShellController({
    state: { ui: {}, attachments: { queued: [] } },
    slashDependencies: { estimateTokens: () => 0 },
    dom: { chatInput: { value: '', addEventListener() {} } },
    constants: { ACTIVITY_SCOPE: { settingsContextPreferences: 'sp' }, MESSAGE_STATUS: {}, INTERACTIVE_GUARDRAIL_PROMPT: '', INTERACTIVE_SEQUENCE_IDLE: 'idle', INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE: 'structured', INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED: 'fallback', TOAST_SOURCE: {}, MAX_INTERACTIVE_ROUNDS: 4, MAX_INTERACTIVE_QUESTIONS: 4 },
    controllers: {},
    factories: v2Factories,
    callbacks: {
      renderAll() {}, appendClientLog() {}, escapeHtml: (s) => s, showToastMessage() {},
      getCurrentSessionMessages: () => [],
    },
  });
  assert.ok(shell, 'shell controller constructed');
  assert.deepEqual(shell.composerV2, { decorationsEnabled: true }, 'shell exposes the decoration marker');
});

test('renderer app bootstrap creates Composer V2 unconditionally', async (t) => {
  const { loadRendererApp } = require('./helpers/renderer-shell-harness');
  const { window, dispose } = await loadRendererApp();
  t.after(() => dispose());

  const removedFlag = ['composer', 'v2'].join('_');
  assert.equal(Object.prototype.hasOwnProperty.call(window.__rendererState.features.featureFlags, removedFlag), false);
  assert.ok(window.__rendererState.ui.composerV2, 'Composer V2 state was initialized by app bootstrap');
  assert.equal(typeof window.__rendererState.ui.composerV2.modeListeners?.get, 'function');
  const runModeChip = window.document.getElementById('composerRunModeChip');
  assert.ok(runModeChip, 'Composer V2 decorations mounted the run-mode chip');
  assert.ok(runModeChip.closest('#composerRunModeSlot'), 'the run-mode chip mounts in the rail slot');
  const composerModeChips = window.document.getElementById('composerModeChips');
  assert.equal(composerModeChips?.classList.contains('hidden'), false, 'the mode row (announcer + hint) is not hidden');
});
