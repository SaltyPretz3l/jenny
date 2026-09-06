const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

// Scroll-program W0 red suite: this module is Wave 1a's deliverable — the single
// reveal path that replaces the three duplicate implementations and every raw
// scrollIntoView fallback (citation-jump, search-overlay, active-turn,
// unread-orientation). Red today because the module does not exist yet.
const {
  createViewportRevealUtils,
} = require('../renderer/shell/renderer-viewport-reveal-utils.js');

function buildHarness(options = {}) {
  const dom = new JSDOM(
    '<!doctype html><html><body>'
      + '<div id="chatTimeline">'
      + '<details id="wrap"><summary>tools</summary>'
      + '<article class="chat-entry" data-message-id="m1" tabindex="-1">'
      + '<div class="chat-row" data-row-id="row-1" tabindex="-1">row target</div>'
      + '</article>'
      + '</details>'
      + '<article class="chat-entry" data-message-id="m2" data-virtualized="true" tabindex="-1"></article>'
      + '</div>'
      + '</body></html>'
  );
  const scrollCalls = [];
  dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView(scrollOptions) {
    scrollCalls.push({
      target: this.getAttribute('data-row-id') || this.getAttribute('data-message-id') || this.id || '',
      options: scrollOptions,
    });
  };
  let reducedMotion = options.reducedMotion === true;
  const state = { ui: { followLatest: true } };
  const followCalls = [];
  const navCalls = [];
  const coordinator = {
    noteExplicitNavigation(navOptions) { navCalls.push(navOptions); },
  };
  const reveal = createViewportRevealUtils({
    state,
    setFollowLatest(value) {
      followCalls.push(Boolean(value));
      state.ui.followLatest = Boolean(value);
    },
    getScrollCoordinator() { return coordinator; },
    reducedMotionQuery: { get matches() { return reducedMotion; } },
  });
  return {
    dom,
    reveal,
    state,
    followCalls,
    navCalls,
    scrollCalls,
    setReducedMotion(value) { reducedMotion = Boolean(value); },
  };
}

test('revealElement scrolls smooth to center by default and releases follow', () => {
  const harness = buildHarness();
  const row = harness.dom.window.document.querySelector('[data-row-id="row-1"]');

  const revealed = harness.reveal.revealElement(row, { reason: 'citation_jump' });

  assert.equal(revealed, true);
  assert.equal(harness.scrollCalls.length, 1);
  assert.equal(harness.scrollCalls[0].target, 'row-1');
  assert.equal(harness.scrollCalls[0].options.behavior, 'smooth');
  assert.equal(harness.scrollCalls[0].options.block, 'center');
  assert.equal(harness.state.ui.followLatest, false, 'followLatest defaults to false: navigation releases follow');
  assert.deepEqual(harness.followCalls, [false]);
  assert.deepEqual(harness.navCalls, [{ followLatest: false, reason: 'citation_jump' }]);
});

test('revealElement is instant under reduced motion', () => {
  const harness = buildHarness({ reducedMotion: true });
  const row = harness.dom.window.document.querySelector('[data-row-id="row-1"]');

  harness.reveal.revealElement(row, { reason: 'search_nav' });

  assert.equal(harness.scrollCalls.length, 1);
  assert.equal(harness.scrollCalls[0].options.behavior, 'auto');
});

test('revealElement opens closed details ancestors before scrolling', () => {
  const harness = buildHarness();
  const wrap = harness.dom.window.document.getElementById('wrap');
  wrap.open = false;
  const row = harness.dom.window.document.querySelector('[data-row-id="row-1"]');

  harness.reveal.revealElement(row, { reason: 'citation_jump' });

  assert.equal(wrap.open, true, 'a target inside a collapsed details must be revealed');
  assert.equal(harness.scrollCalls.length, 1);
});

test('revealElement with followLatest true keeps follow and still notes the navigation', () => {
  const harness = buildHarness();
  const row = harness.dom.window.document.querySelector('[data-row-id="row-1"]');

  harness.reveal.revealElement(row, { followLatest: true, reason: 'unread_jump' });

  assert.equal(harness.state.ui.followLatest, true);
  assert.deepEqual(harness.followCalls, [true]);
  assert.deepEqual(harness.navCalls, [{ followLatest: true, reason: 'unread_jump' }]);
});

test('reveal of a missing target returns false without scrolling, releasing, or noting', () => {
  const harness = buildHarness();

  assert.equal(harness.reveal.revealElement(null, { reason: 'citation_jump' }), false);
  assert.equal(harness.scrollCalls.length, 0);
  assert.equal(harness.state.ui.followLatest, true);
  assert.deepEqual(harness.followCalls, []);
  assert.deepEqual(harness.navCalls, []);
});
