'use strict';

// UIUX-008 — Timeline virtualization serializes live DOM and loses user
// state and behavior. renderer-chat-timeline-virtualizer.test.js exercises
// the module against synthetic (jsdom-free) fake DOM doubles, which cannot
// reproduce the actual bug: a fake `.innerHTML` is a plain string field, so
// it can never demonstrate the difference between a live DOM *property*
// (input.value, .checked, listeners) and a serialized *attribute*. This
// sibling suite uses real jsdom elements — kept separate to respect the
// 1015-line file-size cap and to keep the fast synthetic-double suite
// jsdom-free.
//
// Fix under test: rows whose subtree matches LIVE_STATE_SELECTOR (form
// controls, media, contenteditable, or the [data-virtualizer-pin-live]
// escape hatch) are unmounted by detaching their REAL child nodes into a
// DocumentFragment (appendChild preserves identity/listeners/live
// properties) instead of the ordinary innerHTML string round trip. See
// renderer/chat/renderer-chat-timeline-virtualizer.js's module header.

const { JSDOM } = require('jsdom');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTimelineVirtualizer,
} = require('../renderer/chat/renderer-chat-timeline-virtualizer');

const THRESHOLD = 80;

// ---- Fake IntersectionObserver, wired onto the jsdom window (jsdom ships
// no IO implementation) ------------------------------------------------------

function installFakeIntersectionObserver(win) {
  const observers = [];
  class FakeIntersectionObserver {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options || {};
      this.observed = new Set();
      this.disconnected = false;
      observers.push(this);
    }
    observe(target) { this.observed.add(target); }
    unobserve(target) { this.observed.delete(target); }
    disconnect() { this.disconnected = true; this.observed.clear(); }
    _fire(records) { if (!this.disconnected) this.callback(records); }
  }
  win.IntersectionObserver = FakeIntersectionObserver;
  return observers;
}

// ---- Real jsdom timeline fixture -------------------------------------------

// jsdom performs no layout, so every element's getBoundingClientRect()
// reports height 0 by default — the virtualizer treats a 0-height read as
// "not ready to measure" and refuses to unmount (see measureHeight /
// onIntersect's `height <= 0` guard). Stub a fixed non-zero rect on every
// `.chat-entry` article so the unmount path actually engages.
function stubHeights(doc, height) {
  const entries = doc.querySelectorAll('.chat-entry');
  entries.forEach((el) => {
    el.getBoundingClientRect = function stubbedRect() {
      return { height, top: 0, bottom: height, left: 0, right: 100, width: 100 };
    };
  });
}

function buildTimeline(count, decorate) {
  const dom = new JSDOM('<!doctype html><html><body><div class="chat-thread-scroll"><div class="chat-timeline"></div></div></body></html>', {
    pretendToBeVisual: true,
  });
  const doc = dom.window.document;
  const chatTimeline = doc.querySelector('.chat-timeline');
  const chatThreadScroll = doc.querySelector('.chat-thread-scroll');
  for (let i = 0; i < count; i += 1) {
    const article = doc.createElement('article');
    article.className = 'chat-entry';
    article.setAttribute('data-message-id', `m${i}`);
    article.setAttribute('data-message-role', i % 2 === 0 ? 'user' : 'assistant');
    article.setAttribute('tabindex', '-1');
    const bubble = doc.createElement('div');
    bubble.className = 'chat-bubble-markdown';
    bubble.textContent = `payload-${i}`;
    article.appendChild(bubble);
    chatTimeline.appendChild(article);
  }
  if (typeof decorate === 'function') decorate(doc, chatTimeline);
  stubHeights(doc, 400);
  const observers = installFakeIntersectionObserver(dom.window);
  return { dom, doc, chatTimeline, chatThreadScroll, observers };
}

function createVirtualizer(env, extraOptions) {
  const syncWindow = {
    IntersectionObserver: env.dom.window.IntersectionObserver,
    MutationObserver: env.dom.window.MutationObserver,
    performance: env.dom.window.performance,
    addEventListener: env.dom.window.addEventListener.bind(env.dom.window),
    removeEventListener: env.dom.window.removeEventListener.bind(env.dom.window),
    setTimeout: env.dom.window.setTimeout.bind(env.dom.window),
    clearTimeout: env.dom.window.clearTimeout.bind(env.dom.window),
  };
  const options = Object.assign({
    chatTimeline: env.chatTimeline,
    chatThreadScroll: env.chatThreadScroll,
    document: env.doc,
    // Live-state tests are about identity retention, not frame batching. A
    // window facade without rAF keeps their observer probes deterministic.
    window: syncWindow,
  }, extraOptions || {});
  return createTimelineVirtualizer(options);
}

function fireLeave(env, target) {
  env.observers[env.observers.length - 1]._fire([{ target, isIntersecting: false }]);
}

function fireEnter(env, target) {
  env.observers[env.observers.length - 1]._fire([{ target, isIntersecting: true }]);
}

// ---- (a) blurred inline-edit textarea: value + listener survive -----------

test('UIUX-008a: a blurred inline-edit textarea keeps its live value and listener across an offscreen/return cycle', (t) => {
  let editEntry;
  let textarea;
  const env = buildTimeline(THRESHOLD + 5, (doc, timeline) => {
    editEntry = timeline.querySelectorAll('.chat-entry')[10];
    textarea = doc.createElement('textarea');
    textarea.setAttribute('data-edit-target-message-id', 'm10');
    textarea.textContent = 'old';
    editEntry.appendChild(textarea);
  });
  const v = createVirtualizer(env);
  t.after(() => v.dispose());

  let inputFireCount = 0;
  textarea.addEventListener('input', () => { inputFireCount += 1; });

  // User types (live property write — NOT an attribute change) then blurs
  // without committing/cancelling the edit (state.ui.editingMessageId
  // stays set at the app layer; the virtualizer only sees the DOM).
  textarea.value = 'new draft';
  textarea.focus();
  textarea.blur();
  assert.equal(env.doc.activeElement, env.doc.body, 'textarea is no longer focused after blur');

  v.rebuild();
  fireLeave(env, editEntry);
  assert.equal(editEntry.getAttribute('data-virtualized'), null, 'live edit rows remain mounted offscreen');
  assert.strictEqual(editEntry.querySelector('textarea'), textarea);

  fireEnter(env, editEntry);
  assert.equal(editEntry.getAttribute('data-virtualized'), null);
  const restored = editEntry.querySelector('[data-edit-target-message-id="m10"]');
  assert.ok(restored, 'edit textarea reappears on remount');
  assert.equal(restored, textarea, 'the SAME textarea node is reattached, not a fresh reparse');
  assert.equal(restored.value, 'new draft', 'live uncommitted draft value survives the round trip');

  restored.dispatchEvent(new env.dom.window.Event('input'));
  assert.equal(inputFireCount, 1, 'the directly-bound input listener still fires after the cycle');
});

// ---- (b) checkbox / "Other" input state ------------------------------------

test('UIUX-008b: checkbox and interactive "Other" input state survive an offscreen/return cycle', (t) => {
  let entry;
  let checkbox;
  let otherInput;
  const env = buildTimeline(THRESHOLD + 5, (doc, timeline) => {
    entry = timeline.querySelectorAll('.chat-entry')[11];
    checkbox = doc.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.setAttribute('data-question-option', 'opt-1');
    entry.appendChild(checkbox);
    otherInput = doc.createElement('input');
    otherInput.type = 'text';
    otherInput.setAttribute('data-interactive-other-input', 'true');
    otherInput.value = 'initial';
    entry.appendChild(otherInput);
  });
  const v = createVirtualizer(env);
  t.after(() => v.dispose());

  checkbox.checked = true;
  otherInput.value = 'user typed this';

  v.rebuild();
  fireLeave(env, entry);
  assert.equal(entry.getAttribute('data-virtualized'), null, 'interactive state pins the row');

  fireEnter(env, entry);
  const restoredCheckbox = entry.querySelector('[data-question-option="opt-1"]');
  const restoredOther = entry.querySelector('[data-interactive-other-input]');
  assert.equal(restoredCheckbox, checkbox, 'checkbox node identity preserved');
  assert.equal(restoredCheckbox.checked, true, 'checkbox checked state survives');
  assert.equal(restoredOther, otherInput, 'Other input node identity preserved');
  assert.equal(restoredOther.value, 'user typed this', 'Other input live value survives');
});

// ---- (c) a directly-bound listener on a non-form element still fires ------

test('UIUX-008c: a row opted into live retention keeps a directly-bound listener firing after a cycle', (t) => {
  let entry;
  let liveEl;
  const env = buildTimeline(THRESHOLD + 5, (doc, timeline) => {
    entry = timeline.querySelectorAll('.chat-entry')[12];
    liveEl = doc.createElement('button');
    liveEl.setAttribute('data-virtualizer-pin-live', 'true');
    liveEl.textContent = 'Play';
    entry.appendChild(liveEl);
  });
  const v = createVirtualizer(env);
  t.after(() => v.dispose());

  let clicks = 0;
  liveEl.addEventListener('click', () => { clicks += 1; });

  v.rebuild();
  fireLeave(env, entry);
  fireEnter(env, entry);

  const restored = entry.querySelector('[data-virtualizer-pin-live]');
  assert.equal(restored, liveEl, 'opted-in element identity preserved across the cycle');
  restored.dispatchEvent(new env.dom.window.Event('click'));
  assert.equal(clicks, 1, 'directly-bound listener still fires after the round trip');
});

// ---- (d) focus/selection preservation for the focused row -----------------

test('UIUX-008d: the row containing document.activeElement never virtualizes, preserving focus and selection', (t) => {
  let entry;
  let textarea;
  const env = buildTimeline(THRESHOLD + 5, (doc, timeline) => {
    entry = timeline.querySelectorAll('.chat-entry')[13];
    textarea = doc.createElement('textarea');
    textarea.value = 'some editable text';
    entry.appendChild(textarea);
  });
  const v = createVirtualizer(env);
  t.after(() => v.dispose());

  textarea.focus();
  textarea.setSelectionRange(2, 6);
  assert.equal(env.doc.activeElement, textarea);

  v.rebuild();
  fireLeave(env, entry);

  assert.equal(entry.getAttribute('data-virtualized'), null, 'focused row is pinned, never virtualized');
  assert.equal(env.doc.activeElement, textarea, 'focus is untouched');
  assert.equal(textarea.selectionStart, 2, 'selection start preserved');
  assert.equal(textarea.selectionEnd, 6, 'selection end preserved');
});

test('R2: live-state rows stay mounted and are reported as explicit pin exemptions', (t) => {
  const total = THRESHOLD + 40;
  const statefulIndexes = [];
  const env = buildTimeline(total, (doc, timeline) => {
    const entries = timeline.querySelectorAll('.chat-entry');
    for (let i = 20; i < 50; i += 1) {
      const input = doc.createElement('input');
      input.type = 'text';
      input.value = `state-${i}`;
      entries[i].appendChild(input);
      statefulIndexes.push(i);
    }
  });
  const v = createVirtualizer(env);
  t.after(() => v.dispose());
  v.rebuild();

  const entries = env.doc.querySelectorAll('.chat-entry');
  const targets = statefulIndexes.map((i) => entries[i]);

  // Unmount all 30 stateful rows in one batch.
  env.observers[env.observers.length - 1]._fire(
    targets.map((target) => ({ target, isIntersecting: false }))
  );

  const budgetStats = v._internals.getBudgetStats();
  assert.equal(budgetStats.statefulPinnedEntries, targets.length);
  assert.equal(budgetStats.pinnedExemptions.liveState, targets.length);

  const firstRetainedTarget = targets[0];
  assert.equal(firstRetainedTarget.getAttribute('data-virtualized'), null);
  fireEnter(env, firstRetainedTarget);
  assert.ok(firstRetainedTarget.querySelector('input'), 'retained row remounts with its live node intact');
  const overflowTarget = targets[targets.length - 1];
  assert.equal(overflowTarget.getAttribute('data-virtualized'), null, 'every stateful row remains mounted');

  const cyclingTarget = targets[targets.length - 1];
  for (let cycle = 0; cycle < 5; cycle += 1) {
    fireLeave(env, cyclingTarget);
    fireEnter(env, cyclingTarget);
  }
  assert.equal(cyclingTarget.querySelectorAll('input').length, 1, 'no duplicated nodes after repeated cycles');
});

// ---- Non-stateful rows are unaffected (selective retention) ---------------

test('UIUX-008: a plain markdown row (no form/media/live-listener content) still uses the ordinary string retention path', (t) => {
  const env = buildTimeline(THRESHOLD + 5);
  const v = createVirtualizer(env);
  t.after(() => v.dispose());
  v.rebuild();
  const entry = env.doc.querySelectorAll('.chat-entry')[20];
  fireLeave(env, entry);
  assert.equal(v._internals.getRetentionMode(entry), 'string', 'plain rows are not admitted to the live-state cache');
  fireEnter(env, entry);
  assert.match(entry.innerHTML, /payload-20/);
});

test('R2: serialized virtualized markup is capped and older rows rebuild from canonical markup', (t) => {
  const env = buildTimeline(THRESHOLD + 200);
  let rebuildCalls = 0;
  const v = createVirtualizer(env, {
    requestEntryMarkup(entryEl) {
      rebuildCalls += 1;
      return `<div class="chat-bubble-markdown">rebuilt-${entryEl.dataset.messageId}</div>`;
    },
  });
  t.after(() => v.dispose());
  v.rebuild();
  const entries = Array.from(env.doc.querySelectorAll('.chat-entry'));
  env.observers[env.observers.length - 1]._fire(
    entries.map((target) => ({ target, isIntersecting: false }))
  );

  const stats = v._internals.getBudgetStats();
  assert.equal(stats.materializedArticles, 0);
  assert.equal(stats.serializedMarkupEntries, stats.serializedMarkupCap);
  assert.equal(v._internals.getRetentionMode(entries[0]), 'rebuild');

  fireEnter(env, entries[0]);
  assert.equal(rebuildCalls, 1);
  assert.match(entries[0].textContent, /rebuilt-m0/);
  assert.equal(v._internals.getBudgetStats().rebuildFailureCount, 0);
});

test('R2: approval rows remain mounted when they leave the virtualizer window', (t) => {
  let approvalEntry;
  const env = buildTimeline(THRESHOLD + 5, (doc, timeline) => {
    approvalEntry = timeline.querySelectorAll('.chat-entry')[15];
    const approval = doc.createElement('div');
    approval.className = 'approval-gap-row';
    approvalEntry.appendChild(approval);
  });
  const v = createVirtualizer(env);
  t.after(() => v.dispose());
  v.rebuild();
  fireLeave(env, approvalEntry);
  assert.equal(approvalEntry.getAttribute('data-virtualized'), null);
});

test('R2 rollback: bounds disabled degrades to a fully mounted timeline', (t) => {
  const env = buildTimeline(THRESHOLD + 200);
  let rebuildCalls = 0;
  const v = createVirtualizer(env, {
    boundsEnabled: false,
    requestEntryMarkup() { rebuildCalls += 1; return '<div>unexpected</div>'; },
  });
  t.after(() => v.dispose());
  v.rebuild();
  const entries = Array.from(env.doc.querySelectorAll('.chat-entry'));
  assert.equal(env.observers.length, 0);
  assert.equal(v._internals.getStrategy(), 'none');
  assert.equal(v._internals.getRetentionMode(entries[0]), null);
  assert.equal(rebuildCalls, 0);
  assert.match(entries[0].textContent, /payload-0/);
});
