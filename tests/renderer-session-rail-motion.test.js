'use strict';

/* Row 115 slice 3: the Session rail's glide, the panel-forced exit and the drag-to-resize separator
   (renderer-session-rail-motion.js, wired by renderer-session-rail.js), in jsdom. jsdom has no layout and no
   running transitions, so the shared side-panel motion is driven with an injected duration and its end is
   delivered as the animationend event; real widths and computed animations are asserted in headless Chromium by
   tests/renderer-session-rail-layout.test.js. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { flush, createFixture, docked } = require('./helpers/session-rail-fixture.js');
const { createSidePanelMotion } = require('../renderer/features/renderer-side-panel-motion.js');
const railMotion = require('../renderer/chat/renderer-session-rail-motion.js');
const sessionRail = require('../renderer/chat/renderer-session-rail.js');

const MOTION = { getDurationMs: () => 220, isReducedMotion: () => false };
const STORAGE_KEY = 'jenny.sessionRail.v1';

// jsdom lays nothing out: a rail with width is what lets a close glide (the motion skips a zero-width panel).
function withWidth(f) {
  Object.defineProperty(f.rail(), 'clientWidth', { value: 280, configurable: true });
  return f;
}

function recordReflow(f) {
  const events = [];
  f.pane.addEventListener('session-rail-reflow', (event) => events.push(event.detail.phase));
  return events;
}

function endMotion(f, target) {
  target.dispatchEvent(new f.window.Event('animationend'));
}

const glideOf = (f) => f.pane.getAttribute('data-session-rail-glide');
const phaseOf = (f) => f.chatView.getAttribute('data-panel-motion');

test('a session switch paints "Checking..." with data-no-motion on the tray, and leaves none behind', async (t) => {
  const f = await docked({ sessionId: 'sess_a' });
  t.after(() => { f.api.dispose(); f.window.close(); });
  const tray = f.api.elements.tray;
  const seen = [];
  const observer = new f.window.MutationObserver((records) => {
    for (const record of records) if (record.attributeName === 'data-no-motion') seen.push(tray.hasAttribute('data-no-motion'));
  });
  observer.observe(tray, { attributes: true, attributeFilter: ['data-no-motion'], attributeOldValue: true });
  f.changeSession('sess_b');
  assert.equal(f.value('context'), 'Checking…', 'the switch cleared to checking');
  const records = observer.takeRecords();
  observer.disconnect();
  assert.deepEqual(records.map((record) => [record.attributeName, record.oldValue]), [['data-no-motion', null], ['data-no-motion', '']],
    'data-no-motion was set around the paint and removed again');
  assert.equal(tray.hasAttribute('data-no-motion'), false);
  assert.equal(seen.length, 0, 'no observer callback ran with the attribute left on');
});

test('the toggle glides: pressed flips with the click, the rail stays up through a close, one reflow pair per reflow point', async (t) => {
  const f = withWidth(await docked({ mountOptions: { motion: MOTION } }));
  t.after(() => { f.api.dispose(); f.window.close(); });
  const events = recordReflow(f);

  f.toggle().click(); // hide
  assert.equal(f.toggle().getAttribute('aria-pressed'), 'false', 'the pressed state flips in the same frame');
  assert.equal(phaseOf(f), 'closing', 'the shared motion is running');
  assert.equal(glideOf(f), 'closing');
  assert.equal(f.pane.dataset.sessionRail, 'docked', 'the pane keeps its reserve until the column has collapsed');
  assert.equal(f.rail().hidden, false, 'the content stays visible through a close');
  assert.ok(f.rail().querySelector('.session-rail-tray'), 'the tray is still in the rail');
  assert.deepEqual(events, [], 'a close anchors once, at its reflow point, not at the start');
  await flush();
  assert.equal(f.pane.dataset.sessionRail, 'docked', 'a settled write does not cut the glide short');
  assert.equal(f.rail().hidden, false);

  endMotion(f, f.rail());
  assert.equal(f.pane.dataset.sessionRail, 'hidden');
  assert.equal(f.rail().hidden, true);
  assert.equal(phaseOf(f), null, 'data-panel-motion is cleared');
  assert.equal(glideOf(f), null, 'the glide mark is cleared');
  assert.deepEqual(events, ['before', 'after'], 'one bracket, from the motion alone');
  assert.equal(f.api.elements.resizer.hidden, true, 'the resize handle goes with the rail');

  events.length = 0;
  f.toggle().click(); // show
  assert.equal(phaseOf(f), 'opening');
  assert.equal(glideOf(f), 'opening');
  assert.equal(f.pane.dataset.sessionRail, 'docked', 'an open lands its end state first, then glides to it');
  assert.equal(f.rail().hidden, false);
  assert.equal(f.api.elements.resizer.hidden, false);
  assert.deepEqual(events, ['before', 'after'], 'the open anchors around the lock, once');
  endMotion(f, f.rail());
  assert.deepEqual(events, ['before', 'after', 'before', 'after'], 'and once more when the lock is released');
  assert.equal(phaseOf(f), null);
  await flush(); // the motion attribute leaving clears the glide mark (a mutation observer)
  assert.equal(glideOf(f), null);
  assert.equal(f.chatView.querySelector('.chat-pane').style.getPropertyValue('--chat-measure-lock'), '', 'no measure lock is left');
  for (let i = 1; i < events.length; i += 1) assert.notEqual(events[i], events[i - 1], 'before and after strictly alternate');
});

test('a re-toggle mid-glide cancels it and snaps; nothing is left stuck', async (t) => {
  const f = withWidth(await docked({ mountOptions: { motion: MOTION } }));
  t.after(() => { f.api.dispose(); f.window.close(); });
  f.toggle().click(); // closing
  assert.equal(phaseOf(f), 'closing');
  f.toggle().click(); // shown again before the column collapsed
  assert.equal(phaseOf(f), 'opening', 'the new glide replaced the old one');
  assert.equal(glideOf(f), 'opening', 'the cancelled close must not wipe the new glide, or the rail would snap');
  assert.equal(f.pane.dataset.sessionRail, 'docked');
  endMotion(f, f.rail());
  assert.equal(phaseOf(f), null);
  await flush();
  assert.equal(glideOf(f), null);
  assert.equal(f.rail().hidden, false);
  assert.equal(f.bridge.setViewCalls.length, 2, 'both toggles wrote rail_visible');
});

test('a panel motion claiming the host cancels the rail glide cleanly, and the reverse', async (t) => {
  const f = withWidth(await docked({ mountOptions: { motion: MOTION } }));
  t.after(() => { f.api.dispose(); f.window.close(); });
  const panelMotion = createSidePanelMotion({ chatView: f.chatView, win: f.window, ...MOTION });
  Object.defineProperty(f.context, 'clientWidth', { value: 320, configurable: true });
  f.toggle().click(); // closing, rail up
  assert.equal(phaseOf(f), 'closing');
  panelMotion.open({ panel: f.context, applyEnd: () => f.context.classList.remove('collapsed'), applyStart: () => f.context.classList.add('collapsed') });
  assert.equal(f.pane.dataset.sessionRail, 'hidden', 'the cancelled close landed its end state');
  assert.equal(phaseOf(f), 'opening', 'the panel owns the motion now');
  endMotion(f, f.context);
  assert.equal(phaseOf(f), null);
  await flush();
  assert.equal(glideOf(f), null, 'no glide mark outlives the motion');
  f.toggle().click(); // show: claims the host back from nobody, panel motion idle
  assert.equal(glideOf(f), 'opening');
  panelMotion.close({ panel: f.context, applyEnd: () => f.context.classList.add('collapsed') }); // cancels the rail's open
  assert.equal(phaseOf(f), 'closing');
  await flush();
  assert.equal(f.pane.dataset.sessionRail, 'docked');
  endMotion(f, f.context);
  await flush();
  assert.equal(glideOf(f), null);
  assert.equal(phaseOf(f), null);
  panelMotion.dispose();
});

test('width-driven dock changes, and a session switch, stay instant and keep the reflow bracket', async (t) => {
  const f = withWidth(await docked({ width: 700, mountOptions: { motion: MOTION } }));
  t.after(() => { f.api.dispose(); f.window.close(); });
  const events = recordReflow(f);
  await f.resize(1200);
  assert.equal(f.pane.dataset.sessionRail, 'docked');
  assert.equal(phaseOf(f), null, 'a resize never starts the motion');
  assert.equal(glideOf(f), null);
  assert.deepEqual(events, ['before', 'after']);

  f.toggle().click(); // closing, mid-glide
  assert.equal(phaseOf(f), 'closing');
  f.changeSession('sess_b');
  assert.equal(phaseOf(f), null, 'a session switch snaps the glide');
  assert.equal(glideOf(f), null);
  assert.notEqual(f.pane.dataset.sessionRail, undefined);
});

test('a panel that leaves the pane under the dock width takes the rail out inside its own motion, once', async (t) => {
  const f = await docked({ width: 1000, mountOptions: { motion: MOTION } });
  t.after(() => { f.api.dispose(); f.window.close(); });
  const events = recordReflow(f);
  const modes = [];
  f.pane.addEventListener('session-rail-reflow', () => modes.push(f.pane.dataset.sessionRail));
  const panelMotion = createSidePanelMotion({ chatView: f.chatView, win: f.window, ...MOTION });
  assert.equal(f.pane.dataset.sessionRail, 'docked');

  panelMotion.open({
    panel: f.context,
    applyEnd: () => { f.context.classList.remove('collapsed'); f.state.width = 500; }, // the panel's final layout
    applyStart: () => f.context.classList.add('collapsed'),
  });
  assert.equal(f.pane.dataset.sessionRail, 'undocked', 'the rail decided with the panel final state, during the measuring step');
  assert.equal(f.rail().hidden, true);
  assert.equal(glideOf(f), 'leaving', 'its room rides the panel glide');
  assert.deepEqual(events, [], 'no reflow bracket of its own: the panel motion owns the anchors');
  assert.equal(phaseOf(f), 'opening');

  endMotion(f, f.context);
  await flush();
  assert.equal(f.pane.dataset.sessionRail, 'undocked', 'the re-run at the end causes no second layout change');
  assert.deepEqual(events, []);
  assert.equal(glideOf(f), null);
  assert.equal(phaseOf(f), null);
  panelMotion.dispose();
});

test('a panel opening that leaves the pane wide enough does not move the rail; the hook is a no-op for a non-listener', async (t) => {
  const f = await docked({ width: 1000, mountOptions: { motion: MOTION } });
  t.after(() => { f.api.dispose(); f.window.close(); });
  const panelMotion = createSidePanelMotion({ chatView: f.chatView, win: f.window, ...MOTION });
  let dispatched = 0;
  f.chatView.addEventListener('side-panel-measuring', () => { dispatched += 1; });
  panelMotion.open({ panel: f.context, applyEnd: () => { f.context.classList.remove('collapsed'); f.state.width = 700; }, applyStart: () => f.context.classList.add('collapsed') });
  assert.equal(dispatched, 1, 'one synchronous event per open');
  assert.equal(f.pane.dataset.sessionRail, 'docked', '700px with a panel open keeps the docked rail (>= 640)');
  assert.equal(glideOf(f), null);
  endMotion(f, f.context);
  panelMotion.dispose();
  // No listener at all: the open still runs exactly as before.
  const bare = createFixture({ mountOptions: { motion: MOTION } });
  const bareMotion = createSidePanelMotion({ chatView: bare.chatView, win: bare.window, ...MOTION });
  assert.equal(bareMotion.open({ panel: bare.context, applyEnd: () => bare.context.classList.remove('collapsed') }), true);
  bareMotion.dispose();
  bare.api.dispose();
  bare.window.close();
});

test('the rail disposes its glide and resizer: no listener, mark, lock or width stays on the pane', async () => {
  const f = withWidth(await docked({ mountOptions: { motion: MOTION } }));
  f.toggle().click();
  assert.equal(phaseOf(f), 'closing');
  f.api.dispose();
  assert.equal(phaseOf(f), null, 'the motion is released');
  assert.equal(glideOf(f), null);
  assert.equal(f.pane.style.getPropertyValue('--session-rail-width'), '');
  assert.equal(f.pane.querySelector('.session-rail-resizer'), null);
  f.window.close();
});

test('Ctrl+Backslash path: hideFocusedRail hides the focused pane docked rail through the toggle, and only then', async (t) => {
  const f = await docked();
  t.after(() => { f.api.dispose(); f.window.close(); });
  f.pane.setAttribute('data-pane-focused', 'true');
  assert.equal(sessionRail.hideFocusedRail(f.doc), true);
  assert.equal(f.pane.dataset.sessionRail, 'hidden');
  assert.equal(f.toggle().getAttribute('aria-pressed'), 'false');
  await flush();
  assert.deepEqual(f.bridge.setViewCalls.map((call) => call.patch), [{ rail_visible: false }], 'it writes rail_visible exactly as the toggle does');
  assert.equal(sessionRail.hideFocusedRail(f.doc), false, 'a hidden rail has nothing to hide');
  const narrow = await docked({ width: 700 });
  narrow.pane.setAttribute('data-pane-focused', 'true');
  assert.equal(sessionRail.hideFocusedRail(narrow.doc), false, 'below the dock width the sheet is not closed by the chord');
  assert.equal(narrow.pane.dataset.sessionRail, 'undocked');
  assert.deepEqual(narrow.bridge.setViewCalls, [], 'responsive state never writes rail_visible');
  narrow.api.dispose();
  narrow.window.close();
});

/* ── Resize ──────────────────────────────────────────────────────────── */

function pointer(f, type, init) {
  const event = new f.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: init.clientX, button: 0 });
  Object.defineProperty(event, 'pointerId', { value: init.pointerId || 1 });
  return event;
}

test('the resize separator is a labelled vertical separator, shown only while docked, with 240 to 420 and a default of 280', async (t) => {
  const f = await docked();
  t.after(() => { f.api.dispose(); f.window.close(); });
  const handle = f.api.elements.resizer;
  assert.equal(handle.getAttribute('role'), 'separator');
  assert.equal(handle.getAttribute('aria-orientation'), 'vertical');
  assert.equal(handle.getAttribute('aria-valuemin'), '240');
  assert.equal(handle.getAttribute('aria-valuemax'), '420');
  assert.equal(handle.getAttribute('aria-valuenow'), '280');
  assert.ok(handle.getAttribute('aria-label'));
  assert.equal(handle.tabIndex, 0);
  assert.ok(handle.classList.contains('artifact-review-resizer'), 'it reuses the artifact resizer look');
  assert.equal(handle.hidden, false);
  f.toggle().click();
  assert.equal(handle.hidden, true, 'hidden with the rail');
  f.toggle().click();
  assert.equal(handle.hidden, false);
  await flush();
  const narrow = await docked({ width: 700 });
  assert.equal(narrow.api.elements.resizer.hidden, true, 'the sheet has no handle');
  narrow.api.dispose();
  narrow.window.close();
});

test('arrow keys step 24 (clamped), Home resets to 280, End goes to 420; each key stores the width and brackets one reflow', async (t) => {
  const f = await docked();
  t.after(() => { f.api.dispose(); f.window.close(); });
  const handle = f.api.elements.resizer;
  const events = recordReflow(f);
  const press = (key) => handle.dispatchEvent(new f.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const now = () => handle.getAttribute('aria-valuenow');
  press('ArrowLeft');
  assert.equal(now(), '304');
  assert.equal(f.pane.style.getPropertyValue('--session-rail-width'), '304px');
  assert.deepEqual(events, ['before', 'after'], 'one reflow bracket per key');
  assert.deepEqual(JSON.parse(f.window.localStorage.getItem(STORAGE_KEY)), { width: 304 });
  press('ArrowRight'); press('ArrowRight');
  assert.equal(now(), '256');
  press('ArrowRight'); press('ArrowRight');
  assert.equal(now(), '240', 'never below 240');
  press('End');
  assert.equal(now(), '420');
  press('ArrowLeft');
  assert.equal(now(), '420', 'never above 420');
  press('Home');
  assert.equal(now(), '280');
  const other = new f.window.KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
  handle.dispatchEvent(other);
  assert.equal(other.defaultPrevented, false, 'other keys pass through');
});

test('a pointer drag applies on move, holds the reading measure, and saves and releases on pointerup', async (t) => {
  const f = await docked();
  t.after(() => { f.api.dispose(); f.window.close(); });
  const handle = f.api.elements.resizer;
  const timeline = f.doc.getElementById('timeline');
  const stage = f.doc.getElementById('stage');
  timeline.getBoundingClientRect = () => ({ width: 640, left: 0, right: 640, top: 0, bottom: 10, height: 10 });
  stage.getBoundingClientRect = () => ({ width: 1000, left: 0, right: 1000, top: 0, bottom: 10, height: 10 });
  const events = recordReflow(f);
  handle.dispatchEvent(pointer(f, 'pointerdown', { clientX: 800 }));
  assert.equal(f.pane.style.getPropertyValue('--chat-measure-lock'), '640px', 'the measure is locked for the drag');
  assert.ok(handle.classList.contains('dragging'));
  handle.dispatchEvent(pointer(f, 'pointermove', { clientX: 740 })); // 60px to the start side
  assert.equal(handle.getAttribute('aria-valuenow'), '340');
  handle.dispatchEvent(pointer(f, 'pointermove', { clientX: 700 }));
  assert.equal(handle.getAttribute('aria-valuenow'), '380');
  assert.equal(f.window.localStorage.getItem(STORAGE_KEY), null, 'nothing is saved while moving');
  assert.deepEqual(events, [], 'the text does not reflow while the drag runs');
  handle.dispatchEvent(pointer(f, 'pointerup', { clientX: 700 }));
  assert.equal(f.pane.style.getPropertyValue('--chat-measure-lock'), '', 'the lock is released');
  assert.equal(handle.classList.contains('dragging'), false);
  assert.deepEqual(events, ['before', 'after'], 'the release is one reflow, anchored');
  assert.deepEqual(JSON.parse(f.window.localStorage.getItem(STORAGE_KEY)), { width: 380 });
  // A move after the release is ignored.
  handle.dispatchEvent(pointer(f, 'pointermove', { clientX: 300 }));
  assert.equal(handle.getAttribute('aria-valuenow'), '380');
});

test('a drag holds the measure inside the stage slack, narrows it (anchored) only past it, and a cancel releases like a release', async (t) => {
  const f = await docked();
  t.after(() => { f.api.dispose(); f.window.close(); });
  const handle = f.api.elements.resizer;
  f.doc.getElementById('timeline').getBoundingClientRect = () => ({ width: 700, left: 0, right: 700, top: 0, bottom: 10, height: 10 });
  f.doc.getElementById('stage').getBoundingClientRect = () => ({ width: 760, left: 0, right: 760, top: 0, bottom: 10, height: 10 });
  const events = recordReflow(f);
  const lock = () => f.pane.style.getPropertyValue('--chat-measure-lock');
  handle.dispatchEvent(pointer(f, 'pointerdown', { clientX: 900 }));
  handle.dispatchEvent(pointer(f, 'pointermove', { clientX: 880 })); // +20: inside the 28px of slack
  assert.equal(handle.getAttribute('aria-valuenow'), '300');
  assert.equal(lock(), '700px', 'the measure is held while the stage has room');
  assert.deepEqual(events, [], 'and nothing reflows');
  handle.dispatchEvent(pointer(f, 'pointermove', { clientX: 400 })); // asks for +500: clamped to 420
  assert.equal(handle.getAttribute('aria-valuenow'), '420');
  assert.equal(lock(), '588px', 'past the slack the measure narrows by exactly the overflow (140 - 28)');
  assert.deepEqual(events, ['before', 'after'], 'that step is anchored');
  handle.dispatchEvent(pointer(f, 'pointermove', { clientX: 890 })); // back inside the slack
  assert.equal(lock(), '700px');
  handle.dispatchEvent(pointer(f, 'pointercancel', { clientX: 890 }));
  assert.equal(lock(), '');
  assert.equal(handle.classList.contains('dragging'), false);
});

test('a stored width is read at mount; missing, corrupt, out of range or blocked storage falls back; peers follow a save', async (t) => {
  const make = (stored, throwing = false) => {
    const f = createFixture({});
    f.api.dispose();
    if (stored !== undefined) f.window.localStorage.setItem(STORAGE_KEY, stored);
    if (throwing) Object.defineProperty(f.window, 'localStorage', { get() { throw new Error('blocked'); }, configurable: true });
    const again = sessionRail.mountSessionRail({
      pane: f.pane, cluster: f.doc.getElementById('cluster'), chatTimeline: f.doc.getElementById('timeline'), getSessionId: () => 'sess_a',
      getPaneWidth: () => 1133, bridge: f.bridge, windowRef: f.window,
    });
    t.after(() => { again.dispose(); f.window.close(); });
    return again.elements.resizer.getAttribute('aria-valuenow');
  };
  assert.equal(make(JSON.stringify({ width: 333 })), '333');
  assert.equal(make(undefined), '280', 'missing');
  assert.equal(make('{not json'), '280', 'corrupt');
  assert.equal(make(JSON.stringify({ width: 9999 })), '420', 'out of range clamps');
  assert.equal(make(JSON.stringify({ width: 'wide' })), '280');
  assert.equal(make(undefined, true), '280', 'blocked storage');
  assert.equal(railMotion.clampWidth(NaN), 280);
});

test('a width saved from one pane reaches the other pane rail of the same window', async (t) => {
  const f = await docked();
  t.after(() => { f.api.dispose(); f.window.close(); });
  const second = f.doc.createElement('div');
  second.className = 'chat-pane';
  second.id = 'chatPane1';
  second.innerHTML = '<div class="chat-thread-stage" id="stage2"></div><div class="chat-timeline-utility-cluster" id="cluster2"></div>';
  f.chatView.insertBefore(second, f.context);
  const otherApi = sessionRail.mountSessionRail({
    pane: second, cluster: f.doc.getElementById('cluster2'), getSessionId: () => 'sess_b', getPaneWidth: () => 1133,
    bridge: f.bridge, windowRef: f.window, detail: f.detail,
  });
  assert.ok(otherApi, 'a second rail mounted');
  t.after(() => otherApi.dispose());
  f.api.elements.resizer.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
  assert.equal(otherApi.elements.resizer.getAttribute('aria-valuenow'), '304');
  assert.equal(second.style.getPropertyValue('--session-rail-width'), '304px');
});

test('disposing releases the separator listeners and any held drag', async () => {
  const f = await docked();
  const handle = f.api.elements.resizer;
  f.doc.getElementById('timeline').getBoundingClientRect = () => ({ width: 640, left: 0, right: 640, top: 0, bottom: 10, height: 10 });
  handle.dispatchEvent(pointer(f, 'pointerdown', { clientX: 800 }));
  assert.equal(f.pane.style.getPropertyValue('--chat-measure-lock'), '640px');
  f.api.dispose();
  assert.equal(f.pane.style.getPropertyValue('--chat-measure-lock'), '', 'a drag in flight lets go of the lock');
  handle.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
  assert.equal(f.window.localStorage.getItem(STORAGE_KEY), null, 'a disposed separator ignores keys');
  assert.equal(handle.isConnected, false);
  f.window.close();
});
