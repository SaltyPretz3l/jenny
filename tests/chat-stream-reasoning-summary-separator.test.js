// 2026-08-29: pins the seam the ChatGPT summary-part separator relies on — a
// "\n\n"-prefixed coalesced delta must keep its interior blank line through
// sanitize so each summary headline persists as its own paragraph.
// (Own file: tests/chat-stream-reasoning.test.js sits at the 600-line ratchet.)
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  appendPersistedReasoningEntry,
} = require('../services/backend/chat-stream-reasoning');

test('appendPersistedReasoningEntry keeps a summary-part paragraph break while coalescing', () => {
  let entries = [];
  const first = appendPersistedReasoningEntry(entries, '**A**', '2026-08-29T15:00:00.000Z', {
    coalesceTail: true,
  });
  entries = first.entries;
  const second = appendPersistedReasoningEntry(entries, '\n\n**B**', '2026-08-29T15:00:01.000Z', {
    coalesceTail: true,
  });

  assert.equal(second.entries.length, 1);
  assert.equal(second.entry.id, first.entry.id);
  assert.equal(second.entry.text, '**A**\n\n**B**');
});
