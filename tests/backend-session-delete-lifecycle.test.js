const test = require('node:test');
const assert = require('node:assert/strict');
const { deleteSessionWithQuiescence } = require('../services/backend/backend-session-delete-lifecycle');
const { SessionTurnActorRegistry } = require('../services/backend/session-turn-actor');
function harness(patch = {}) {
  const session = { id: 'a', updated_at: 'old', ...patch };
  const calls = [];
  const deletionHandle = {};
  const service = {
    sessionStore: { getSession: () => session },
    sessionTurnActors: {
      beginDeletion: (_id, options) => { calls.push(['begin', options.onlyIfIdle]); return deletionHandle; },
      awaitQuiescence: async () => ({ ok: true }),
      commitDeletion: async (_handle, mutation) => ({ ok: false, result: await mutation() }),
      rollbackDeletion: () => calls.push(['rollback']),
    },
    cancelChatStream: () => { calls.push(['cancel']); return true; },
    _emitServiceLog() {},
  };
  return { service, session, calls, deletionHandle };
}
for (const [patch, reason] of [[{ plugin_session: {} }, 'plugin_session'], [{ pending_question_batch: {} }, 'session_busy'], [{ active_turn: {} }, 'session_busy'], [{ updated_at: 'new' }, 'activity_changed']]) {
  test(`idle-only deletion refuses ${reason} before cancellation`, async () => {
    const h = harness(patch);
    const result = await deleteSessionWithQuiescence(h.service, 'a', { onlyIfIdle: true, expectedUpdatedAt: 'old' });
    assert.equal(result.deleted, false); assert.equal(result.reason, reason); assert.deepEqual(h.calls, []);
  });
}
test('activity is checked again at commit after async quiescence', async () => {
  const h = harness();
  h.service.sessionTurnActors.awaitQuiescence = async () => { h.session.updated_at = 'new'; return { ok: true }; };
  const result = await deleteSessionWithQuiescence(h.service, 'a', { onlyIfIdle: true, expectedUpdatedAt: 'old' });
  assert.equal(result.reason, 'activity_changed');
  assert.deepEqual(h.calls, [['begin', true], ['rollback']]);
});
test('idle-only deletion refuses durable runtime work before actor deletion', async () => {
  const h = harness();
  h.service.sessionRuntime = { hasSessionWork: () => true };
  const result = await deleteSessionWithQuiescence(h.service, 'a', {
    onlyIfIdle: true, expectedUpdatedAt: 'old',
  });
  assert.equal(result.reason, 'runtime_work_active');
  assert.deepEqual(h.calls, []);
});
test('idle-only deletion rechecks durable work at commit', async () => {
  const h = harness();
  let checks = 0;
  h.service.sessionRuntime = { hasSessionWork: () => ++checks > 1 };
  const result = await deleteSessionWithQuiescence(h.service, 'a', {
    onlyIfIdle: true, expectedUpdatedAt: 'old',
  });
  assert.equal(result.reason, 'runtime_work_active');
  assert.equal(checks, 2);
  assert.deepEqual(h.calls, [['begin', true], ['rollback']]);
});
test('normal deletion begins actor deletion then requires runtime and actor quiescence', async () => {
  const h = harness();
  h.service.sessionRuntime = {
    cancelSessionAndWait: async (sessionId, options) => {
      h.calls.push(['runtime', sessionId, options]);
      return { ok: true };
    },
  };
  h.service.sessionTurnActors.awaitQuiescence = async () => {
    h.calls.push(['actor-wait']);
    return { ok: true };
  };
  h.service.sessionTurnActors.commitDeletion = async () => {
    h.calls.push(['commit']);
    return { ok: true, result: { object: 'session', id: 'a', deleted: true } };
  };

  const result = await deleteSessionWithQuiescence(h.service, 'a');

  assert.equal(result.deleted, true);
  assert.deepEqual(h.calls, [
    ['begin', false],
    ['runtime', 'a', { reason: 'session_deleted', timeoutMs: 5_000,
      deletionHandle: h.deletionHandle }],
    ['actor-wait'],
    ['commit'],
  ]);
});
test('runtime cancellation timeout rolls deletion back without committing', async () => {
  const h = harness();
  h.service.sessionRuntime = {
    cancelSessionAndWait: async () => ({
      ok: false, reason: 'runtime_cancel_timeout', timedOut: true,
    }),
  };
  h.service.sessionTurnActors.commitDeletion = async () => {
    h.calls.push(['commit']);
    return { ok: true };
  };

  const result = await deleteSessionWithQuiescence(h.service, 'a');

  assert.equal(result.deleted, false);
  assert.equal(result.reason, 'runtime_cancel_timeout');
  assert.deepEqual(h.calls, [['begin', false], ['rollback']]);
  assert.equal(h.service.sessionStore.getSession('a'), h.session);
});
test('actor refuses an overlapping idle-only deletion rather than reusing its handle', () => {
  const actors = new SessionTurnActorRegistry();
  const first = actors.beginDeletion('a');
  assert.ok(first);
  assert.equal(actors.beginDeletion('a', { onlyIfIdle: true }), null);
  actors.rollbackDeletion(first);
  const idle = actors.beginDeletion('a', { onlyIfIdle: true });
  assert.ok(idle); actors.rollbackDeletion(idle);
});
