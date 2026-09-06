const test = require('node:test');
const assert = require('node:assert/strict');

const { appendPersistedReasoningEntry } = require('../services/backend/chat-stream-reasoning');
const {
  resolvePersistedReasoningCap,
} = require('../services/backend/chat-stream-reasoning-delta');

test('resolvePersistedReasoningCap scales and bounds the sidecar thinking budget', () => {
  for (const [budget, expected] of [
    [undefined, 48_000],
    [0, 48_000],
    [20_000, 192_000],
    [65_536, 262_144],
    [131_072, 262_144],
    [262_144, 262_144],
  ]) {
    assert.equal(resolvePersistedReasoningCap(budget), expected);
  }
});

test('appendPersistedReasoningEntry does not exceed the character cap near the marker boundary', () => {
  for (const remainingChars of [1, 2, 3]) {
    const prior = [{ id: 'r1', text: 'x'.repeat(48000 - remainingChars), timestamp: 't' }];
    const result = appendPersistedReasoningEntry(prior, 'abcdefghij', 't2', { coalesceTail: false });
    const totalChars = result.entries.reduce((sum, entry) => sum + entry.text.length, 0);
    assert.equal(result.entry, null);
    assert.equal(totalChars, 48000 - remainingChars);
    assert.equal(result.truncated, true);
  }
  const boundary = appendPersistedReasoningEntry(
    [{ id: 'r1', text: 'x'.repeat(47900), timestamp: 't' }], 'a'.repeat(200), 't2', { coalesceTail: false }
  );
  const marker = boundary.entry.text.match(
    /\n\n_\[reasoning truncated - (\d+) more characters not stored\]_$/
  );
  assert.ok(marker);
  const keptChars = boundary.entry.text.length - marker[0].length;
  assert.equal(Number(marker[1]), 200 - keptChars);
  assert.equal(boundary.entries.reduce((sum, entry) => sum + entry.text.length, 0), 48000);
  const fits = appendPersistedReasoningEntry(
    [{ id: 'r1', text: 'x'.repeat(47997), timestamp: 't' }], 'ab', 't2', { coalesceTail: false }
  );
  assert.equal(fits.entry.text, 'ab');
  assert.equal(fits.truncated, false);
});

test('appendPersistedReasoningEntry places the truncation marker at a dynamic cap', () => {
  const maxTotalChars = 65_536;
  const result = appendPersistedReasoningEntry([], 'z'.repeat(maxTotalChars + 500), 't', {
    coalesceTail: false,
    maxTotalChars,
  });

  assert.equal(result.truncated, true);
  assert.match(result.entry.text, /_\[reasoning truncated - \d+ more characters not stored\]_$/);
  assert.equal(result.entries.reduce((sum, entry) => sum + entry.text.length, 0), maxTotalChars);
});
