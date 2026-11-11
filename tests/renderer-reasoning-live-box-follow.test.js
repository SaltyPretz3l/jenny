'use strict';

// Row 101 Phase 2 live box: the streaming reasoning panel body is capped by
// CSS and scrolls inside itself. This module chases the box's own bottom with
// the damped S3 profile, releases on a reader scroll-away inside the box,
// resumes near the bottom, toggles the top-fade class and keeps the marker the
// CSS uses to hold the cap through the settle collapse.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const liveBox = require('../renderer/chat/renderer-reasoning-live-box-follow');

const {
  LIVE_BOX_MARKER_ATTR,
  HAS_SCROLLED_CLASS,
  LIVE_BOX_BODY_SELECTOR,
  createReasoningLiveBoxFollow,
  capturePatchState,
  restorePatchState,
  isAnyReaderAway,
} = liveBox;

function block(thinkingId, phaseKey, status = 'streaming') {
  return `<div class="reasoning-row-block" data-reasoning-status="${status}">`
    + `<div class="reasoning-row-panel expanded" data-thinking-id="${thinkingId}" data-phase-key="${phaseKey}">`
    + '<div class="reasoning-row-panel-body"><p>thinking</p></div></div></div>';
}

function stubBody(win, body, metrics) {
  let top = 0;
  const max = () => Math.max(0, metrics.scrollHeight - metrics.clientHeight);
  Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => metrics.scrollHeight });
  Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => metrics.clientHeight });
  Object.defineProperty(body, 'scrollTop', {
    configurable: true,
    get: () => Math.min(top, max()),
    set: (value) => {
      const previous = Math.min(top, max());
      top = Math.min(Math.max(0, Number(value) || 0), max());
      if (top !== previous) body.dispatchEvent(new win.Event('scroll'));
    },
  });
  return metrics;
}

function setup({ view = 'thinking', blocks = [['t1', 'p1']], reduced = false, metrics = [] } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="scroll">'
    + `<div class="chat-timeline" data-transcript-view="${view}"><article id="a"><div class="reasoning-row-stack">`
    + blocks.map(([id, key]) => block(id, key)).join('')
    + '</div></article></div></div></body>');
  const win = dom.window;
  const document = win.document;
  const clock = { t: 1000 };
  let frames = [];
  let timers = [];
  let enabled = true;
  const reducedMotionQuery = { matches: reduced };
  const follow = createReasoningLiveBoxFollow({
    isEnabled: () => enabled,
    reducedMotionQuery,
    requestFrame: (cb) => { frames.push(cb); return frames.length; },
    cancelFrame: (handle) => { frames[handle - 1] = null; },
    now: () => clock.t,
    setTimer: (fn, ms) => { const timer = { fn, at: clock.t + ms }; timers.push(timer); return timer; },
    clearTimer: (timer) => { timers = timers.filter((entry) => entry !== timer); },
  });
  const bodies = Array.from(document.querySelectorAll('.reasoning-row-panel-body'));
  const stubs = bodies.map((body, i) => stubBody(win, body, metrics[i] || { scrollHeight: 1000, clientHeight: 400 }));
  const timeline = document.querySelector('.chat-timeline');
  const harness = {
    dom, win, document, clock, follow, bodies, stubs, timeline, reducedMotionQuery,
    setEnabled(value) { enabled = value; },
    pendingFrames: () => frames.filter(Boolean).length,
    flushFrame(ts) {
      const queue = frames;
      frames = [];
      queue.forEach((cb) => { if (cb) cb(ts); });
    },
    runFrames(limit = 2000) {
      let ts = 5000;
      let count = 0;
      while (harness.pendingFrames() > 0 && count < limit) { harness.flushFrame(ts); ts += 16; count += 1; }
      return count;
    },
    advanceTimers(ms) {
      clock.t += ms;
      const due = timers.filter((entry) => entry.at <= clock.t);
      timers = timers.filter((entry) => entry.at > clock.t);
      due.forEach((entry) => entry.fn());
    },
    readerScroll(body, top) {
      body.dispatchEvent(new win.Event('wheel'));
      body.scrollTop = top;
    },
  };
  return harness;
}

function withCleanup(t, h) {
  t.after(() => { h.follow.dispose(); h.dom.window.close(); });
  return h;
}

test('live box: exports the contract constants', () => {
  assert.equal(LIVE_BOX_MARKER_ATTR, 'data-live-box');
  assert.equal(HAS_SCROLLED_CLASS, 'has-scrolled');
  assert.match(LIVE_BOX_BODY_SELECTOR, /data-transcript-view="answers"/);
  assert.equal(typeof isAnyReaderAway, 'function');
});

test('live box: attach stamps the marker and snaps to the bottom', (t) => {
  const h = withCleanup(t, setup());
  const [body] = h.bodies;
  h.follow.sync(h.timeline);
  assert.equal(body.getAttribute(LIVE_BOX_MARKER_ATTR), 'true');
  assert.equal(body.scrollTop, 600);
  assert.ok(body.classList.contains(HAS_SCROLLED_CLASS));
  h.runFrames();
  assert.equal(body.scrollTop, 600);
});

test('live box: an ancestor root also finds the live body', (t) => {
  const h = withCleanup(t, setup());
  h.follow.sync(h.document.body);
  assert.equal(h.bodies[0].getAttribute(LIVE_BOX_MARKER_ATTR), 'true');
});

test('live box: the chase steps by the damped alpha and settles within 1 px', (t) => {
  const h = withCleanup(t, setup());
  const [body] = h.bodies;
  h.follow.sync(h.timeline);
  h.runFrames();
  h.stubs[0].scrollHeight = 1050;
  h.follow.sync(h.timeline);
  h.flushFrame(10000);
  // remaining 50 <= 96: alpha = clamp(16/320, 0.04, 0.25) = 0.05; step max(2.5, 2).
  assert.equal(body.scrollTop, 602.5);
  h.runFrames();
  assert.equal(body.scrollTop, 650);
  assert.equal(h.pendingFrames(), 0);

  h.stubs[0].scrollHeight = 1650;
  h.follow.sync(h.timeline);
  h.flushFrame(20000);
  // remaining 600 > 96: alpha = clamp(16/120, 0.12, 0.45); step 80.
  assert.ok(Math.abs(body.scrollTop - 730) < 1e-9, `got ${body.scrollTop}`);
  h.runFrames();
  assert.equal(body.scrollTop, 1250);
});

test('live box: the chase speed is continuous across the 96 px lag threshold', (t) => {
  const stepFor = (lag) => {
    const h = withCleanup(t, setup());
    const [body] = h.bodies;
    h.follow.sync(h.timeline);
    h.runFrames();
    const before = body.scrollTop;
    h.stubs[0].scrollHeight = 1000 + lag;
    h.follow.sync(h.timeline);
    h.flushFrame(10000);
    return body.scrollTop - before;
  };
  // A hard switch stepped 4.8 px at 96 and 13.5 px at 101: a lurch-then-stall.
  const below = stepFor(96);
  const above = stepFor(101);
  assert.ok(Math.abs(above - below) < 1.5, `step jumped from ${below} to ${above}`);
  // Two lag spans out it is the full catch-up rate (16/120 of the lag).
  assert.ok(Math.abs(stepFor(192) - 192 * (16 / 120)) < 1e-9);
});

test('live box: reduced motion snaps instead of chasing', (t) => {
  const h = withCleanup(t, setup({ reduced: true }));
  const [body] = h.bodies;
  h.follow.sync(h.timeline);
  h.stubs[0].scrollHeight = 1300;
  h.follow.sync(h.timeline);
  h.flushFrame(10000);
  assert.equal(body.scrollTop, 900);
  assert.equal(h.pendingFrames(), 0);
});

test('live box: a reader scroll up past 24 px releases follow and a return near the bottom resumes', (t) => {
  const h = withCleanup(t, setup());
  const [body] = h.bodies;
  h.follow.sync(h.timeline);
  h.runFrames();
  assert.equal(isAnyReaderAway(), false);
  h.readerScroll(body, 560);
  assert.equal(isAnyReaderAway(), true);
  assert.deepEqual(capturePatchState(body), { hasScrolled: true, following: false });

  h.stubs[0].scrollHeight = 1100;
  h.follow.sync(h.timeline);
  h.runFrames();
  assert.equal(body.scrollTop, 560, 'a released box is not chased');

  h.clock.t += 1000;
  h.readerScroll(body, 697); // 3 px from the bottom (max 700)
  assert.equal(isAnyReaderAway(), false);
  h.stubs[0].scrollHeight = 1200;
  h.follow.sync(h.timeline);
  h.runFrames();
  assert.equal(body.scrollTop, 800);
});

test('live box: a reader scroll within 24 px holds without releasing', (t) => {
  const h = withCleanup(t, setup());
  const [body] = h.bodies;
  h.follow.sync(h.timeline);
  h.runFrames();
  h.readerScroll(body, 590);
  assert.equal(isAnyReaderAway(), false);
  h.follow.sync(h.timeline);
  h.flushFrame(10000);
  assert.equal(body.scrollTop, 590, 'the chase does not fight a starting gesture');
  assert.equal(h.pendingFrames(), 1, 'the chase reschedules');
  h.clock.t += 400;
  h.runFrames();
  assert.equal(body.scrollTop, 600);
  assert.equal(capturePatchState(body).following, true);
});

test('live box: programmatic writes never release, even with fresh reader intent', (t) => {
  const h = withCleanup(t, setup());
  const [body] = h.bodies;
  h.follow.sync(h.timeline);
  body.dispatchEvent(new h.win.Event('wheel'));
  h.stubs[0].scrollHeight = 3000;
  h.follow.sync(h.timeline);
  h.runFrames();
  assert.equal(body.scrollTop, 2600);
  assert.equal(isAnyReaderAway(), false);
  assert.equal(capturePatchState(body).following, true);
});

test('live box: a shrink while following does not release', (t) => {
  const h = withCleanup(t, setup());
  const [body] = h.bodies;
  h.follow.sync(h.timeline);
  h.runFrames();
  body.dispatchEvent(new h.win.Event('wheel'));
  h.stubs[0].scrollHeight = 700; // 32 KB elision drops early units: max 300
  body.dispatchEvent(new h.win.Event('scroll'));
  assert.equal(isAnyReaderAway(), false);
  h.stubs[0].scrollHeight = 760;
  h.follow.sync(h.timeline);
  h.runFrames();
  assert.equal(body.scrollTop, 360);
  assert.equal(capturePatchState(body).following, true);
});

test('live box: has-scrolled toggles and sync re-applies marker and class after a patch wipes them', (t) => {
  const h = withCleanup(t, setup({ metrics: [{ scrollHeight: 300, clientHeight: 400 }] }));
  const [body] = h.bodies;
  h.follow.sync(h.timeline);
  assert.equal(body.classList.contains(HAS_SCROLLED_CLASS), false);
  h.stubs[0].scrollHeight = 900;
  h.follow.sync(h.timeline);
  h.runFrames();
  assert.equal(body.scrollTop, 500);
  assert.equal(body.classList.contains(HAS_SCROLLED_CLASS), true);

  body.className = 'reasoning-row-panel-body';
  body.removeAttribute(LIVE_BOX_MARKER_ATTR);
  h.follow.sync(h.timeline);
  assert.equal(body.getAttribute(LIVE_BOX_MARKER_ATTR), 'true');
  assert.equal(body.classList.contains(HAS_SCROLLED_CLASS), true);

  h.clock.t += 1000;
  h.readerScroll(body, 0);
  assert.equal(body.classList.contains(HAS_SCROLLED_CLASS), false);
});

test('live box: capture/restore round-trips and settled snaps to the bottom', (t) => {
  const h = withCleanup(t, setup());
  const [body] = h.bodies;
  assert.equal(capturePatchState(body), null);
  restorePatchState(body, null, { settled: true });
  assert.equal(body.hasAttribute(LIVE_BOX_MARKER_ATTR), false);

  h.follow.sync(h.timeline);
  h.runFrames();
  const captured = capturePatchState(body);
  assert.deepEqual(captured, { hasScrolled: true, following: true });
  body.className = 'reasoning-row-panel-body';
  body.removeAttribute(LIVE_BOX_MARKER_ATTR);
  restorePatchState(body, captured, { settled: false });
  assert.equal(body.getAttribute(LIVE_BOX_MARKER_ATTR), 'true');
  assert.equal(body.classList.contains(HAS_SCROLLED_CLASS), true);
  assert.equal(body.scrollTop, 600);

  body.dispatchEvent(new h.win.Event('wheel'));
  h.stubs[0].scrollHeight = 5000; // the settled body carries the full uncapped text
  restorePatchState(body, captured, { settled: true });
  assert.equal(body.scrollTop, 4600);
  assert.equal(isAnyReaderAway(), false);
});

test('live box: a collapsing panel keeps the marker until transitionend(max-height)', (t) => {
  const h = withCleanup(t, setup());
  const [body] = h.bodies;
  const panel = body.closest('.reasoning-row-panel');
  h.follow.sync(h.timeline);
  h.runFrames();
  panel.closest('.reasoning-row-block').setAttribute('data-reasoning-status', 'complete');
  panel.setAttribute('data-collapsing', 'true');
  h.follow.sync(h.timeline);
  assert.equal(body.getAttribute(LIVE_BOX_MARKER_ATTR), 'true');
  assert.equal(body.classList.contains(HAS_SCROLLED_CLASS), true);

  const end = (propertyName, target = panel) => {
    const event = new h.win.Event('transitionend', { bubbles: true });
    Object.defineProperty(event, 'propertyName', { value: propertyName });
    target.dispatchEvent(event);
  };
  end('opacity');
  end('max-height', body);
  assert.equal(body.getAttribute(LIVE_BOX_MARKER_ATTR), 'true', 'other transitions are ignored');
  end('max-height'); // still collapsing: re-armed
  assert.equal(body.getAttribute(LIVE_BOX_MARKER_ATTR), 'true');
  panel.removeAttribute('data-collapsing');
  panel.classList.remove('expanded');
  end('max-height');
  assert.equal(body.hasAttribute(LIVE_BOX_MARKER_ATTR), false);
  assert.equal(body.classList.contains(HAS_SCROLLED_CLASS), false);
  assert.equal(capturePatchState(body), null);
});

test('live box: an earlier phase that settles open keeps its cap while a later phase streams', (t) => {
  // Found live (2026-11-02): a long first phase un-capped mid-turn grew the timeline by ~13k px in one frame.
  const h = withCleanup(t, setup({ blocks: [['t1', 'p1'], ['t1', 'p2']] }));
  const [first, second] = h.bodies;
  h.follow.sync(h.timeline);
  h.runFrames();
  first.closest('.reasoning-row-block').setAttribute('data-reasoning-status', 'complete');
  h.follow.sync(h.timeline);
  assert.equal(first.getAttribute(LIVE_BOX_MARKER_ATTR), 'true', 'settled open phase keeps the marker');
  assert.notEqual(capturePatchState(first), null);
  h.stubs[0].scrollHeight = 1400; // settled body is static: no chase is scheduled for it
  h.follow.sync(h.timeline);
  h.runFrames();
  assert.equal(first.scrollTop, 600);
  h.readerScroll(first, 100); // the reader can still scroll inside it
  assert.equal(first.scrollTop, 100);
  assert.equal(second.getAttribute(LIVE_BOX_MARKER_ATTR), 'true');

  // Turn ends with the panel left open: the cap releases.
  second.closest('.reasoning-row-block').setAttribute('data-reasoning-status', 'complete');
  h.follow.sync(h.timeline);
  assert.equal(first.hasAttribute(LIVE_BOX_MARKER_ATTR), false);
  assert.equal(second.hasAttribute(LIVE_BOX_MARKER_ATTR), false);
  assert.equal(isAnyReaderAway(), false);
});

test('live box: a settled open phase rebuilt by a full render mid-turn is capped and shows its end', (t) => {
  // The live phase split replaces the article: the old held body disconnects, the rebuilt settled one must attach.
  const h = withCleanup(t, setup({ blocks: [['t1', 'p1']] }));
  h.follow.sync(h.timeline);
  h.runFrames();
  const stack = h.document.querySelector('.reasoning-row-stack');
  stack.innerHTML = block('t1', 'p1', 'complete') + block('t1', 'p2');
  const [rebuilt, live] = Array.from(stack.querySelectorAll('.reasoning-row-panel-body'));
  stubBody(h.win, rebuilt, { scrollHeight: 20000, clientHeight: 400 });
  stubBody(h.win, live, { scrollHeight: 100, clientHeight: 100 });
  h.follow.sync(h.timeline);
  assert.equal(rebuilt.getAttribute(LIVE_BOX_MARKER_ATTR), 'true');
  assert.equal(rebuilt.scrollTop, 19600);
  assert.equal(live.getAttribute(LIVE_BOX_MARKER_ATTR), 'true');
  assert.equal(h.bodies[0].isConnected, false);
});

test('live box: a phase that settles open keeps its cap while its turn is still in flight', (t) => {
  // Found live: phase one settled, nothing streamed for ~3 s, then phase two began.
  const h = withCleanup(t, setup());
  const [body] = h.bodies;
  const article = h.document.getElementById('a');
  article.className = 'chat-entry assistant pending';
  h.follow.sync(h.timeline);
  h.runFrames();
  body.closest('.reasoning-row-block').setAttribute('data-reasoning-status', 'complete');
  h.follow.sync(h.timeline);
  assert.equal(body.getAttribute(LIVE_BOX_MARKER_ATTR), 'true');
  article.classList.remove('pending');
  h.follow.sync(h.timeline);
  assert.equal(body.hasAttribute(LIVE_BOX_MARKER_ATTR), false);
});

test('live box: a live turn row list keeps a settled open phase capped through a tool gap', (t) => {
  // A tool gap has no streaming message and no pending article; the row list carries data-turn-live.
  const h = withCleanup(t, setup());
  const [body] = h.bodies;
  const stack = h.document.querySelector('.reasoning-row-stack');
  const list = h.document.createElement('div');
  list.className = 'turn-row-list';
  list.setAttribute('data-turn-live', 'true');
  stack.replaceWith(list);
  list.appendChild(stack);
  h.follow.sync(h.timeline);
  body.closest('.reasoning-row-block').setAttribute('data-reasoning-status', 'complete');
  h.follow.sync(h.timeline);
  assert.equal(body.getAttribute(LIVE_BOX_MARKER_ATTR), 'true');
  list.removeAttribute('data-turn-live');
  h.follow.sync(h.timeline);
  assert.equal(body.hasAttribute(LIVE_BOX_MARKER_ATTR), false);
});

test('live box: a marker cloned onto a body nobody holds is adopted or dropped', (t) => {
  const h = withCleanup(t, setup({ blocks: [] }));
  const stack = h.document.querySelector('.reasoning-row-stack');
  stack.innerHTML = block('t1', 'p1', 'complete') + block('t1', 'p2', 'complete');
  const next = h.document.createElement('article');
  next.innerHTML = `<div class="reasoning-row-stack">${block('t2', 'p1', 'complete')}</div>`;
  h.timeline.appendChild(next);
  const [stale, collapsing, live] = Array.from(h.timeline.querySelectorAll('.reasoning-row-panel-body'));
  [stale, collapsing, live].forEach((body) => { body.setAttribute(LIVE_BOX_MARKER_ATTR, 'true'); body.classList.add(HAS_SCROLLED_CLASS); });
  collapsing.closest('.reasoning-row-panel').setAttribute('data-collapsing', 'true');
  live.closest('.reasoning-row-block').setAttribute('data-reasoning-status', 'streaming');
  stubBody(h.win, live, { scrollHeight: 900, clientHeight: 400 });
  h.follow.sync(h.timeline);
  assert.equal(stale.hasAttribute(LIVE_BOX_MARKER_ATTR), false, 'a finished settled body loses a cloned marker');
  assert.equal(stale.classList.contains(HAS_SCROLLED_CLASS), false);
  assert.equal(collapsing.getAttribute(LIVE_BOX_MARKER_ATTR), 'true', 'a collapsing panel keeps its cap into the collapse');
  assert.equal(live.getAttribute(LIVE_BOX_MARKER_ATTR), 'true');
  assert.notEqual(capturePatchState(live), null, 'a candidate with a cloned marker is adopted');
});

test('live box: a finished turn never caps its settled open phases', (t) => {
  const h = withCleanup(t, setup({ blocks: [] }));
  h.document.querySelector('.reasoning-row-stack').innerHTML = block('t1', 'p1', 'complete') + block('t1', 'p2', 'complete');
  h.follow.sync(h.timeline);
  assert.equal(h.document.querySelectorAll(`[${LIVE_BOX_MARKER_ATTR}]`).length, 0);
});

test('live box: the 700 ms timer detaches a collapsed panel without transitionend', (t) => {
  const h = withCleanup(t, setup());
  const [body] = h.bodies;
  const panel = body.closest('.reasoning-row-panel');
  h.follow.sync(h.timeline);
  panel.closest('.reasoning-row-block').setAttribute('data-reasoning-status', 'complete');
  panel.setAttribute('data-collapsing', 'true');
  h.follow.sync(h.timeline);
  h.follow.sync(h.timeline);
  h.advanceTimers(699);
  assert.equal(body.getAttribute(LIVE_BOX_MARKER_ATTR), 'true');
  panel.removeAttribute('data-collapsing');
  h.advanceTimers(1);
  assert.equal(body.hasAttribute(LIVE_BOX_MARKER_ATTR), false);
});

test('live box: isEnabled() false detaches everything', (t) => {
  const h = withCleanup(t, setup({ blocks: [['t1', 'p1'], ['t1', 'p2']] }));
  h.follow.sync(h.timeline);
  h.readerScroll(h.bodies[1], 100);
  assert.equal(isAnyReaderAway(), true);
  h.setEnabled(false);
  h.follow.sync(h.timeline);
  h.bodies.forEach((body) => {
    assert.equal(body.hasAttribute(LIVE_BOX_MARKER_ATTR), false);
    assert.equal(body.classList.contains(HAS_SCROLLED_CLASS), false);
    assert.equal(capturePatchState(body), null);
  });
  assert.equal(isAnyReaderAway(), false);
  h.clock.t += 1000;
  h.readerScroll(h.bodies[0], 200);
  assert.equal(h.bodies[0].classList.contains(HAS_SCROLLED_CLASS), false, 'listeners are removed');
});

test('live box: a body in an Answers-view timeline is never attached', (t) => {
  const h = withCleanup(t, setup({ view: 'answers' }));
  h.follow.sync(h.timeline);
  h.follow.sync(h.document.body);
  assert.equal(h.bodies[0].hasAttribute(LIVE_BOX_MARKER_ATTR), false);
  assert.equal(h.bodies[0].scrollTop, 0);
  assert.equal(capturePatchState(h.bodies[0]), null);
});

test('live box: identity carry-over restores release and the reader position on a rebuilt node', (t) => {
  const h = withCleanup(t, setup());
  const [body] = h.bodies;
  h.follow.sync(h.timeline);
  h.runFrames();
  h.readerScroll(body, 500); // 100 px from the bottom
  h.clock.t += 1000;
  h.readerScroll(body, 480); // keeps tracking the reader's position while released
  assert.equal(isAnyReaderAway(), true);

  h.document.getElementById('a').innerHTML = block('t1', 'p1');
  assert.equal(body.isConnected, false);
  const rebuilt = h.document.querySelector('.reasoning-row-panel-body');
  stubBody(h.win, rebuilt, { scrollHeight: 1200, clientHeight: 400 });
  h.follow.sync(h.timeline);
  assert.equal(rebuilt.getAttribute(LIVE_BOX_MARKER_ATTR), 'true');
  // The text above a released reader is frozen while the box grows below it, so the
  // rebuilt node keeps the reader's offset from the top, not from the grown bottom.
  assert.equal(rebuilt.scrollTop, 480);
  assert.deepEqual(capturePatchState(rebuilt), { hasScrolled: true, following: false });
  assert.equal(isAnyReaderAway(), true);
  assert.equal(body.hasAttribute(LIVE_BOX_MARKER_ATTR), true, 'a dropped disconnected body gets no DOM writes');

  // The record is consumed: a second rebuild while following snaps to the bottom.
  h.clock.t += 1000;
  h.readerScroll(rebuilt, 800);
  h.document.getElementById('a').innerHTML = block('t1', 'p1');
  const third = h.document.querySelector('.reasoning-row-panel-body');
  stubBody(h.win, third, { scrollHeight: 1200, clientHeight: 400 });
  h.follow.sync(h.timeline);
  assert.equal(third.scrollTop, 800);
  assert.equal(capturePatchState(third).following, true);
});

test('live box: dispose detaches every held body and cancels the frame loop', (t) => {
  const h = withCleanup(t, setup({ blocks: [['t1', 'p1'], ['t2', 'p1']] }));
  h.follow.sync(h.timeline);
  h.stubs[0].scrollHeight = 2000;
  h.follow.sync(h.timeline);
  assert.ok(h.pendingFrames() > 0);
  h.follow.dispose();
  assert.equal(h.pendingFrames(), 0);
  h.bodies.forEach((body) => {
    assert.equal(body.hasAttribute(LIVE_BOX_MARKER_ATTR), false);
    assert.equal(capturePatchState(body), null);
  });
});

test('live box: a held pointer (slow scrollbar drag) holds the chase and releases past 24 px', (t) => {
  const h = withCleanup(t, setup());
  const [body] = h.bodies;
  h.follow.sync(h.timeline);
  h.runFrames();
  body.dispatchEvent(new h.win.Event('pointerdown'));
  h.clock.t += 2000; // a pause far past the 300 ms wheel window
  body.scrollTop = body.scrollTop - 30;
  body.dispatchEvent(new h.win.Event('scroll'));
  assert.equal(isAnyReaderAway(), true, 'released while the pointer is still down');
  h.document.dispatchEvent(new h.win.Event('pointerup'));
  assert.equal(capturePatchState(body).following, false);
});
