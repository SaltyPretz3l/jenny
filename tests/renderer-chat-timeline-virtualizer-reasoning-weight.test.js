'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getTimelineEntryWeight } = require('../renderer/chat/renderer-render-pipeline-utils');
const { createTimelineVirtualizer } = require('../renderer/chat/renderer-chat-timeline-virtualizer');
const {
  buildEnvironment,
  bulkEntries,
  makeChatTimeline,
  makeFakeDocument,
} = require('./helpers/renderer-chat-timeline-virtualizer-helpers');

function makeMessages(reasoningLength) {
  return Array.from({ length: 45 }, (_, index) => ({
    content: `visible-${index}`,
    reasoning: { entries: [{ text: 'r'.repeat(reasoningLength) }] },
    reasoning_phases: [],
  }));
}

function makeVirtualizer(options = {}) {
  return createTimelineVirtualizer({
    chatTimeline: makeChatTimeline(bulkEntries(45)),
    document: makeFakeDocument(),
    contentVisibilityEnabled: true,
    ...options,
  });
}

test('reasoning-heavy 45-entry sessions select DOM windowing', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const virtualizer = makeVirtualizer();
  t.after(() => virtualizer.dispose());

  virtualizer.rebuild(getTimelineEntryWeight(makeMessages(9000)));

  assert.equal(virtualizer._internals.getStrategy(), 'dom-window');
});

test('light 45-entry sessions keep content visibility', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const virtualizer = makeVirtualizer();
  t.after(() => virtualizer.dispose());

  virtualizer.rebuild(getTimelineEntryWeight(makeMessages(10)));

  assert.equal(virtualizer._internals.getStrategy(), 'content-visibility');
});

test('entry weight is ignored when bounds are disabled', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const virtualizer = makeVirtualizer({ boundsEnabled: false });
  t.after(() => virtualizer.dispose());

  virtualizer.rebuild(getTimelineEntryWeight(makeMessages(9000)));

  assert.equal(virtualizer._internals.getStrategy(), 'content-visibility');
});

test('weightThreshold overrides the default weight threshold', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const virtualizer = makeVirtualizer({ weightThreshold: 500 });
  t.after(() => virtualizer.dispose());

  virtualizer.rebuild(getTimelineEntryWeight(makeMessages(10)));

  assert.equal(virtualizer._internals.getStrategy(), 'dom-window');
});

test('budget stats expose bounded entry weight without double-counting shared reasoning entries', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const sharedEntry = { text: 'shared' };
  const messages = [{
    content: 'visible',
    reasoning: { entries: [sharedEntry] },
    reasoning_phases: [{ entries: [sharedEntry, { text: 'phase-only' }] }],
  }];
  const virtualizer = makeVirtualizer();
  t.after(() => virtualizer.dispose());

  virtualizer.rebuild(getTimelineEntryWeight(messages));

  const stats = virtualizer._internals.getBudgetStats();
  assert.equal(stats.entryWeight, 'visible'.length + 'shared'.length + 'phase-only'.length);
  assert.equal(stats.weightThreshold, 400000);
});
