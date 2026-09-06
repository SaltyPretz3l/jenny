'use strict';

/* Sibling of tests/renderer-chat-scroll-coordinator.test.js — split out because
   that file sits near the 600-line test-size ratchet. Scroll-program W2a: the
   coordinator owns the timeline-mutation signal (a private childList/subtree
   MutationObserver bumping a content generation, following the established
   private-observer pattern) so detached frames reuse the anchor registry's row
   collection instead of re-scanning the DOM, and stats publishing mutates one
   stable object instead of reallocating per frame. */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createChatScrollCoordinator,
} = require('../renderer/chat/renderer-chat-scroll-coordinator');

function createFakeMutationObserverClass(instances) {
  return class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.observed = [];
      this.disconnected = false;
      instances.push(this);
    }

    observe(target, options) {
      this.observed.push({ target, options });
    }

    disconnect() {
      this.disconnected = true;
    }

    fire(records) {
      this.callback(records || [], this);
    }
  };
}

function createPerfHarness({ mutationObserver = true } = {}) {
  let clock = 0;
  const frames = [];
  const observerInstances = [];
  const state = { ui: { followLatest: false } };
  const entryCounts = { entries: 0 };
  let entryTop = 480;
  const entry = {
    getAttribute(name) { return name === 'data-message-id' ? 'message-anchor' : null; },
    closest: () => null,
    getBoundingClientRect() {
      const top = entryTop - scrollContainer.scrollTop;
      return { top, bottom: top + 80, height: 80 };
    },
  };
  const scrollContainer = {
    scrollTop: 500,
    scrollHeight: 2400,
    clientHeight: 400,
    getBoundingClientRect() { return { top: 0, bottom: 400, height: 400 }; },
    addEventListener() {},
    removeEventListener() {},
  };
  const timeline = {
    querySelectorAll(selector) {
      if (selector === '.chat-entry[data-message-id]') {
        entryCounts.entries += 1;
        return [entry];
      }
      return [];
    },
  };
  const win = {
    performance: { now: () => clock },
    ...(mutationObserver
      ? { MutationObserver: createFakeMutationObserverClass(observerInstances) }
      : {}),
  };
  const coordinator = createChatScrollCoordinator({
    state,
    scrollContainer,
    timelineContainer: timeline,
    window: win,
    requestFrame(callback) { frames.push(callback); return frames.length; },
    cancelFrame() {},
  });
  return {
    coordinator,
    entryCounts,
    frames,
    observerInstances,
    scrollContainer,
    state,
    timeline,
    runFrame() {
      coordinator.scheduleFrame();
      clock += 16;
      return frames.shift()(clock);
    },
    growEntry(px) { entryTop += px; },
  };
}

test('detached frames reuse the row collection until the timeline mutates', (t) => {
  const harness = createPerfHarness();
  t.after(() => harness.coordinator.dispose());
  harness.coordinator.attach();

  harness.runFrame();
  harness.runFrame();
  assert.equal(
    harness.entryCounts.entries,
    1,
    'two detached frames over an unchanged timeline must scan it exactly once'
  );

  assert.ok(harness.observerInstances.length >= 1, 'the coordinator owns a private mutation observer');
  const observed = harness.observerInstances[0].observed[0];
  assert.equal(observed.target, harness.timeline, 'the observer watches the timeline container');
  assert.equal(observed.options.childList, true);
  assert.equal(observed.options.subtree, true);

  harness.observerInstances[0].fire([{ type: 'childList' }]);
  harness.runFrame();
  assert.equal(
    harness.entryCounts.entries,
    2,
    'a timeline mutation invalidates the cached collection on the next frame'
  );
});

test('without MutationObserver the coordinator falls back to scanning every frame', (t) => {
  const harness = createPerfHarness({ mutationObserver: false });
  t.after(() => harness.coordinator.dispose());
  harness.coordinator.attach();

  harness.runFrame();
  harness.runFrame();
  assert.equal(
    harness.entryCounts.entries,
    2,
    'no mutation signal means nothing is safe to cache; semantics fall back to per-frame scans'
  );
});

test('dispose disconnects the private mutation observer', (t) => {
  const harness = createPerfHarness();
  t.after(() => harness.coordinator.dispose());
  harness.coordinator.attach();
  harness.runFrame();

  harness.coordinator.dispose();
  assert.ok(harness.observerInstances.length >= 1);
  assert.ok(
    harness.observerInstances.every((instance) => instance.disconnected),
    'the coordinator must not leak its observer past dispose'
  );
});

test('stats publishing mutates one stable object instead of reallocating per frame', (t) => {
  const harness = createPerfHarness();
  t.after(() => harness.coordinator.dispose());
  harness.coordinator.attach();

  harness.runFrame();
  const published = harness.state.ui.timelineScrollStats;
  assert.ok(published && typeof published === 'object');

  harness.runFrame();
  assert.strictEqual(
    harness.state.ui.timelineScrollStats,
    published,
    'per-frame publishes must reuse the same stats object'
  );
  assert.equal(published.frames, 2, 'the stable object still carries fresh values');
});
