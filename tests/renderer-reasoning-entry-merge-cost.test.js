const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');

const {
  buildReasoningEntryContentKey,
  buildReasoningEntryMergeIndexes,
  mergeReasoningEntriesInto,
} = require('../renderer/chat/renderer-reasoning-entry-merge-utils');
const { normalizeChatMessages } = require('../renderer/chat/chat-message-utils');

const MERGE_COUNT = 200;
const MESSAGE_COUNT = 200;
const REASONING_ENTRY_COUNT = 8;
const LARGE_REASONING_CHARS = 50_000;
const MERGE_SNAPSHOT_CHARS = 200_000;
const SAMPLE_WINDOW = 20;
const RATIO_THRESHOLD = 5;

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function createMergeState(entries = []) {
  const { indexById, contentKeyCounts } = buildReasoningEntryMergeIndexes(entries);
  return { entries, indexById, contentKeyCounts };
}

function createMessages(reasoningChars) {
  const text = 'r'.repeat(reasoningChars);
  return Array.from({ length: MESSAGE_COUNT }, (_, messageIndex) => ({
    id: `assistant-${messageIndex}`,
    role: 'assistant',
    content: 'answer',
    timestamp: '2026-09-03T00:00:00.000Z',
    reasoning: {
      source: 'provider',
      entries: Array.from({ length: REASONING_ENTRY_COUNT }, (_, entryIndex) => ({
        id: `reasoning-${messageIndex}-${entryIndex}`,
        text,
        timestamp: '2026-09-03T00:00:00.000Z',
        thinkingId: `thinking-${messageIndex}`,
      })),
    },
  }));
}

// The design guarantee is that a content key is BOUNDED, not that a microbenchmark
// runs flat: an earlier ratio-based version of this test measured GC pressure from
// its own multi-hundred-megabyte fixture as much as the code under test, and passed
// against the unfixed implementation at 50K chars. Assert the bound directly.
test('a content key stays bounded however large the entry text is', () => {
  const keyFor = (chars) => buildReasoningEntryContentKey({
    text: 'r'.repeat(chars), timestamp: '2026-09-03T00:00:00.000Z', thinkingId: 'thinking-1',
  });

  // Short entries keep the whole text, so dedupe is still exact for them.
  assert.ok(keyFor(64).includes('r'.repeat(64)));

  // Long entries sample the ends; the key stops growing with the text.
  const long = keyFor(LARGE_REASONING_CHARS);
  const longer = keyFor(LARGE_REASONING_CHARS * 8);
  assert.ok(long.length < 1400, `key was ${long.length} chars`);
  assert.equal(longer.length - long.length, String(LARGE_REASONING_CHARS * 8).length
    - String(LARGE_REASONING_CHARS).length);

  // Length is part of the key, so same-prefix/same-suffix entries of different
  // lengths never collapse into each other.
  assert.notEqual(keyFor(5000), keyFor(5001));
});

test('a growing single-id snapshot still collapses to one entry', () => {
  const state = createMergeState();
  for (let index = 1; index <= MERGE_COUNT; index += 1) {
    mergeReasoningEntriesInto(state, [{
      id: 'reasoning-phase',
      text: 'r'.repeat(Math.round((index * MERGE_SNAPSHOT_CHARS) / MERGE_COUNT)),
      timestamp: '2026-09-03T00:00:00.000Z',
      thinkingId: 'thinking-phase',
    }]);
  }

  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].text.length, MERGE_SNAPSHOT_CHARS);
  // SP-25: the id-replace path re-keys, so exactly one key is retained.
  assert.equal(state.contentKeyCounts.size, 1);
});

test('normalizing id-bearing reasoning does not scale with reasoning text size', (t) => {
  const smallMessages = createMessages(200);
  const largeMessages = createMessages(LARGE_REASONING_CHARS);
  const perNormalize = [];

  normalizeChatMessages(smallMessages);
  normalizeChatMessages(largeMessages);
  for (let index = 0; index < SAMPLE_WINDOW; index += 1) {
    const start = performance.now();
    normalizeChatMessages(smallMessages);
    perNormalize.push(performance.now() - start);
  }
  for (let index = 0; index < SAMPLE_WINDOW; index += 1) {
    const start = performance.now();
    normalizeChatMessages(largeMessages);
    perNormalize.push(performance.now() - start);
  }

  const smallMean = mean(perNormalize.slice(0, SAMPLE_WINDOW));
  const largeMean = mean(perNormalize.slice(-SAMPLE_WINDOW));
  const ratio = largeMean / smallMean;
  const context = `small=${smallMean.toFixed(2)}ms large=${largeMean.toFixed(2)}ms ratio=${ratio.toFixed(2)}x`;
  t.diagnostic(context);

  assert.ok(
    largeMean <= smallMean * RATIO_THRESHOLD,
    `Normalization grew >${RATIO_THRESHOLD}x with reasoning text size. ${context}`,
  );
});

test('same-id snapshots collapse to the latest entry', () => {
  const state = createMergeState();
  mergeReasoningEntriesInto(state, [
    { id: 'reasoning-1', text: 'first', timestamp: '1' },
    { id: 'reasoning-1', text: 'latest', timestamp: '2' },
  ]);

  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].text, 'latest');
});

test('identical id-less entries still dedupe', () => {
  const state = createMergeState();
  mergeReasoningEntriesInto(state, [
    { text: 'same', timestamp: '1', thinkingId: 'thinking-1' },
    { text: 'same', timestamp: '1', thinkingId: 'thinking-1' },
  ]);

  assert.equal(state.entries.length, 1);
});

test('distinct id-less entries survive in order', () => {
  const state = createMergeState();
  mergeReasoningEntriesInto(state, [
    { text: 'first', timestamp: '1' },
    { text: 'second', timestamp: '2' },
    { text: 'third', timestamp: '3' },
  ]);

  assert.deepEqual(state.entries.map((entry) => entry.text), ['first', 'second', 'third']);
});

test('an id-less entry matching an id-bearing entry is deduped by content', () => {
  const state = createMergeState();
  mergeReasoningEntriesInto(state, [
    { id: 'reasoning-1', text: 'shared', timestamp: '1' },
    { text: 'shared', timestamp: '1' },
    { text: 'shared', timestamp: '1' },
    { id: 'reasoning-1', text: 'updated', timestamp: '2' },
    { text: 'other', timestamp: '3' },
  ]);

  assert.deepEqual(state.entries, [
    { id: 'reasoning-1', text: 'updated', timestamp: '2' },
    { text: 'other', timestamp: '3' },
  ]);
  assert.equal(state.indexById.get('reasoning-1'), 0);
  assert.equal(state.contentKeyCounts.size, 2);
});

// SP-25 keeps this collapsing: the content index is what stops a second entry
// with a fresh id but identical content from duplicating the row.
test('different ids with identical content still collapse', () => {
  const state = createMergeState();
  mergeReasoningEntriesInto(state, [
    { id: 'reasoning-1', text: 'same', timestamp: '1', thinkingId: 'thinking-1' },
    { id: 'reasoning-2', text: 'same', timestamp: '1', thinkingId: 'thinking-1' },
  ]);

  assert.deepEqual(state.entries.map((entry) => entry.id), ['reasoning-1']);
});

test('merge indexes key every entry by content and id-bearing ones by id too', () => {
  const { indexById, contentKeyCounts } = buildReasoningEntryMergeIndexes([
    { id: 'reasoning-1', text: 'identified', timestamp: '1' },
    { text: 'id-less', timestamp: '2' },
  ]);

  assert.equal(indexById.get('reasoning-1'), 0);
  assert.equal(contentKeyCounts.size, 2);
});
