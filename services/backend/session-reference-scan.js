'use strict';

// Reads one session's messages for a reference scan and FAILS CLOSED unless the
// read is provably complete. Every sweep in this file deletes files that nothing
// references, so the governing asymmetry is that under-counting references
// destroys user data while over-counting only leaves a stale file until the next
// pass. A session we cannot read in full must abort the pass, never contribute
// an empty reference set.
//
// Two distinct incomplete reads, and the second is the non-obvious one:
//   * `peekSession` returns null for an unreadable/empty file and for a
//     future-schema freeze (a newer app version wrote that session).
//   * A CORRUPT file is quarantined and RE-SEEDED as an empty stub --
//     `_quarantineAndRecoverCorruptSession` in session-storage-backend.js
//     persists `messages: []` and returns that record -- so `messages: []` is
//     NOT proof of an empty session and a null check alone misses it. The index
//     summary read at the top of the walk still carries the pre-quarantine
//     `message_count`, which is what makes the stub detectable. (The scan's own
//     peek is what can trigger that quarantine.)
function readSessionMessagesForReferenceScan(sessionStore, summary) {
  const sessionId = summary?.id;
  const expectedCount = Number(summary?.message_count || 0);
  let messages = null;
  if (typeof sessionStore?.peekSession === 'function') {
    // Cache-neutral peek so the scan never churns the session LRU.
    const record = sessionStore.peekSession(sessionId);
    messages = Array.isArray(record?.messages) ? record.messages : null;
  } else if (typeof sessionStore?.getSessionMessages === 'function') {
    const read = sessionStore.getSessionMessages(sessionId);
    messages = Array.isArray(read) ? read : null;
  }
  if (!messages) {
    throw new Error(`reference scan could not read session ${sessionId}`);
  }
  if (messages.length === 0 && expectedCount > 0) {
    throw new Error(
      `reference scan read an empty stub for session ${sessionId} (index expects ${expectedCount})`
    );
  }
  return messages;
}

module.exports = { readSessionMessagesForReferenceScan };
