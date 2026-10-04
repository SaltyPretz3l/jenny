'use strict';

/* Split view W2-1 -- drag-to-split on the pane composition (jsdom). The rig
 * lives in tests/helpers/pane-composition-rig.js; the lifecycle suite is
 * tests/renderer-pane-composition.test.js. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRig, paneRoot, kickerOf } = require('./helpers/pane-composition-rig');

/* ── Split view W2-1: drag-to-split. The composition owns the drop-zone
 * visuals: `setDropHover(side | null)` writes #chatView[data-pane-drop] and
 * nothing else (CSS draws the outline); `getDropTarget()` is what the rail's
 * tab drag hands its visual half to; a kicker-title drag swaps the panes. ── */
function spyAttributeWrites(el) {
  const writes = [];
  const setAttribute = el.setAttribute.bind(el);
  const removeAttribute = el.removeAttribute.bind(el);
  el.setAttribute = (name, value) => { if (name === 'data-pane-drop') writes.push(['set', value]); return setAttribute(name, value); };
  el.removeAttribute = (name) => { if (name === 'data-pane-drop') writes.push(['remove']); return removeAttribute(name); };
  return writes;
}

function pointer(rig, target, type, init) {
  target.dispatchEvent(new rig.dom.window.PointerEvent(type, { button: 0, pointerId: 7, bubbles: true, ...init }));
}

function stubCapture(el) {
  const calls = [];
  el.setPointerCapture = (id) => calls.push(['set', id]);
  el.releasePointerCapture = (id) => calls.push(['release', id]);
  return calls;
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

test('kicker drag: past 5px a ghost follows, the other pane is outlined while hovered, and the drop swaps the panes', (t) => {
  const rig = createRig(t);
  rig.layoutController.openBeside('b');
  const kicker0 = kickerOf(rig, 0);
  const capture = stubCapture(kicker0);
  const root1 = paneRoot(rig.chatView, 1);
  const reads = [];
  root1.getBoundingClientRect = () => { reads.push(1); return { left: 410, right: 800, top: 0, bottom: 600, width: 390, height: 600 }; };
  const title = kicker0.querySelector('.chat-pane-kicker-title');
  assert.ok(title !== null, 'two panes: the kicker has a title to drag');
  assert.equal(title.getAttribute('dir'), 'auto', 'the title keeps its own direction inside RTL chrome (live re-check NF5)');

  pointer(rig, title, 'pointerdown', { clientX: 50, clientY: 10 });
  pointer(rig, kicker0, 'pointermove', { clientX: 52, clientY: 11 });
  assert.equal(rig.doc.querySelector('.workspace-tab-drag-ghost'), null, 'below the threshold nothing starts');
  pointer(rig, kicker0, 'pointermove', { clientX: 60, clientY: 10 });
  const ghost = rig.doc.querySelector('.workspace-tab-drag-ghost');
  assert.ok(ghost !== null, 'the rail ghost is reused');
  assert.equal(ghost.textContent, 'Alpha');
  assert.equal(ghost.getAttribute('aria-hidden'), 'true');
  assert.equal(ghost.parentElement, rig.doc.body);
  assert.deepEqual(capture, [['set', 7]], 'pointer capture on the kicker');
  assert.equal(reads.length, 1, 'the other pane is measured once, at commit');
  assert.equal(rig.chatView.hasAttribute('data-pane-drop'), false);

  pointer(rig, kicker0, 'pointermove', { clientX: 500, clientY: 300 });
  assert.equal(rig.chatView.getAttribute('data-pane-drop'), 'right', 'the OTHER pane is outlined');
  pointer(rig, kicker0, 'pointermove', { clientX: 200, clientY: 300 });
  assert.equal(rig.chatView.hasAttribute('data-pane-drop'), false, 'off the other pane: no outline');
  pointer(rig, kicker0, 'pointermove', { clientX: 600, clientY: 100 });
  assert.equal(reads.length, 1, 'no layout read per move');

  pointer(rig, kicker0, 'pointerup', { clientX: 600, clientY: 100 });
  assert.deepEqual(rig.state.panes.panes.map((pane) => pane.sessionId), ['b', 'a']);
  assert.equal(rig.state.currentSessionId, 'a', 'focus follows the dragged session');
  assert.equal(rig.chatView.hasAttribute('data-pane-drop'), false);
  assert.equal(rig.doc.querySelector('.workspace-tab-drag-ghost'), null);
  assert.deepEqual(capture, [['set', 7], ['release', 7]]);
});

test('kicker drag: a release off the other pane swaps nothing; Escape cancels mid-drag', (t) => {
  const rig = createRig(t);
  rig.layoutController.openBeside('b');
  const kicker1 = kickerOf(rig, 1);
  stubCapture(kicker1);
  rig.doc.getElementById('chatPane0').getBoundingClientRect = () => ({ left: 0, right: 400, top: 0, bottom: 600, width: 400, height: 600 });
  const title = kicker1.querySelector('.chat-pane-kicker-title');

  pointer(rig, title, 'pointerdown', { clientX: 600, clientY: 10 });
  pointer(rig, kicker1, 'pointermove', { clientX: 580, clientY: 10 });
  pointer(rig, kicker1, 'pointerup', { clientX: 580, clientY: 10 });
  assert.deepEqual(rig.state.panes.panes.map((pane) => pane.sessionId), ['a', 'b'], 'dropped on its own pane: no swap');

  pointer(rig, title, 'pointerdown', { clientX: 600, clientY: 10 });
  pointer(rig, kicker1, 'pointermove', { clientX: 100, clientY: 300 });
  assert.equal(rig.chatView.getAttribute('data-pane-drop'), 'left');
  rig.doc.dispatchEvent(new rig.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(rig.chatView.hasAttribute('data-pane-drop'), false);
  assert.equal(rig.doc.querySelector('.workspace-tab-drag-ghost'), null);
  pointer(rig, kicker1, 'pointerup', { clientX: 100, clientY: 300 });
  assert.deepEqual(rig.state.panes.panes.map((pane) => pane.sessionId), ['a', 'b'], 'Escape cancelled the swap');
});

test('kicker drag: closing the pane mid-drag disposes the gesture and every listener it added', (t) => {
  const rig = createRig(t);
  rig.layoutController.openBeside('b');
  const kicker0 = kickerOf(rig, 0);
  stubCapture(kicker0);
  paneRoot(rig.chatView, 1).getBoundingClientRect = () => ({ left: 410, right: 800, top: 0, bottom: 600, width: 390, height: 600 });
  const added = [];
  const removed = [];
  for (const target of [rig.doc, kicker0]) {
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    target.addEventListener = (type, handler, options) => { added.push([target, type, handler]); return add(type, handler, options); };
    target.removeEventListener = (type, handler, options) => { removed.push([target, type, handler]); return remove(type, handler, options); };
  }

  pointer(rig, kicker0.querySelector('.chat-pane-kicker-title'), 'pointerdown', { clientX: 50, clientY: 10 });
  pointer(rig, kicker0, 'pointermove', { clientX: 500, clientY: 300 });
  assert.equal(rig.chatView.getAttribute('data-pane-drop'), 'right');
  assert.ok(added.length >= 4, 'the gesture binds its move, up, cancel and Escape listeners');

  rig.layoutController.closePane(1);
  assert.equal(rig.chatView.hasAttribute('data-pane-drop'), false, 'one pane: no attribute outside a drag');
  assert.equal(rig.doc.querySelector('.workspace-tab-drag-ghost'), null);
  for (const [target, type, handler] of added) {
    assert.ok(removed.some(([t2, type2, h2]) => t2 === target && type2 === type && h2 === handler), `${type} listener removed`);
  }
  pointer(rig, kicker0, 'pointerup', { clientX: 500, clientY: 300 });
  assert.equal(rig.layoutController.getPaneCount(), 1, 'a stray release after the close swaps nothing');
  assert.equal(rig.state.currentSessionId, 'a');
});
