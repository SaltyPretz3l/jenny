'use strict';

const { JSDOM } = require('jsdom');

const {
  createSettingsEventBindings,
} = require('../../renderer/chat/renderer-chat-event-settings-bindings');
const {
  createRunModeSwitcherRenderer,
} = require('../../renderer/chat/renderer-composer-v2-render');

// Run-mode chip + settings bindings in a JSDOM, shared by the run-mode tests.
function restoreGlobal(key, previous) {
  if (previous === undefined) {
    delete globalThis[key];
  } else {
    globalThis[key] = previous;
  }
}

function createRunModeHarness(t, options = {}) {
  const dom = new JSDOM('<!doctype html><body></body>');
  const doc = dom.window.document;
  function appendElement(tagName, id, parent = doc.body) {
    const element = doc.createElement(tagName);
    element.id = id;
    parent.appendChild(element);
    return element;
  }
  appendElement('div', 'toastViewport');
  appendElement('select', 'composerModelSelect');
  appendElement('select', 'composerEffortSelect');
  const runModeSlot = appendElement('div', 'composerRunModeSlot');
  // `switcher`: the real run-mode chip + Ask | Auto | Plan segments in the slot.
  if (!options.switcher) appendElement('button', 'composerRunModeChip', runModeSlot);
  appendElement('div', 'composerModeChipsAnnouncer');
  const previous = {
    document: globalThis.document,
    rendererIdeConfirmDialog: globalThis.rendererIdeConfirmDialog,
    inventoryActionButton: globalThis.inventoryActionButton,
    inventoryHelpOverlay: globalThis.inventoryHelpOverlay,
    rendererHealthPillController: globalThis.rendererHealthPillController,
    rendererRunModeControl: globalThis.rendererRunModeControl,
  };
  globalThis.document = dom.window.document;
  globalThis.inventoryActionButton = function actionButton() { return ''; };
  globalThis.inventoryHelpOverlay = { createHelpOverlay() {} };

  const calls = { confirm: [], logs: [], persistence: [], toasts: [], refreshes: 0 };
  const prefs = { runMode: options.runMode || 'ask' };
  const switcher = options.switcher
    ? createRunModeSwitcherRenderer({ slot: runModeSlot, getRunMode: () => prefs.runMode })
    : null;
  const confirmation = options.confirmation || (() => Promise.resolve(true));
  if (options.withDialog !== false) {
    globalThis.rendererIdeConfirmDialog = {
      createIdeConfirmDialog(config) {
        calls.dialogConfig = config;
        return {
          confirm(configure) {
            calls.confirm.push(configure);
            return confirmation();
          },
        };
      },
    };
  } else {
    delete globalThis.rendererIdeConfirmDialog;
  }
  globalThis.rendererHealthPillController = {
    refreshRunModeFacet() { calls.refreshes += 1; },
  };

  const bindings = createSettingsEventBindings({
    getAutoRunWarningStorage: () => options.storage,
    toastViewport: doc.getElementById('toastViewport'),
    composerModelSelect: doc.getElementById('composerModelSelect'),
    composerEffortSelect: doc.getElementById('composerEffortSelect'),
    state: {
      ui: {}, models: {}, modelList: {}, unattendedGuardMinutes: options.unattendedGuardMinutes ?? 0,
      currentSessionId: options.currentSessionId || '', sessions: options.sessions || [],
    },
    TOAST_SOURCE: { memory: 'memory', composerAction: 'composer' },
    ACTIVITY_SCOPE: {
      composerPreferredModel: 'model',
      composerReasoningEffort: 'effort',
      composerRunMode: 'run-mode',
    },
    dismissToast() {},
    appendClientLog(level, event, details) { calls.logs.push({ level, event, details }); },
    showShellErrorToast() {},
    showToastMessage(message) { calls.toasts.push(message); },
    toErrorMessage(error) { return String(error); },
    getRuntimePreferenceSnapshot() { return { ...prefs }; },
    runRuntimePreferenceActivity(activity) {
      calls.persistence.push(activity);
      Object.assign(prefs, activity.patch);
      return Promise.resolve({});
    },
    getCurrentRuntimePreferences() { return prefs; },
    showComposerActionError() {},
    closeComposerPopover() {},
    openComposerPopover() {},
    setActiveView() {},
    setComposerStatusNotice() {},
    clearComposerStatusNotice() {},
    toastActionHandlers: new Map(),
  });
  bindings.bindSettingsEvents((element, type, handler) => {
    element?.addEventListener?.(type, handler);
  }, {});

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    switcher?.destroy();
    bindings.dispose();
    restoreGlobal('document', previous.document);
    restoreGlobal('rendererIdeConfirmDialog', previous.rendererIdeConfirmDialog);
    restoreGlobal('inventoryActionButton', previous.inventoryActionButton);
    restoreGlobal('inventoryHelpOverlay', previous.inventoryHelpOverlay);
    restoreGlobal('rendererHealthPillController', previous.rendererHealthPillController);
    restoreGlobal('rendererRunModeControl', previous.rendererRunModeControl);
    dom.window.close();
  }
  t.after(cleanup);
  return { bindings, calls, cleanup, prefs, doc, runModeSlot, switcher, control: globalThis.rendererRunModeControl };
}

module.exports = { createRunModeHarness, restoreGlobal };
