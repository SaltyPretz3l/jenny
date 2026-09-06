'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSelectionController } = require('../renderer/chat/renderer-chat-selection-utils');

function makeState() {
  return { ui: {} };
}

function makeDeps(overrides = {}) {
  const state = overrides.state || makeState();
  const sessionId = overrides.sessionId || 'sess-A';
  const messages = overrides.messages || [
    { id: 'm-1', role: 'user', content: 'first' },
    { id: 'm-2', role: 'assistant', content: 'reply' },
    { id: 'm-3', role: 'user', content: 'second' },
    { id: 'm-4', role: 'assistant', kind: 'question_batch', content: 'should-skip' },
    { id: 'm-5', role: 'assistant', content: 'last' },
  ];
  const renderCalls = [];
  const logCalls = [];
  const controller = createSelectionController({
    state,
    document: overrides.document || makeFakeDocument(),
    getCurrentSessionMessages: () => messages,
    getCurrentSessionId: () => sessionId,
    renderAll: () => renderCalls.push(true),
    appendClientLog: (level, name, payload) => logCalls.push({ level, name, payload }),
  });
  return { controller, state, sessionId, messages, renderCalls, logCalls };
}

function makeFakeDocument() {
  const listeners = new Map();
  return {
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      const set = listeners.get(type);
      if (set) set.delete(handler);
    },
    fire(type, event) {
      const set = listeners.get(type);
      if (!set) return;
      for (const handler of set) handler(event);
    },
  };
}

/* ── enter / exit ── */

test('isSelectMode reports false on a fresh state', () => {
  const { controller, state } = makeDeps();
  assert.equal(controller.isSelectMode(), false);
  assert.equal(state.ui.selectionMode, false);
});

test('enterSelectMode flips state.ui.selectionMode and emits log + render', () => {
  const { controller, state, renderCalls, logCalls } = makeDeps();
  const changed = controller.enterSelectMode();
  assert.equal(changed, true);
  assert.equal(state.ui.selectionMode, true);
  assert.equal(controller.isSelectMode(), true);
  assert.equal(renderCalls.length, 1);
  assert.ok(logCalls.some((entry) => entry.name === 'chat.selection_mode_entered'));
});

test('enterSelectMode is idempotent on second call', () => {
  const { controller, renderCalls } = makeDeps();
  controller.enterSelectMode();
  const second = controller.enterSelectMode();
  assert.equal(second, false);
  assert.equal(renderCalls.length, 1);
});

test('exitSelectMode clears all per-session sets and anchors', () => {
  const { controller, state } = makeDeps();
  controller.enterSelectMode();
  controller.toggleMessage('m-1');
  controller.toggleMessage('m-3');
  controller.exitSelectMode();
  assert.equal(state.ui.selectionMode, false);
  assert.equal(state.ui.selectedMessageIdsBySession.size, 0);
  assert.equal(state.ui.selectionAnchorBySession.size, 0);
});

/* ── toggle / range / selectAll ── */

test('toggleMessage adds the id and sets the anchor on first add', () => {
  const { controller, sessionId, state } = makeDeps();
  controller.enterSelectMode();
  const becameSelected = controller.toggleMessage('m-2');
  assert.equal(becameSelected, true);
  const set = state.ui.selectedMessageIdsBySession.get(sessionId);
  assert.ok(set instanceof Set);
  assert.ok(set.has('m-2'));
  assert.equal(state.ui.selectionAnchorBySession.get(sessionId), 'm-2');
});

test('toggleMessage removes the id on a second toggle and clears anchor if matching', () => {
  const { controller, sessionId, state } = makeDeps();
  controller.enterSelectMode();
  controller.toggleMessage('m-2');
  controller.toggleMessage('m-2');
  assert.equal(state.ui.selectedMessageIdsBySession.get(sessionId).size, 0);
  assert.equal(state.ui.selectionAnchorBySession.has(sessionId), false);
});

test('selectRange adds inclusive slice from anchor to target', () => {
  const { controller } = makeDeps();
  controller.enterSelectMode();
  controller.toggleMessage('m-1'); // anchor
  controller.selectRange('m-3');
  const ids = controller.getSelectedMessageIds();
  assert.ok(ids.includes('m-1'));
  assert.ok(ids.includes('m-2'));
  assert.ok(ids.includes('m-3'));
  // m-4 is question_batch (skipped); not added.
  assert.equal(ids.includes('m-4'), false);
});

test('selectRange supports backwards selection (target before anchor)', () => {
  const { controller } = makeDeps();
  controller.enterSelectMode();
  controller.toggleMessage('m-3'); // anchor
  controller.selectRange('m-1');
  const ids = controller.getSelectedMessageIds();
  assert.ok(ids.includes('m-1'));
  assert.ok(ids.includes('m-2'));
  assert.ok(ids.includes('m-3'));
});

test('selectRange with no anchor selects only the target', () => {
  const { controller, sessionId, state } = makeDeps();
  controller.enterSelectMode();
  controller.selectRange('m-2');
  const ids = controller.getSelectedMessageIds();
  assert.deepEqual(ids, ['m-2']);
  assert.equal(state.ui.selectionAnchorBySession.get(sessionId), 'm-2');
});

test('selectAll adds every selectable id and skips question_batch', () => {
  const { controller } = makeDeps();
  controller.enterSelectMode();
  const added = controller.selectAll();
  assert.equal(added, 4);
  const ids = controller.getSelectedMessageIds().sort();
  assert.deepEqual(ids, ['m-1', 'm-2', 'm-3', 'm-5']);
});

test('selectAll is idempotent after a full selection', () => {
  const { controller } = makeDeps();
  controller.enterSelectMode();
  controller.selectAll();
  const addedAgain = controller.selectAll();
  assert.equal(addedAgain, 0);
});

/* ── per-session isolation ── */

test('Selection state isolates per session id', () => {
  const state = makeState();
  let sessionId = 'sess-A';
  const messages = {
    'sess-A': [{ id: 'a-1', role: 'user' }, { id: 'a-2', role: 'assistant' }],
    'sess-B': [{ id: 'b-1', role: 'user' }, { id: 'b-2', role: 'assistant' }],
  };
  const controller = createSelectionController({
    state,
    document: makeFakeDocument(),
    getCurrentSessionMessages: () => messages[sessionId] || [],
    getCurrentSessionId: () => sessionId,
    renderAll: () => {},
    appendClientLog: () => {},
  });
  controller.enterSelectMode();
  controller.toggleMessage('a-1');
  sessionId = 'sess-B';
  controller.toggleMessage('b-1');
  sessionId = 'sess-A';
  const idsA = controller.getSelectedMessageIds();
  sessionId = 'sess-B';
  const idsB = controller.getSelectedMessageIds();
  assert.deepEqual(idsA.sort(), ['a-1']);
  assert.deepEqual(idsB.sort(), ['b-1']);
});

test('onSessionSwitch auto-exits selection mode', () => {
  const { controller } = makeDeps();
  controller.enterSelectMode();
  controller.toggleMessage('m-1');
  controller.onSessionSwitch('sess-B');
  assert.equal(controller.isSelectMode(), false);
});

test('onStreamStarted auto-exits selection mode', () => {
  const { controller, state } = makeDeps();
  controller.enterSelectMode();
  controller.toggleMessage('m-2');
  controller.onStreamStarted({ sessionId: 'sess-A' });
  assert.equal(controller.isSelectMode(), false);
  assert.equal(state.ui.selectedMessageIdsBySession.size, 0);
});

/* ── Esc / attach / dispose ── */

test('attach() registers a document keydown listener that exits on Escape', () => {
  const fakeDoc = makeFakeDocument();
  const { controller } = makeDeps({ document: fakeDoc });
  controller.attach();
  controller.enterSelectMode();
  let prevented = false;
  fakeDoc.fire('keydown', {
    key: 'Escape',
    target: { tagName: 'BODY' },
    preventDefault() { prevented = true; },
    stopPropagation() {},
  });
  assert.equal(prevented, true);
  assert.equal(controller.isSelectMode(), false);
});

test('Esc inside a textarea does not exit selection mode', () => {
  const fakeDoc = makeFakeDocument();
  const { controller } = makeDeps({ document: fakeDoc });
  controller.attach();
  controller.enterSelectMode();
  fakeDoc.fire('keydown', {
    key: 'Escape',
    target: { tagName: 'TEXTAREA' },
    preventDefault() {},
    stopPropagation() {},
  });
  assert.equal(controller.isSelectMode(), true);
});

test('dispose() removes the keydown listener and flips selectionMode false', () => {
  const fakeDoc = makeFakeDocument();
  const { controller, state } = makeDeps({ document: fakeDoc });
  controller.attach();
  controller.enterSelectMode();
  controller.dispose();
  assert.equal(state.ui.selectionMode, false);
  // Firing Esc after dispose should be a no-op.
  fakeDoc.fire('keydown', { key: 'Escape', target: { tagName: 'BODY' }, preventDefault() {}, stopPropagation() {} });
  assert.equal(controller.isSelectMode(), false);
});

test('Controller defends against missing state.ui', () => {
  const state = {};
  const controller = createSelectionController({
    state,
    document: makeFakeDocument(),
    getCurrentSessionMessages: () => [],
    getCurrentSessionId: () => 'sess',
    renderAll: () => {},
    appendClientLog: () => {},
  });
  assert.equal(controller.isSelectMode(), false);
  assert.equal(state.ui.selectionMode, false);
  assert.ok(state.ui.selectedMessageIdsBySession instanceof Map);
});

test('createSelectionController throws when state is missing', () => {
  assert.throws(
    () => createSelectionController({ document: makeFakeDocument() }),
    /requires `state`/,
  );
});
