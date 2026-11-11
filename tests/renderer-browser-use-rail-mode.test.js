'use strict';

// The `browser` mode in the shared artifact review rail (row 114): it opens without taking the
// keyboard when asked to, belongs to one chat, and is never restored after a restart.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const prefsUtils = require('../renderer/features/renderer-artifact-review-prefs');
const { createArtifactReviewRail } = require('../renderer/features/renderer-artifact-review-rail');
const chromeRender = require('../renderer/features/renderer-artifact-panel-chrome-render');

function setup(t) {
  const dom = new JSDOM('<!doctype html><body><button id="composer">c</button><aside id="artifactReviewPanel"><span id="artifactReviewDetailTitle" tabindex="-1">t</span></aside></body>');
  const store = {};
  const previous = globalThis.window;
  globalThis.window = {
    innerWidth: 2000, localStorage: { getItem: (key) => (key in store ? store[key] : null), setItem: (key, value) => { store[key] = String(value); } },
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
    dom.window.close();
  });
  const doc = dom.window.document;
  const state = {
    currentSessionId: 's1', ui: { activeView: 'chat', artifactReview: {} },
    artifacts: { autoOpenedSessionIds: [], deletedArtifactIds: [] }, messagesBySession: new Map(), features: { featureFlags: {} },
  };
  const rail = createArtifactReviewRail({
    state, dom: { artifactReviewPanel: doc.getElementById('artifactReviewPanel') },
    callbacks: {
      getActiveSession: () => ({ id: state.currentSessionId }), setActiveView() {}, updateComposerSafeOffset() {}, renderAll() {}, appendClientLog() {},
    },
  });
  return { doc, state, rail, store };
}

test('browser is a real mode that is never written down, so a restart cannot reopen it', () => {
  assert.equal(prefsUtils.normalizeArtifactReviewMode('browser'), 'browser');
  const store = {};
  const windowRef = { localStorage: { setItem: (key, value) => { store[key] = value; } } };
  prefsUtils.saveArtifactReviewPreferences(windowRef, 'key', { mode: 'browser', enabled: false });
  assert.equal(Object.hasOwn(JSON.parse(store.key), 'mode'), false);
});

test('an automatic open leaves the keyboard where it is, and an asked-for open takes it', (t) => {
  const { doc, rail } = setup(t);
  const composer = doc.getElementById('composer');
  composer.focus();
  assert.equal(rail.openArtifactRail('browser', { focus: false }), 'browser');
  assert.equal(doc.activeElement, composer);
  rail.openArtifactRail('browser');
  assert.equal(doc.activeElement, doc.getElementById('artifactReviewDetailTitle'));
});

test('switching chats closes the column and stands the mode down', (t) => {
  const { state, rail } = setup(t);
  rail.beginRender();
  rail.openArtifactRail('browser', { focus: false });
  rail.beginRender();
  assert.equal(rail.getArtifactReviewState().mode, 'browser', 'the same chat keeps it');
  state.currentSessionId = 's2';
  rail.beginRender();
  const prefs = rail.getArtifactReviewState();
  assert.equal(prefs.mode, 'artifact');
  assert.equal(prefs.enabled, false);
});

test('the title carries the globe when one is given and nothing when not', () => {
  assert.match(chromeRender.buildTitleHtml({ title: 'shop.example', glyphHtml: '<svg id="g"></svg>' }), /artifact-panel-kind-glyph[^>]*><svg id="g">/u);
  assert.doesNotMatch(chromeRender.buildTitleHtml({ title: 'Tasks', glyphHtml: '' }), /artifact-panel-kind-glyph/u);
});
