const test = require('node:test');
const assert = require('node:assert/strict');

const { appendPersistedReasoningEntry } = require('../services/backend/chat-stream-reasoning');

// Per-token provider deltas (Qwen tokenizers emit newlines, the space before a
// digit and every digit as standalone tokens). The persisted tail must be the
// verbatim join: whitespace-only deltas survive and repeated tokens are kept.
function replayDeltas(deltas) {
  let entries = [];
  let rawTailText = '';
  let sanitizedTailText = '';
  for (const delta of deltas) {
    const result = appendPersistedReasoningEntry(entries, delta, '2026-09-02T00:00:00Z', {
      coalesceTail: entries.length > 0,
      thinkingId: 'think_1',
      rawTailText,
      sanitizedTailText,
      maxTotalChars: 48_000,
    });
    entries = result.entries;
    if (typeof result.rawText === 'string') rawTailText = result.rawText;
    if (typeof result.sanitizedTailText === 'string') sanitizedTailText = result.sanitizedTailText;
  }
  return { entries, rawTailText };
}

test('whitespace-only reasoning deltas are re-joined verbatim into the persisted tail', () => {
  const deltas = ["That's fine.", '\n', '- Fill viewport, works at', ' ', '1', '2', '8', '0', 'x', '8', '0', '0', '\n\n', 'Next'];
  const { entries, rawTailText } = replayDeltas(deltas);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, "That's fine.\n- Fill viewport, works at 1280x800\n\nNext");
  assert.equal(rawTailText, deltas.join(''));
});

test('a repeated single-token delta is appended, not deduplicated', () => {
  const { entries } = replayDeltas(['width: ', '1', '0', '0', '%']);
  assert.equal(entries[0].text, 'width: 100%');
});

test('a whitespace-only delta alone never opens an entry', () => {
  const { entries } = replayDeltas(['\n\n']);
  assert.equal(entries.length, 0);
});
