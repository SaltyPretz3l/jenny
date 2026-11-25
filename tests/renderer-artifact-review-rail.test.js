'use strict';

// The artifact-review rail state machine (renderer/features/renderer-artifact-review-rail.js),
// split out of the artifact manager on 2026-09-29 (review D-12): one storage
// key owned by the prefs module, the draft-to-real session rekey carrying the
// per-chat rail state, and the hosted layout (the room's right stack places the panel).

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const prefsUtils = require('../renderer/features/renderer-artifact-review-prefs');
const { createArtifactReviewRail } = require('../renderer/features/renderer-artifact-review-rail');
const artifactsUtils = require('../renderer/features/renderer-artifacts-utils');

function withWindowShim(t, store, innerWidth = 2000) {
  const previous = globalThis.window;
  globalThis.window = {
    innerWidth,
    localStorage: {
      getItem: (key) => (key in store ? store[key] : null),
      setItem: (key, value) => { store[key] = String(value); },
    },
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  });
}

function makeState(currentSessionId = 'draft-1') {
  return {
    currentSessionId,
    ui: { activeView: 'chat', artifactReview: {} },
    artifacts: { autoOpenedSessionIds: [], deletedArtifactIds: [] },
    messagesBySession: new Map(),
    features: { featureFlags: {} },
  };
}

function makeRail(state, extra = {}) {
  return createArtifactReviewRail({
    state,
    dom: extra.dom || {},
    callbacks: {
      getActiveSession: () => (state.currentSessionId ? { id: state.currentSessionId } : null),
      setActiveView: () => {}, updateComposerSafeOffset: () => {}, renderAll: () => {}, appendClientLog: () => {},
      ...(extra.callbacks || {}),
    },
  });
}

describe('one storage key', () => {
  test('the prefs module exports the key and the rail persists under it', (t) => {
    const store = {};
    withWindowShim(t, store);
    assert.equal(prefsUtils.ARTIFACT_REVIEW_STORAGE_KEY, 'jenny.artifactReview.v1');
    const rail = makeRail(makeState());
    rail.getArtifactReviewState().enabled = true;
    rail.saveArtifactReviewPreferences();
    assert.deepEqual(Object.keys(store), [prefsUtils.ARTIFACT_REVIEW_STORAGE_KEY]);
    assert.equal(JSON.parse(store[prefsUtils.ARTIFACT_REVIEW_STORAGE_KEY]).enabled, true);
  });
});

describe('draft-to-real session rekey', () => {
  test('the prefs helper moves Close to the new id', () => {
    const prefs = prefsUtils.normalizeArtifactReviewPreferences({});
    prefsUtils.recordArtifactReviewDismissed(prefs, 'other', true);
    prefsUtils.recordArtifactReviewDismissed(prefs, 'draft-1', true);
    prefsUtils.rekeyArtifactReviewSessionPreferences(prefs, 'draft-1', 'real-1');
    assert.deepEqual(prefs.dismissedForSession, { other: true, 'real-1': true });
    assert.equal(prefsUtils.rekeyArtifactReviewSessionPreferences(prefs, '', 'x'), prefs, 'no ids, no change');
  });

  test('the manager rekey carries the rail state and persists it', (t) => {
    const store = {};
    withWindowShim(t, store);
    const state = makeState('draft-1');
    const manager = artifactsUtils.createArtifactManager({ state, dom: {}, callbacks: {
      getActiveSession: () => ({ id: state.currentSessionId }), escapeHtml: (value) => String(value || ''),
      setActiveView: () => {}, appendClientLog: () => {}, updateComposerSafeOffset: () => {}, renderAll: () => {},
    } });
    t.after(() => manager.dispose());
    manager.openArtifactRail('artifact');
    manager.toggleArtifactReview(); // Close in the draft chat
    state.artifacts.autoOpenedSessionIds = ['elsewhere', 'draft-1'];
    manager.rekeySessionArtifacts('draft-1', 'real-1');
    state.currentSessionId = 'real-1';
    const review = state.ui.artifactReview;
    assert.deepEqual(review.dismissedForSession, { 'real-1': true }, 'the Close follows the chat');
    assert.deepEqual(state.artifacts.autoOpenedSessionIds, ['elsewhere', 'real-1'], 'and its spent presentation');
    assert.deepEqual(JSON.parse(store[prefsUtils.ARTIFACT_REVIEW_STORAGE_KEY]).dismissedForSession, { 'real-1': true });
  });

  test('a rekey is not a session switch: a file preview opened in the draft stays open', (t) => {
    withWindowShim(t, {});
    const state = makeState('draft-1');
    const rail = makeRail(state);
    rail.beginRender();
    rail.openArtifactRail('file_preview');
    rail.beginRender();
    rail.rekeySession('draft-1', 'real-1');
    state.currentSessionId = 'real-1';
    assert.equal(rail.beginRender(), true);
    assert.equal(state.ui.artifactReview.mode, 'file_preview');
  });
});

describe('hosted by the Chat right stack (row 190)', () => {
  test('the stack gets mode and open state with the panel; the rail sets no width, overlay or open column', (t) => {
    withWindowShim(t, {}, 600);
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<section id="chatView" class="chat-view"><aside id="artifactReviewPanel" class="artifact-review-panel hidden"></aside></section>');
    const doc = dom.window.document;
    const presented = [];
    const host = { present: (info) => { presented.push(info); return true; } };
    const state = makeState('s1');
    const rail = makeRail(state, {
      dom: { chatView: doc.getElementById('chatView'), artifactReviewPanel: doc.getElementById('artifactReviewPanel') },
      callbacks: { getLayoutHost: () => host },
    });
    rail.openArtifactRail('tasks', { focus: false });
    const last = presented[presented.length - 1];
    assert.equal(last.visible, true);
    assert.equal(last.mode, 'tasks');
    assert.equal(last.panel, doc.getElementById('artifactReviewPanel'), 'the stack places and styles the one panel');
    const panel = doc.getElementById('artifactReviewPanel');
    assert.equal(panel.style.width, '', 'no width: the workbench owns it');
  });

  test('row 190 Wave 4: in a room whose stack has the mode, an open stays in that room; any other mode goes to Chat', (t) => {
    withWindowShim(t, {}, 1400);
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<section id="chatView" class="chat-view"><aside id="artifactReviewPanel" class="artifact-review-panel hidden"></aside></section>');
    const doc = dom.window.document;
    const presented = [];
    const views = [];
    const host = { serves: (mode) => mode === 'artifact' || mode === 'tasks', present: (info) => { presented.push(info); return true; } };
    const state = makeState('s1');
    state.ui.activeView = 'ide';
    const rail = makeRail(state, {
      dom: { chatView: doc.getElementById('chatView'), artifactReviewPanel: doc.getElementById('artifactReviewPanel') },
      callbacks: { getLayoutHost: () => host, setActiveView: (view) => { views.push(view); state.ui.activeView = view; } },
    });
    rail.openArtifactRail('tasks', { focus: false });
    assert.deepEqual(views, [], 'the Workspace keeps the panel beside its work');
    assert.equal(presented[presented.length - 1].visible, true, 'eligible in the Workspace');
    rail.openArtifactRail('code_review', { focus: false });
    assert.deepEqual(views, ['chat'], 'a mode the room has no view for still opens in Chat');
  });
});

describe('without a room stack', () => {
  test('nothing is presented and the panel stays hidden; the open state is kept', (t) => {
    withWindowShim(t, {}, 1400);
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<section id="chatView" class="chat-view artifact-review-mode code-review-open"><aside id="artifactReviewPanel" class="artifact-review-panel"></aside></section>');
    const doc = dom.window.document;
    const panel = doc.getElementById('artifactReviewPanel');
    const state = makeState('s1');
    const rail = makeRail(state, { dom: { chatView: doc.getElementById('chatView'), artifactReviewPanel: panel }, callbacks: { getLayoutHost: () => null } });
    rail.openArtifactRail('tasks', { focus: false });
    assert.equal(panel.classList.contains('hidden'), true);
    assert.equal(doc.getElementById('chatView').className, 'chat-view', 'a stack that left the screen takes its classes with it');
    assert.equal(state.ui.artifactReview.enabled, true, 'the rail still records the open state for the stack that appears later');
    assert.equal(rail.isArtifactReviewVisible(), true);
  });
});

describe('an open no click asked for', () => {
  test('the Artifacts open takes focus on a click, and leaves it alone with focus: false', (t) => {
    withWindowShim(t, {});
    let focused = 0;
    const title = { focus: () => { focused += 1; } };
    const panel = { classList: { toggle: () => {} }, contains: () => false, querySelector: () => title };
    const rail = makeRail(makeState('s1'), { dom: { artifactReviewPanel: panel } });
    rail.toggleArtifactReview({ artifactsOnly: true, focus: false });
    assert.equal(rail.getArtifactReviewState().enabled, true);
    assert.equal(focused, 0, 'a workbench tab or a saved layout: the composer keeps the keyboard');
    rail.collapseArtifactReview();
    rail.toggleArtifactReview({ artifactsOnly: true });
    assert.equal(focused, 1);
  });
});
