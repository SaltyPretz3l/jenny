'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSelectionController, isPaneSelecting } = require('../renderer/chat/renderer-chat-selection-utils');

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
    ...(overrides.paneId !== undefined ? { paneId: overrides.paneId } : {}),
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
  assert.equal(state.ui.selectionModePaneId, null);
});

test('enterSelectMode makes pane 0 the selection owner and emits log + render', () => {
  const { controller, state, renderCalls, logCalls } = makeDeps();
  const changed = controller.enterSelectMode();
  assert.equal(changed, true);
  assert.equal(state.ui.selectionModePaneId, 0);
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
  assert.equal(state.ui.selectionModePaneId, null);
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

test('dispose() removes the keydown listener and releases the mode it owns', () => {
  const fakeDoc = makeFakeDocument();
  const { controller, state } = makeDeps({ document: fakeDoc });
  controller.attach();
  controller.enterSelectMode();
  controller.dispose();
  assert.equal(state.ui.selectionModePaneId, null);
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
  assert.equal(state.ui.selectionModePaneId, null);
  assert.ok(state.ui.selectedMessageIdsBySession instanceof Map);
});

test('createSelectionController throws when state is missing', () => {
  assert.throws(
    () => createSelectionController({ document: makeFakeDocument() }),
    /requires `state`/,
  );
});

/* ── split view W3-1: one owner, per pane ── */

function makeTwoPanes() {
  const state = makeState();
  const doc = makeFakeDocument();
  const pane0 = makeDeps({ state, document: doc, sessionId: 'sess-A', paneId: 0 });
  const pane1 = makeDeps({ state, document: doc, sessionId: 'sess-B', paneId: 1 });
  const barSyncs = { 0: 0, 1: 0 };
  pane0.controller.syncActionBar = () => { barSyncs[0] += 1; };
  pane1.controller.syncActionBar = () => { barSyncs[1] += 1; };
  return { state, doc, pane0, pane1, barSyncs };
}

test('pane 1 entering selection mode owns it; pane 0 does not select', () => {
  const { state, pane0, pane1, barSyncs } = makeTwoPanes();
  assert.equal(pane1.controller.enterSelectMode(), true);
  assert.equal(state.ui.selectionModePaneId, 1);
  assert.equal(pane1.controller.isSelectMode(), true);
  assert.equal(pane0.controller.isSelectMode(), false);
  assert.equal(isPaneSelecting(state, 1), true);
  assert.equal(isPaneSelecting(state, 0), false);
  assert.equal(barSyncs[1], 1, 'the owner mounts its bar');
  assert.equal(barSyncs[0], 0, 'pane 0 mounts nothing');
  assert.equal(pane0.controller.exitSelectMode(), false, 'a non-owner cannot exit another pane\'s mode');
  assert.equal(state.ui.selectionModePaneId, 1);
});

test('a stream start or session switch in pane 0 leaves pane 1 selecting; pane 1\'s own exits', () => {
  const { state, pane0, pane1 } = makeTwoPanes();
  pane1.controller.enterSelectMode();
  pane1.controller.toggleMessage('m-2');
  pane0.controller.onStreamStarted({ sessionId: 'sess-A' });
  pane0.controller.onSessionSwitch('sess-C');
  assert.equal(state.ui.selectionModePaneId, 1, 'pane 0\'s events do not touch pane 1\'s mode');
  assert.deepEqual(pane1.controller.getSelectedMessageIds(), ['m-2']);
  pane1.controller.onStreamStarted({ sessionId: 'sess-B' });
  assert.equal(state.ui.selectionModePaneId, null);
  pane1.controller.enterSelectMode();
  pane1.controller.onSessionSwitch('sess-D');
  assert.equal(state.ui.selectionModePaneId, null);
});

test('Esc exits only the owning pane (both panes listen on the document)', () => {
  const { state, doc, pane0, pane1 } = makeTwoPanes();
  pane0.controller.attach();
  pane1.controller.attach();
  pane1.controller.enterSelectMode();
  let prevented = 0;
  doc.fire('keydown', { key: 'Escape', target: { tagName: 'BODY' }, preventDefault() { prevented += 1; }, stopPropagation() {} });
  assert.equal(state.ui.selectionModePaneId, null);
  assert.equal(prevented, 1, 'only the owner handled the key');
  assert.equal(pane0.logCalls.filter((entry) => entry.name === 'chat.selection_mode_exited').length, 0);
  assert.equal(pane1.logCalls.filter((entry) => entry.name === 'chat.selection_mode_exited').length, 1);
});

test('pane 0 entering while pane 1 owns takes the mode, drops pane 1\'s selection and re-syncs its bar', () => {
  const { state, pane0, pane1, barSyncs } = makeTwoPanes();
  pane1.controller.enterSelectMode();
  pane1.controller.toggleMessage('m-2');
  const pane1SyncsBefore = barSyncs[1];
  assert.equal(pane0.controller.enterSelectMode(), true);
  assert.equal(state.ui.selectionModePaneId, 0);
  assert.equal(pane1.controller.isSelectMode(), false);
  assert.deepEqual(pane1.controller.getSelectedMessageIds(), [], 'one owner, one selection');
  assert.ok(barSyncs[1] > pane1SyncsBefore, 'pane 1 re-syncs (unmounts) its bar');
  assert.ok(barSyncs[0] >= 1, 'pane 0 mounts its bar');
});

test('disposing the owning pane exits its mode; disposing a non-owner leaves the owner selecting', () => {
  const first = makeTwoPanes();
  first.pane1.controller.enterSelectMode();
  first.pane0.controller.dispose();
  assert.equal(first.state.ui.selectionModePaneId, 1, 'pane 0\'s dispose leaves pane 1 selecting');

  const second = makeTwoPanes();
  second.pane1.controller.enterSelectMode();
  const pane0SyncsBefore = second.barSyncs[0];
  second.pane1.controller.dispose();
  assert.equal(second.state.ui.selectionModePaneId, null, 'closing pane 1 while selecting exits the mode');
  assert.ok(second.barSyncs[0] > pane0SyncsBefore, 'the surviving pane re-syncs its bar (stays unmounted)');
});

test('isPaneSelecting: a missing or foreign owner is off; a bag without a pane id is pane 0', () => {
  assert.equal(isPaneSelecting({}, 0), false);
  assert.equal(isPaneSelecting({ ui: { selectionModePaneId: null } }, 0), false);
  assert.equal(isPaneSelecting({ ui: { selectionModePaneId: 0 } }, undefined), true);
  assert.equal(isPaneSelecting({ ui: { selectionModePaneId: true } }, 0), false, 'the retired boolean is not an owner');
});

/* ── split view W3-1: Shift+Click entry (the help overlay's promise) ── */

const { JSDOM } = require('jsdom');

function makeTimelineDom() {
  const dom = new JSDOM(`<div id="t0">
      <article data-message-id="m-1"><p id="m1-text">first</p><a id="m1-link" href="#x">link</a></article>
      <article data-message-id="m-2"><p>reply</p><button id="m2-button" type="button">Copy</button></article>
      <article data-message-id="m-3"><p id="m3-text">second</p></article>
      <article data-message-id="m-4"><p id="m4-text">skipped kind</p></article>
      <article data-message-id="m-5"><p id="m5-text">last</p></article>
    </div>
    <div id="t1"><article data-message-id="m-1"><p id="p1-text">pane one</p></article></div>`);
  return dom;
}

function shiftClick(window, target, { shiftKey = true } = {}) {
  const down = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, shiftKey, button: 0 });
  target.dispatchEvent(down);
  const click = new window.MouseEvent('click', { bubbles: true, cancelable: true, shiftKey, button: 0 });
  target.dispatchEvent(click);
  return { down, click };
}

test('Shift+Click on a message enters this pane\'s mode with it selected; the mousedown starts no text selection', () => {
  const dom = makeTimelineDom();
  const { window } = dom;
  const doc = window.document;
  const { controller, state } = makeDeps({ document: doc });
  controller.attach(null, undefined, doc.getElementById('t0'));
  const { down, click } = shiftClick(window, doc.getElementById('m3-text'));
  assert.equal(down.defaultPrevented, true, 'the first Shift+Click does not start a native text selection');
  assert.equal(click.defaultPrevented, true);
  assert.equal(state.ui.selectionModePaneId, 0);
  assert.deepEqual(controller.getSelectedMessageIds(), ['m-3']);
});

test('a second Shift+Click extends the range from the last clicked message', () => {
  const dom = makeTimelineDom();
  const { window } = dom;
  const doc = window.document;
  const { controller } = makeDeps({ document: doc });
  controller.attach(null, undefined, doc.getElementById('t0'));
  shiftClick(window, doc.getElementById('m1-text'));
  shiftClick(window, doc.getElementById('m3-text'));
  assert.deepEqual(controller.getSelectedMessageIds().sort(), ['m-1', 'm-2', 'm-3']);
  shiftClick(window, doc.getElementById('m5-text'));
  assert.deepEqual(controller.getSelectedMessageIds().sort(), ['m-1', 'm-2', 'm-3', 'm-5'], 'm-3 -> m-5, skipping the question batch');
});

test('Shift+Click while text is selected extends the text selection natively; once selecting it extends the range', () => {
  const dom = makeTimelineDom();
  const { window } = dom;
  const doc = window.document;
  const { controller, state } = makeDeps({ document: doc });
  controller.attach(null, undefined, doc.getElementById('t0'));
  const range = doc.createRange();
  range.selectNodeContents(doc.getElementById('m1-text'));
  window.getSelection().addRange(range);
  const { down, click } = shiftClick(window, doc.getElementById('m3-text'));
  assert.equal(down.defaultPrevented, false, 'the native selection extension is kept');
  assert.equal(click.defaultPrevented, false);
  assert.equal(state.ui.selectionModePaneId, null, 'no selection mode from a text-selection gesture');
  controller.enterSelectMode();
  shiftClick(window, doc.getElementById('m3-text'));
  assert.deepEqual(controller.getSelectedMessageIds(), ['m-3'], 'in the mode a Shift+Click selects even with text selected');
});

test('Shift+Click on a link, a button, a skipped kind or without Shift does not enter', () => {
  const dom = makeTimelineDom();
  const { window } = dom;
  const doc = window.document;
  const { controller, state } = makeDeps({ document: doc });
  controller.attach(null, undefined, doc.getElementById('t0'));
  for (const id of ['m1-link', 'm2-button', 'm4-text']) {
    const { down } = shiftClick(window, doc.getElementById(id));
    assert.equal(down.defaultPrevented, false, `${id}: the control keeps its mousedown`);
    assert.equal(state.ui.selectionModePaneId, null, `${id}: no selection mode`);
  }
  const plain = shiftClick(window, doc.getElementById('m3-text'), { shiftKey: false });
  assert.equal(plain.down.defaultPrevented, false);
  assert.equal(state.ui.selectionModePaneId, null, 'a plain click is not a selection gesture');
});

test('Shift+Click selects in the clicked pane only; Esc exits it; dispose unbinds the timeline', () => {
  const dom = makeTimelineDom();
  const { window } = dom;
  const doc = window.document;
  const state = makeState();
  const pane0 = makeDeps({ state, document: doc, paneId: 0 });
  const pane1 = makeDeps({ state, document: doc, sessionId: 'sess-B', paneId: 1 });
  pane0.controller.attach(null, undefined, doc.getElementById('t0'));
  pane1.controller.attach(null, undefined, doc.getElementById('t1'));
  shiftClick(window, doc.getElementById('p1-text'));
  assert.equal(state.ui.selectionModePaneId, 1, 'pane 1 owns the mode');
  assert.deepEqual(pane1.controller.getSelectedMessageIds(), ['m-1']);
  assert.deepEqual(pane0.controller.getSelectedMessageIds(), [], 'pane 0 selected nothing');
  doc.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(state.ui.selectionModePaneId, null, 'Esc exits');
  pane1.controller.dispose();
  shiftClick(window, doc.getElementById('p1-text'));
  assert.equal(state.ui.selectionModePaneId, null, 'a disposed pane binds nothing');
});
