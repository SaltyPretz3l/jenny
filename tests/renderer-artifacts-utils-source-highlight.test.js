'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createArtifactManager } = require('../renderer/features/renderer-artifacts-utils.js');

test('dispose clears a pending source highlight even when the manager was not bound', (t) => {
  const dom = new JSDOM('<body><main id="timeline"><article data-message-id="message-1"></article></main></body>');
  const previousWindow = globalThis.window;
  globalThis.window = dom.window;
  dom.window.requestAnimationFrame = (callback) => { callback(); return 1; };
  t.after(() => { globalThis.window = previousWindow; });

  const timeline = dom.window.document.getElementById('timeline');
  const source = timeline.querySelector('[data-message-id="message-1"]');
  const manager = createArtifactManager({
    state: {
      artifacts: {},
      ui: { artifactReview: { enabled: false, collapsed: false, mode: 'artifact' } },
      features: { featureFlags: {} },
    },
    dom: { chatTimeline: timeline },
    callbacks: {
      getActiveSession: () => null,
      setActiveView: () => {},
      scrollMessageIntoView: () => true,
      appendClientLog: () => {},
      updateComposerSafeOffset: () => {},
    },
  });

  manager.jumpToArtifactSource('message-1');
  assert.equal(source.classList.contains('artifact-source-highlight'), true);

  manager.dispose();

  assert.equal(source.classList.contains('artifact-source-highlight'), false);
});

// Split view: the panel's chat lives in pane 1 while pane 0's chat is focused.
// A jump that never finds its anchor rolls back the panel's chat, not pane 0's.
test('an anchor miss rolls back the row model of the panel\'s chat, not the focused one', async (t) => {
  const dom = new JSDOM('<body><main id="timeline"></main></body>');
  const previousWindow = globalThis.window;
  globalThis.window = dom.window;
  dom.window.requestAnimationFrame = (callback) => { callback(); return 1; };
  t.after(() => { globalThis.window = previousWindow; });
  const rolledBack = [];
  const manager = createArtifactManager({
    state: {
      currentSessionId: 'session-focused',
      artifacts: {},
      ui: { artifactReview: { enabled: false, collapsed: false, mode: 'artifact' } },
      features: { featureFlags: {} },
    },
    dom: { chatTimeline: dom.window.document.getElementById('timeline') },
    callbacks: {
      getActiveSession: () => null,
      setActiveView: () => {},
      scrollMessageIntoView: () => false,
      appendClientLog: () => {},
      updateComposerSafeOffset: () => {},
      getChatTimelineRowModelEnabled: () => true,
      rollbackChatTimelineRowModel: (sessionId) => { rolledBack.push(sessionId); return true; },
      sidePanel: { getSessionId: () => 'session-panel', getJumpTarget: () => null },
    },
  });
  t.after(() => manager.dispose());
  manager.jumpToArtifactSource('message-missing');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(rolledBack, ['session-panel']);
});
