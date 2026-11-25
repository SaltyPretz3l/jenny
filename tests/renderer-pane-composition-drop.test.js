'use strict';

/* Split view W2-1 -- drag-to-split on the pane composition (jsdom). The rig
 * lives in tests/helpers/pane-composition-rig.js; the lifecycle suite is
 * tests/renderer-pane-composition.test.js. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRig } = require('./helpers/pane-composition-rig');

/* ── Split view W2-1: drag-to-split. The composition owns the drop-zone
 * visuals: `setDropHover(side | null)` writes #chatView[data-pane-drop] and
 * nothing else (CSS draws the outline); `getDropTarget()` is what the rail's
 * tab drag hands its visual half to. ── */
function spyAttributeWrites(el) {
  const writes = [];
  const setAttribute = el.setAttribute.bind(el);
  const removeAttribute = el.removeAttribute.bind(el);
  el.setAttribute = (name, value) => { if (name === 'data-pane-drop') writes.push(['set', value]); return setAttribute(name, value); };
  el.removeAttribute = (name) => { if (name === 'data-pane-drop') writes.push(['remove']); return removeAttribute(name); };
  return writes;
}

test('setDropHover with one pane: one attribute on #chatView, written only on change, removed on null; the pane root is untouched', (t) => {
  const rig = createRig(t);
  const pane0 = rig.doc.getElementById('chatPane0');
  const pane0Attributes = Array.from(pane0.attributes).map((attr) => `${attr.name}=${attr.value}`);
  const writes = spyAttributeWrites(rig.chatView);

  rig.composition.setDropHover('left');
  assert.equal(rig.chatView.getAttribute('data-pane-drop'), 'left');
  rig.composition.setDropHover('left');
  rig.composition.setDropHover('right');
  assert.equal(rig.chatView.getAttribute('data-pane-drop'), 'right');
  rig.composition.setDropHover(null);
  assert.equal(rig.chatView.hasAttribute('data-pane-drop'), false);
  rig.composition.setDropHover(null);
  rig.composition.setDropHover('top');
  assert.equal(rig.chatView.hasAttribute('data-pane-drop'), false, 'an unknown side is no hover');
  assert.deepEqual(writes, [['set', 'left'], ['set', 'right'], ['remove']], 'one write per change');
  assert.deepEqual(Array.from(pane0.attributes).map((attr) => `${attr.name}=${attr.value}`), pane0Attributes);
  assert.equal(rig.chatView.className, 'main-view chat-view', 'no class on the view');
});

test('setDropHover with two panes: the same attribute (the CSS outlines that side\'s pane root)', (t) => {
  const rig = createRig(t);
  rig.layoutController.openBeside('b');
  rig.composition.setDropHover('right');
  assert.equal(rig.chatView.getAttribute('data-pane-drop'), 'right');
  assert.equal(rig.chatView.dataset.paneCount, '2');
  rig.composition.setDropHover(null);
  assert.equal(rig.chatView.hasAttribute('data-pane-drop'), false);
});

test('getDropTarget: #chatView; the visual half hovers and drops through placeSession (LTR)', (t) => {
  const rig = createRig(t);
  const target = rig.composition.getDropTarget();
  assert.equal(target.el, rig.chatView);
  target.onHover('right');
  assert.equal(rig.chatView.getAttribute('data-pane-drop'), 'right');
  target.onHover(null);
  target.onDrop('b', 'left');
  assert.deepEqual(rig.state.panes.panes.map((pane) => pane.sessionId), ['b', 'a']);
  assert.equal(rig.state.currentSessionId, 'a', 'the session on screen keeps focus on the right');
  assert.equal(rig.chatView.hasAttribute('data-pane-drop'), false);
  assert.equal(rig.persisted.length, 1, 'one persist, from the layout controller');
});

test('a drop on the left half loads the placed session for pane 0 (a never-opened tab is not a blank pane)', (t) => {
  const rig = createRig(t);
  rig.loads.length = 0;
  rig.composition.getDropTarget().onDrop('b', 'left');
  assert.deepEqual(rig.state.panes.panes.map((pane) => pane.sessionId), ['b', 'a']);
  assert.deepEqual(rig.loads.slice().sort(), ['a', 'b'], 'pane 0 asks for its new session (b); pane 1 asks for the one it mounts with (a)');
  rig.loads.length = 0;
  rig.layoutController.swapPanes();
  assert.deepEqual(rig.loads.slice().sort(), ['a', 'b'], 'a swap re-asks for both (the loader is idempotent for loaded sessions)');
});

test('getDropTarget in RTL: the visual left half is the inline-end pane (pane 1)', (t) => {
  const rig = createRig(t);
  rig.doc.documentElement.dir = 'rtl';
  const target = rig.composition.getDropTarget();
  target.onHover('left');
  assert.equal(rig.chatView.getAttribute('data-pane-drop'), 'right', 'the attribute names the pane side, which CSS draws with logical insets');
  target.onHover(null);
  target.onDrop('b', 'left');
  assert.deepEqual(rig.state.panes.panes.map((pane) => pane.sessionId), ['a', 'b'], 'visual left in RTL is pane 1');
});
