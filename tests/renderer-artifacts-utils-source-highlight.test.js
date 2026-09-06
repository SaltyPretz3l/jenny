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
