const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

test('task-session creation forwards linkedTaskId only when supplied', async (t) => {
  const dom = new JSDOM('<!doctype html><html><body><textarea></textarea></body></html>');
  const previous = {
    window: global.window,
    document: global.document,
    composer: global.rendererComposerSessionState,
    lifecycle: global.rendererSessionLifecycleUtils,
    requestAnimationFrame: global.requestAnimationFrame,
  };
  global.window = dom.window;
  global.document = dom.window.document;
  global.requestAnimationFrame = (callback) => callback();
  global.rendererComposerSessionState = require('../renderer/chat/renderer-composer-session-state');
  global.rendererSessionLifecycleUtils = require('../renderer/shell/renderer-session-lifecycle-utils');

  const creates = [];
  const summaries = [];
  dom.window.jennyShell = {
    sessions: {
      create: async (payload) => {
        creates.push(payload);
        const summary = {
          id: `session-${creates.length}`,
          title: payload.title,
          session_type: 'chat',
          composer_draft: payload.initialPrompt || '',
          context_preferences: {},
        };
        summaries.push(summary);
        return { data: summary };
      },
      list: async () => ({ data: summaries }),
      getMessages: async () => ({ data: [], turn_events: [] }),
    },
  };
  const state = {
    ui: { activeView: 'home' }, backend: { phase: 'starting' }, auth: { authenticated: true },
    logs: [], sessions: [], messagesBySession: new Map(), turnEventsBySession: new Map(),
    sessionMessageAccessOrder: new Map(), interactiveDraftsBySession: new Map(),
    queuedSendBySession: new Map(), pendingStreams: new Map(), streamThinkingStatusByStream: new Map(),
    toolCallsByStream: new Map(), pendingToolApprovals: new Map(), attachments: { queued: [] },
    runtimeDraft: {}, features: { featureFlags: {} },
  };
  delete require.cache[require.resolve('../renderer/shell/renderer-lifecycle-utils')];
  const { createLifecycleController } = require('../renderer/shell/renderer-lifecycle-utils');
  const controller = createLifecycleController({
    state,
    constants: { INTERACTIVE_SEQUENCE_IDLE: 'idle', TOAST_SOURCE: {} },
    dom: { chatInput: dom.window.document.querySelector('textarea') },
    callbacks: { normalizeReasoningEffort: (value) => value, renderAll() {} },
    controllers: { thinkingController: { resumeAutoScroll() {} } },
  });
  t.after(() => {
    controller.disposeLifecycleController();
    global.window = previous.window;
    global.document = previous.document;
    global.rendererComposerSessionState = previous.composer;
    global.rendererSessionLifecycleUtils = previous.lifecycle;
    global.requestAnimationFrame = previous.requestAnimationFrame;
    dom.window.close();
  });

  await dom.window.rendererTaskSessionActions.start({
    title: 'Ship task', initialPrompt: 'Task brief', linkedTaskId: 'task-123',
  });
  await dom.window.rendererTaskSessionActions.start({ title: 'Unlinked chat', initialPrompt: 'Draft' });

  assert.equal(creates[0].linkedTaskId, 'task-123');
  assert.equal(Object.hasOwn(creates[1], 'linkedTaskId'), false);
});
