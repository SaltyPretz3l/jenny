'use strict';

// Task-session creation (WO-10c) seeds the new session's composer draft. The
// create awaits a sessions refresh; if the user opens another session while
// it is in flight, the continuation must not restore the seeded draft over
// that session's live composer and attachments (Astra round 2, R15).
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

test('task-session create never restores its draft over a session the user switched to during the refresh', async (t) => {
  const dom = new JSDOM('<!doctype html><html><body><textarea></textarea></body></html>');
  const previous = { window: global.window, document: global.document,
    composer: global.rendererComposerSessionState, lifecycle: global.rendererSessionLifecycleUtils,
    requestAnimationFrame: global.requestAnimationFrame };
  global.window = dom.window;
  global.document = dom.window.document;
  global.requestAnimationFrame = (callback) => callback();
  global.rendererComposerSessionState = require('../renderer/chat/renderer-composer-session-state');
  global.rendererSessionLifecycleUtils = require('../renderer/shell/renderer-session-lifecycle-utils');
  const brief = 'Ship WO-10c\n\nKeep the brief unsent.';
  const created = { id: 'session-task', title: 'Ship WO-10c', session_type: 'chat', composer_draft: brief, context_preferences: {} };
  const other = { id: 'session-b', title: 'B', session_type: 'chat', composer_draft: '', context_preferences: {} };
  dom.window.jennyShell = { sessions: {
    create: async () => ({ data: created }),
    list: async () => ({ data: [created, other] }),
    getMessages: async () => ({ data: [], turn_events: [] }),
  }, chat: { startStream: async () => { throw new Error('draft must not send'); } } };
  const textarea = dom.window.document.querySelector('textarea');
  const state = { ui: { activeView: 'home' }, backend: { phase: 'starting' }, auth: { authenticated: true }, logs: [], sessions: [],
    messagesBySession: new Map(), turnEventsBySession: new Map(), sessionMessageAccessOrder: new Map(),
    interactiveDraftsBySession: new Map(), queuedSendBySession: new Map(), pendingStreams: new Map(),
    streamThinkingStatusByStream: new Map(), toolCallsByStream: new Map(), pendingToolApprovals: new Map(), attachments: { queued: [] },
    runtimeDraft: {}, features: { featureFlags: {} } };
  delete require.cache[require.resolve('../renderer/shell/renderer-lifecycle-utils')];
  const { createLifecycleController } = require('../renderer/shell/renderer-lifecycle-utils');
  const controller = createLifecycleController({ state, constants: { INTERACTIVE_SEQUENCE_IDLE: 'idle', TOAST_SOURCE: {} },
    dom: { chatInput: textarea }, callbacks: {
      normalizeReasoningEffort: (value) => value,
      renderAll() {
        // The refresh's own render is where a navigation lands in this
        // harness: the user opened B and typed while the create was in flight.
        if (state.currentSessionId === 'session-task') {
          state.currentSessionId = 'session-b';
          textarea.value = 'B draft in progress';
        }
      },
    }, controllers: { thinkingController: { resumeAutoScroll() {} } } });
  t.after(() => { controller.disposeLifecycleController(); global.window = previous.window;
    global.document = previous.document; global.rendererComposerSessionState = previous.composer;
    global.rendererSessionLifecycleUtils = previous.lifecycle;
    global.requestAnimationFrame = previous.requestAnimationFrame; dom.window.close(); });

  await dom.window.rendererTaskSessionActions.start({ title: 'Ship WO-10c', initialPrompt: brief });
  assert.equal(state.currentSessionId, 'session-b');
  assert.equal(textarea.value, 'B draft in progress', 'B keeps its live composer');
  assert.equal(state.ui.activeView, 'home', 'no forced navigation into the new session');
  assert.equal(state.queuedSendBySession.size, 0);
});
