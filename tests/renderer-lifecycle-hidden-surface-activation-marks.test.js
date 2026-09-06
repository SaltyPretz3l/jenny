'use strict';

/* UIUX-024: the shell's setActiveView() chokepoint (renderer-lifecycle-utils.js)
 * is the single place that already gates heavy renderIde/renderLogs/
 * renderSettings/renderArtifactsPanel work behind the active view. This
 * verifies the new companion telemetry: a one-shot __jennyStartupAudit mark
 * ('hidden-surface-first-activation') fires the first time each hidden
 * surface (ide/logs/settings/artifacts) is switched into, and never again on
 * repeat visits — making the real first-open cost of a deferred surface
 * measurable instead of invisible inside "534 scripts always loaded" noise. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

function buildController(t) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousRaf = global.requestAnimationFrame;
  const previousAudit = global.__jennyStartupAudit;

  global.window = dom.window;
  global.document = dom.window.document;
  global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  const marks = [];
  global.__jennyStartupAudit = {
    mark(name, details) { marks.push({ name, details }); },
  };

  t.after(() => {
    global.window = previousWindow;
    global.document = previousDocument;
    global.requestAnimationFrame = previousRaf;
    global.__jennyStartupAudit = previousAudit;
    dom.window.close();
  });

  const modulePath = require.resolve('../renderer/shell/renderer-lifecycle-utils');
  delete require.cache[modulePath];
  const { createLifecycleController } = require('../renderer/shell/renderer-lifecycle-utils');

  const el = () => dom.window.document.createElement('div');
  const state = {
    ui: { activeView: 'chat', activeSettingsSection: 'models', composerPopoverOpen: false, commandPopoverOpen: false },
    logs: [],
    memoryManager: {},
    personality: {},
  };

  const controller = createLifecycleController({
    state,
    constants: { SIDEBAR_STORAGE_KEY: 'k', APPEARANCE_STORAGE_KEY: 'k2', TOAST_SOURCE: {}, INTERACTIVE_SEQUENCE_IDLE: 'idle' },
    dom: {
      chatInput: el(),
      composerSettingsPopover: el(),
      composerSettingsButton: el(),
      composerTerminalShortcut: el(),
    },
    callbacks: { refreshSettingsSection: () => Promise.resolve(null) },
    controllers: {},
  });

  // The controller owns timers of its own; nothing tore it down, so this file
  // held the event loop past its last assertion. Registered here rather than in
  // the earlier t.after so it runs BEFORE the globals are put back.
  t.after(() => {
    try { controller.disposeLifecycleController?.(); } catch { /* already gone */ }
  });

  return { controller, marks };
}

test('switching into a hidden surface for the first time marks hidden-surface-first-activation exactly once', (t) => {
  const { controller, marks } = buildController(t);

  controller.setActiveView('ide');
  controller.setActiveView('chat');
  controller.setActiveView('ide'); // second visit: must not re-mark

  const ideMarks = marks.filter((m) => m.name === 'hidden-surface-first-activation' && m.details.view === 'ide');
  assert.equal(ideMarks.length, 1, 'the IDE first-activation mark must fire exactly once, not on every visit');
});

test('each hidden surface (ide/logs/settings) gets its own first-activation mark (artifacts view removed in W1-5)', (t) => {
  const { controller, marks } = buildController(t);

  controller.setActiveView('ide');
  controller.setActiveView('logs');
  controller.setActiveView('settings');
  controller.setActiveView('settings'); // repeat: must not re-mark

  const views = marks
    .filter((m) => m.name === 'hidden-surface-first-activation')
    .map((m) => m.details.view);

  assert.deepEqual(views.sort(), ['ide', 'logs', 'settings']);
});

test('the default Chat view never emits a hidden-surface-first-activation mark', (t) => {
  const { controller, marks } = buildController(t);

  controller.setActiveView('chat');
  controller.setActiveView('chat');

  const chatMarks = marks.filter((m) => m.name === 'hidden-surface-first-activation');
  assert.deepEqual(chatMarks, [], 'Chat is the always-on default surface, not a deferred one — it must never be marked');
});
