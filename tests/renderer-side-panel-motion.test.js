'use strict';

// Side-panel column motion with the reading text reflowing once
// (renderer/features/renderer-side-panel-motion.js, row 59 checkpoint 1): the
// measure lock is applied before the column moves and released when it has
// settled, the reader anchor brackets each reflow point, and a cancel,
// dispose, reduced motion or a zero-duration token never leaves a lock behind.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createSidePanelMotion, parseDurationMs } = require('../renderer/features/renderer-side-panel-motion');

const LOCK = '--chat-measure-lock';
const CONTENT = '--side-panel-content-width';
const CLOSED_MEASURE = 1000;
const OPEN_MEASURE = 700;

function makeFixture(t, { panes = 2, hiddenPane = -1 } = {}) {
  const dom = new JSDOM('<!doctype html><div id="chatView" class="chat-view"><aside id="panel"></aside></div>');
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const chatView = doc.getElementById('chatView');
  const panel = doc.getElementById('panel');
  Object.defineProperty(panel, 'clientWidth', { value: 419, configurable: true });
  const paneEls = [];
  for (let index = 0; index < panes; index += 1) {
    const pane = doc.createElement('div');
    pane.className = 'chat-pane';
    // The timeline's box is the measure; the composer (held wider by its floor) is never read.
    const timeline = doc.createElement('div');
    timeline.dataset.chatNode = 'chatTimeline';
    // The reading column is narrower once the panel is open (the class is the end state).
    timeline.getBoundingClientRect = () => ({ width: index === hiddenPane ? 0 : (chatView.classList.contains('open') ? OPEN_MEASURE : CLOSED_MEASURE) });
    pane.appendChild(timeline);
    const composer = doc.createElement('div');
    composer.className = 'composer';
    composer.getBoundingClientRect = () => ({ width: 320 });
    pane.appendChild(composer);
    chatView.insertBefore(pane, panel);
    paneEls.push(pane);
  }
  const log = [];
  const lockOf = (pane) => pane.style.getPropertyValue(LOCK);
  const coordinator = {
    captureReaderAnchor: () => log.push(`capture lock=${lockOf(paneEls[0]) || 'none'} phase=${chatView.dataset.panelMotion || 'none'}`),
    restoreReaderAnchor: () => log.push(`restore lock=${lockOf(paneEls[0]) || 'none'} phase=${chatView.dataset.panelMotion || 'none'}`),
  };
  const timers = [];
  const win = {
    setTimeout: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length - 1; },
    clearTimeout: (id) => { if (timers[id]) timers[id].live = false; },
  };
  const options = { duration: 220, reduced: false };
  const motion = createSidePanelMotion({
    chatView, win,
    getCoordinators: () => [coordinator, null],
    getDurationMs: () => options.duration,
    isReducedMotion: () => options.reduced,
  });
  t.after(() => motion.dispose());
  const applyOpen = () => { log.push('apply open'); chatView.classList.add('open'); };
  const applyClosed = () => { log.push('apply closed'); chatView.classList.remove('open'); };
  const fireTimer = () => { const live = timers.filter((timer) => timer.live); const last = live[live.length - 1]; last.live = false; last.fn(); };
  const emit = (target, type) => target.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
  return { dom, chatView, panel, paneEls, log, timers, options, motion, applyOpen, applyClosed, fireTimer, emit, lockOf };
}

describe('parseDurationMs', () => {
  test('reads ms and s tokens and rejects anything else as zero', () => {
    assert.equal(parseDurationMs('220ms'), 220);
    assert.equal(parseDurationMs(' 0.28s '), 280);
    assert.equal(parseDurationMs('0ms'), 0);
    assert.equal(parseDurationMs('calc(1ms)'), 0);
    assert.equal(parseDurationMs(''), 0);
  });
});

describe('open', () => {
  test('locks the end measure before the column moves, then releases it once it has settled', (t) => {
    const f = makeFixture(t, { hiddenPane: 1 });
    assert.equal(f.motion.open({ panel: f.panel, applyEnd: f.applyOpen }), true);
    assert.deepEqual(f.log, [
      'capture lock=none phase=none',
      'apply open',
      'restore lock=700px phase=opening',
    ], 'anchor captured before the lock, restored after it; the end state is applied before the lock');
    assert.equal(f.lockOf(f.paneEls[0]), `${OPEN_MEASURE}px`, 'the lock is the width the pane has when fully open');
    assert.equal(f.lockOf(f.paneEls[1]), '', 'a pane that is not visible takes no lock');
    assert.equal(f.chatView.style.getPropertyValue(CONTENT), '419px', 'content stays at its final width');
    assert.equal(f.chatView.dataset.panelMotion, 'opening');
    assert.equal(f.motion.state(), 'opening');
    assert.equal(f.timers.filter((timer) => timer.live)[0].ms, 270, 'the fallback is duration + 50 ms');

    f.log.length = 0;
    f.fireTimer();
    assert.deepEqual(f.log, ['capture lock=700px phase=opening', 'restore lock=none phase=none']);
    assert.equal(f.lockOf(f.paneEls[0]), '');
    assert.equal(f.chatView.style.getPropertyValue(CONTENT), '');
    assert.equal(f.chatView.dataset.panelMotion, undefined);
    assert.equal(f.motion.state(), 'idle');
  });

  test('the panel\'s own animationend settles it; a child\'s does not, and the timer is cleared', (t) => {
    const f = makeFixture(t);
    f.motion.open({ panel: f.panel, applyEnd: f.applyOpen });
    const child = f.dom.window.document.createElement('div');
    f.panel.appendChild(child);
    f.emit(child, 'animationend');
    assert.equal(f.motion.state(), 'opening', 'a bubbling child event is not the column');
    f.emit(f.panel, 'animationend');
    assert.equal(f.motion.state(), 'idle');
    assert.equal(f.timers.some((timer) => timer.live), false, 'the fallback timer was cleared');
    f.emit(f.panel, 'animationend'); // a late duplicate is harmless
    assert.equal(f.lockOf(f.paneEls[0]), '');
  });

  test('a transition-driven panel measures its end state, restores the start, then plays the end state', (t) => {
    const f = makeFixture(t);
    const applyStart = () => { f.log.push('apply start'); f.chatView.classList.remove('open'); };
    f.motion.open({ panel: f.panel, applyEnd: f.applyOpen, applyStart });
    assert.deepEqual(f.log, [
      'capture lock=none phase=none',
      'apply open',
      'apply start',
      'apply open',
      'restore lock=700px phase=opening',
    ]);
    f.emit(f.panel, 'transitionend');
    assert.equal(f.motion.state(), 'idle');
  });
});

describe('close', () => {
  test('keeps the current measure, applies the end state now and releases the lock when collapsed', (t) => {
    const f = makeFixture(t);
    f.chatView.classList.add('open');
    assert.equal(f.motion.close({ panel: f.panel, applyEnd: f.applyClosed }), true);
    assert.equal(f.lockOf(f.paneEls[0]), `${OPEN_MEASURE}px`, 'locked at the current (open) measure');
    assert.equal(f.chatView.dataset.panelMotion, 'closing');
    assert.deepEqual(f.log, ['apply closed']);
    f.log.length = 0;
    f.emit(f.panel, 'transitionend');
    assert.deepEqual(f.log, ['capture lock=700px phase=closing', 'restore lock=none phase=none'],
      'the reflow point is the release: anchor captured before it, restored after');
    assert.equal(f.lockOf(f.paneEls[1]), '');
  });

  test('a deferred end state lands between the anchor capture and the release', (t) => {
    const f = makeFixture(t);
    f.chatView.classList.add('open');
    f.motion.close({ panel: f.panel, applyEnd: f.applyClosed, deferEnd: true });
    assert.deepEqual(f.log, [], 'nothing changes until the column has collapsed');
    assert.equal(f.chatView.classList.contains('open'), true);
    f.fireTimer();
    assert.deepEqual(f.log, ['capture lock=700px phase=closing', 'apply closed', 'restore lock=none phase=none']);
    assert.equal(f.chatView.classList.contains('open'), false);
    assert.equal(f.motion.state(), 'idle');
  });
});

describe('cancel, dispose and host', () => {
  test('a re-toggle mid-motion releases the lock and clears the phase; a deferred close still lands its end state', (t) => {
    const f = makeFixture(t);
    f.chatView.classList.add('open');
    f.motion.close({ panel: f.panel, applyEnd: f.applyClosed, deferEnd: true });
    f.log.length = 0;
    assert.equal(f.motion.cancel(), true);
    assert.deepEqual(f.log, ['capture lock=700px phase=closing', 'apply closed', 'restore lock=none phase=none']);
    assert.equal(f.lockOf(f.paneEls[0]), '');
    assert.equal(f.chatView.dataset.panelMotion, undefined);
    assert.equal(f.timers.some((timer) => timer.live), false);
    f.emit(f.panel, 'animationend');
    assert.equal(f.log.length, 3, 'the cancelled motion no longer reacts to its end event');
    assert.equal(f.motion.cancel(), false, 'nothing to cancel when idle');
  });

  test('opening while a close runs cancels the close first', (t) => {
    const f = makeFixture(t);
    f.chatView.classList.add('open');
    f.motion.close({ panel: f.panel, applyEnd: f.applyClosed, deferEnd: true });
    f.motion.open({ panel: f.panel, applyEnd: f.applyOpen });
    assert.equal(f.motion.state(), 'opening');
    assert.equal(f.lockOf(f.paneEls[0]), `${OPEN_MEASURE}px`);
    assert.equal(f.timers.filter((timer) => timer.live).length, 1, 'one fallback timer, the new one');
  });

  test('dispose releases the lock and the timer, and later calls only apply the state', (t) => {
    const f = makeFixture(t);
    f.motion.open({ panel: f.panel, applyEnd: f.applyOpen });
    f.motion.dispose();
    assert.equal(f.lockOf(f.paneEls[0]), '');
    assert.equal(f.chatView.dataset.panelMotion, undefined);
    assert.equal(f.timers.some((timer) => timer.live), false);
    f.log.length = 0;
    f.chatView.classList.remove('open');
    assert.equal(f.motion.close({ panel: f.panel, applyEnd: f.applyClosed }), false, 'a disposed controller never starts a motion');
    assert.equal(f.lockOf(f.paneEls[0]), '');
    assert.deepEqual(f.log, ['capture lock=none phase=none', 'apply closed', 'restore lock=none phase=none']);
  });

  test('the other panel claiming the host mid deferred close still closes this panel', (t) => {
    const f = makeFixture(t);
    const other = createSidePanelMotion({ chatView: f.chatView, win: f.dom.window, getDurationMs: () => 220, isReducedMotion: () => false });
    t.after(() => other.dispose());
    f.chatView.classList.add('open');
    f.motion.close({ panel: f.panel, applyEnd: f.applyClosed, deferEnd: true });
    other.open({ panel: f.panel, applyEnd: () => {} });
    assert.equal(f.motion.state(), 'idle', 'the deferred close was cancelled by the claim');
    assert.ok(f.log.includes('apply closed'), 'and its end state was applied, not dropped');
    assert.equal(f.chatView.classList.contains('open'), false);
  });

  test('two controllers on one host never hold locks at once', (t) => {
    const f = makeFixture(t);
    const other = createSidePanelMotion({ chatView: f.chatView, win: f.dom.window, getDurationMs: () => 220, isReducedMotion: () => false });
    t.after(() => other.dispose());
    f.motion.open({ panel: f.panel, applyEnd: f.applyOpen });
    other.close({ panel: f.panel, applyEnd: f.applyClosed });
    assert.equal(f.motion.state(), 'idle', 'the first motion was cancelled');
    assert.equal(other.state(), 'closing');
  });
});

describe('no motion', () => {
  for (const [name, configure] of [
    ['reduced motion', (f) => { f.options.reduced = true; }],
    ['a zero-duration token', (f) => { f.options.duration = 0; }],
  ]) {
    test(`${name}: the end state lands at once, as one reflow bracketed by the anchor`, (t) => {
      const f = makeFixture(t);
      configure(f);
      assert.equal(f.motion.open({ panel: f.panel, applyEnd: f.applyOpen }), false);
      assert.deepEqual(f.log, ['capture lock=none phase=none', 'apply open', 'restore lock=none phase=none']);
      assert.equal(f.lockOf(f.paneEls[0]), '', 'no lock without motion');
      assert.equal(f.chatView.dataset.panelMotion, undefined);
      assert.equal(f.timers.length, 0);
      f.log.length = 0;
      assert.equal(f.motion.close({ panel: f.panel, applyEnd: f.applyClosed, deferEnd: true }), false);
      assert.deepEqual(f.log, ['capture lock=none phase=none', 'apply closed', 'restore lock=none phase=none'],
        'a deferred end state still lands, immediately');
    });
  }

  test('a missing panel or a collapsed panel just applies the state', (t) => {
    const f = makeFixture(t);
    assert.equal(f.motion.open({ panel: null, applyEnd: f.applyOpen }), false);
    Object.defineProperty(f.panel, 'clientWidth', { value: 0, configurable: true });
    f.chatView.classList.add('open');
    assert.equal(f.motion.close({ panel: f.panel, applyEnd: f.applyClosed }), false, 'nothing to collapse');
    assert.equal(f.motion.state(), 'idle');
  });

  test('a throwing coordinator never blocks the state change', (t) => {
    const dom = new JSDOM('<div id="chatView"></div>');
    t.after(() => dom.window.close());
    const motion = createSidePanelMotion({
      chatView: dom.window.document.getElementById('chatView'), win: dom.window,
      getCoordinators: () => [{ captureReaderAnchor() { throw new Error('mid-dispose'); }, restoreReaderAnchor() { throw new Error('mid-dispose'); } }],
      getDurationMs: () => 0,
    });
    let applied = 0;
    motion.open({ panel: dom.window.document.body, applyEnd: () => { applied += 1; } });
    assert.equal(applied, 1);
  });
});

// The chat context panel gets the same lock / anchor behaviour; its column is
// driven by a CSS width transition, so the start state is restored after the
// end state has been measured.
describe('context panel column motion', () => {
  const { createContextPanelController } = require('../renderer/features/renderer-context-panel-utils');

  function makeContextFixture(t, duration = '220ms') {
    const dom = new JSDOM('<!doctype html><div id="chatView" class="chat-view"><div class="chat-pane"><div data-chat-node="chatTimeline"></div><div class="composer"></div></div>'
      + '<button id="toggle"></button><aside id="panel"></aside></div>');
    t.after(() => dom.window.close());
    const doc = dom.window.document;
    const chatView = doc.getElementById('chatView');
    const panel = doc.getElementById('panel');
    chatView.style.setProperty('--motion-duration-regular', duration);
    Object.defineProperty(panel, 'clientWidth', { value: 319, configurable: true });
    const pane = doc.querySelector('.chat-pane');
    doc.querySelector('[data-chat-node="chatTimeline"]').getBoundingClientRect = () => ({ width: panel.classList.contains('collapsed') ? 900 : 700 });
    const calls = [];
    const lock = () => pane.style.getPropertyValue('--chat-measure-lock');
    const controller = createContextPanelController({
      state: { ui: { activeView: 'chat' } },
      dom: { chatContextPanel: panel, contextPanelToggle: doc.getElementById('toggle') },
      callbacks: {
        updateComposerSafeOffset() {}, escapeHtml: String,
        getScrollCoordinators: () => [{
          captureReaderAnchor: () => calls.push(`capture:${lock() || '-'}`),
          restoreReaderAnchor: () => calls.push(`restore:${lock() || '-'}`),
        }],
      },
      constants: {},
    });
    controller.bind();
    t.after(() => controller.dispose());
    const settle = () => panel.dispatchEvent(new dom.window.Event('transitionend'));
    return { dom, chatView, panel, doc, calls, lock, settle, toggle: () => doc.getElementById('toggle').click(), phase: () => chatView.dataset.panelMotion };
  }

  test('expanding locks the open measure, starts from the collapsed state and releases when settled', (t) => {
    const f = makeContextFixture(t);
    assert.equal(f.panel.classList.contains('collapsed'), true, 'collapsed unless the user expanded it');
    f.toggle();
    assert.equal(f.panel.classList.contains('collapsed'), false);
    assert.equal(f.phase(), 'opening');
    assert.equal(f.lock(), '700px');
    assert.deepEqual(f.calls, ['capture:-', 'restore:700px']);
    f.calls.length = 0;
    f.settle();
    assert.equal(f.phase(), undefined);
    assert.equal(f.lock(), '');
    assert.deepEqual(f.calls, ['capture:700px', 'restore:-']);
  });

  test('collapsing locks the current measure and reflows once, when the column has collapsed', (t) => {
    const f = makeContextFixture(t);
    f.toggle();
    f.settle();
    f.calls.length = 0;
    f.toggle();
    assert.equal(f.panel.classList.contains('collapsed'), true, 'the transition runs from the collapsed class');
    assert.equal(f.phase(), 'closing');
    assert.equal(f.lock(), '700px');
    assert.deepEqual(f.calls, []);
    f.settle();
    assert.equal(f.lock(), '');
    assert.deepEqual(f.calls, ['capture:700px', 'restore:-']);
  });

  test('a re-toggle mid-motion releases the lock, and dispose leaves nothing behind', (t) => {
    const f = makeContextFixture(t);
    f.toggle();
    f.toggle();
    assert.equal(f.phase(), 'closing', 'the second toggle cancels the open and starts the close');
    assert.equal(f.lock(), '700px');
    f.toggle();
    assert.equal(f.phase(), 'opening');
  });

  test('a zero-duration token applies the class at once with one anchored reflow', (t) => {
    const f = makeContextFixture(t, '0ms');
    f.toggle();
    assert.equal(f.panel.classList.contains('collapsed'), false);
    assert.equal(f.phase(), undefined);
    assert.equal(f.lock(), '');
    assert.deepEqual(f.calls, ['capture:-', 'restore:-']);
  });
});
