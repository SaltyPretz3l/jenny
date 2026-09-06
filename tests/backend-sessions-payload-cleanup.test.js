const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deleteSession,
} = require('../services/backend/backend-sessions');

/* Reference-counted cleanup of externalized IPC payloads on session delete.
 * Split out of backend-sessions.test.js, which sits near the 1015-line cap.
 * The store itself is covered by tests/ipc-payload-store.test.js and the
 * decision layer by tests/ipc-payload-retention.test.js; this file pins the
 * DELETE PATH: candidates collected before the delete, references counted
 * across only the remaining sessions, and nothing unlinked when that scan
 * cannot be completed. */

function createPayloadDeleteFixture({ shared = false, unreadable = false } = {}) {
  const payload = shared ? 'shared.json' : 'deleted.json';
  const message = (path) => ({ tool_result: { external_payloads: { output: { path } } } });
  const sessions = new Map([
    ['deleted', { id: 'deleted', messages: [message(payload)] }],
    ['remaining', { id: 'remaining', messages: [message(shared ? payload : 'remaining.json')] }],
  ]);
  const calls = { reads: [], unlinked: [], prunes: 0, pruneOptions: [] };
  const sessionStore = {
    getSessionMessages(id) {
      calls.reads.push(id);
      if (unreadable && id === 'remaining') throw new Error('session unreadable');
      return sessions.get(id)?.messages || [];
    },
    listSessions: () => [...sessions.values()].map((session) => ({
      id: session.id,
      message_count: session.messages.length,
    })),
    deleteSession(id) { return sessions.delete(id); },
  };
  const ipcPayloadStore = { prunePayloadPaths(candidates, referenced, options) {
    calls.prunes += 1;
    calls.pruneOptions.push(options);
    calls.unlinked.push(...candidates.filter((name) => !referenced.has(name)));
  } };
  return { service: { sessionStore, ipcPayloadStore }, calls };
}

// The `graceMs: 0` asserted below is load-bearing, so it is stated once here
// rather than in a second test: the age grace exists to protect a payload whose
// referencing message is not persisted yet, but these candidates came FROM
// persisted messages of an already-quiesced, already-deleted session. The
// hour-long default would strand the payloads of any session deleted soon after
// its last turn until some later launch's orphan sweep picked them up.
test('session delete prunes payloads after reading only remaining session references', async () => {
  const { service, calls } = createPayloadDeleteFixture();
  const result = await deleteSession(service, 'deleted');
  assert.equal(result.deleted, true);
  assert.deepEqual(calls, {
    reads: ['deleted', 'remaining'], unlinked: ['deleted.json'], prunes: 1,
    pruneOptions: [{ graceMs: 0 }],
  });
});

test('session delete preserves a payload referenced by another session', async () => {
  const { service, calls } = createPayloadDeleteFixture({ shared: true });
  await deleteSession(service, 'deleted');
  assert.deepEqual(calls.unlinked, []);
  assert.equal(calls.prunes, 1);
});

test('session delete degrades without pruning when a remaining session read fails', async () => {
  const { service, calls } = createPayloadDeleteFixture({ unreadable: true });
  const result = await deleteSession(service, 'deleted');
  assert.equal(result.deleted, true);
  assert.deepEqual(calls, {
    reads: ['deleted', 'remaining'], unlinked: [], prunes: 0, pruneOptions: [],
  });
  assert.equal(result.cleanup_status, 'degraded');
  assert.deepEqual(result.cleanup_errors, [{ step: 'ipc_payloads', code: 'cleanup_failed' }]);
});

test('session delete preserves a payload referenced only by the SHADOW store', async () => {
  // collectRemainingSessionIds unions canonical AND shadow ids, but the payload
  // scan used to read every one of them from the canonical store, which answers
  // [] for a shadow-only session. The reference was dropped and the payload
  // deleted immediately, because this path passes graceMs: 0. The asset
  // collector beside it always read both stores; this one did not.
  const message = (path) => ({ tool_result: { external_payloads: { output: { path } } } });
  const sessions = new Map([['deleted', { id: 'deleted', messages: [message('shared.json')] }]]);
  const unlinked = [];
  const service = {
    sessionStore: {
      getSessionMessages: (id) => sessions.get(id)?.messages || [],
      listSessions: () => [...sessions.values()].map((session) => ({
        id: session.id,
        message_count: session.messages.length,
      })),
      deleteSession: (id) => sessions.delete(id),
    },
    shadowStore: {
      summarize: () => ({ shadowOnly: { id: 'shadowOnly' } }),
      getMessages: (id) => (id === 'shadowOnly' ? [message('shared.json')] : []),
    },
    ipcPayloadStore: {
      prunePayloadPaths(candidates, referenced) {
        unlinked.push(...candidates.filter((name) => !referenced.has(name)));
      },
    },
  };

  await deleteSession(service, 'deleted');

  assert.deepEqual(unlinked, []);
});

test('session delete refuses to prune when a remaining session reads empty against its index', async () => {
  // getSessionMessages turns a missing, unreadable, or future-schema session
  // into [] rather than throwing, so an incomplete scan is indistinguishable
  // from a genuinely empty one -- except that the index still reports the real
  // message_count. Pruning against that scan deletes live payloads at once.
  const message = (path) => ({ tool_result: { external_payloads: { output: { path } } } });
  const sessions = new Map([
    ['deleted', { id: 'deleted', messages: [message('deleted.json')] }],
    ['remaining', { id: 'remaining', messages: [] }],
  ]);
  let prunes = 0;
  const service = {
    sessionStore: {
      getSessionMessages: (id) => sessions.get(id)?.messages || [],
      // The index insists 'remaining' has three messages; the body came back empty.
      listSessions: () => [
        { id: 'deleted', message_count: 1 },
        { id: 'remaining', message_count: 3 },
      ],
      deleteSession: (id) => sessions.delete(id),
    },
    ipcPayloadStore: { prunePayloadPaths() { prunes += 1; } },
  };

  const result = await deleteSession(service, 'deleted');

  assert.equal(result.deleted, true);
  assert.equal(prunes, 0);
  assert.equal(result.cleanup_status, 'degraded');
});
