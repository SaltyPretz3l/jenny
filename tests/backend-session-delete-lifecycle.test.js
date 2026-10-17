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
for (const [patch, reason] of [[{ pending_question_batch: {} }, 'session_busy'], [{ active_turn: {} }, 'session_busy'], [{ updated_at: 'new' }, 'activity_changed']]) {
  test(`idle-only deletion refuses ${reason} before cancellation`, async () => {
    const h = harness(patch);
    const result = await deleteSessionWithQuiescence(h.service, 'a', { onlyIfIdle: true, expectedUpdatedAt: 'old' });
    assert.equal(result.deleted, false); assert.equal(result.reason, reason); assert.deepEqual(h.calls, []);
  });
}
test('a saved plugin session (old image chat) is no longer refused as a plugin session', async () => {
  const h = harness({ session_type: 'plugin', plugin_session: { schema_version: 1 } });
  h.service.sessionRuntime = { hasSessionWork: () => true };
  const result = await deleteSessionWithQuiescence(h.service, 'a', { onlyIfIdle: true, expectedUpdatedAt: 'old' });
  assert.equal(result.reason, 'runtime_work_active', 'it reaches the ordinary idle checks');
});
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

// Memory v2 (row 58): a deleted chat's chat-scope memories are purged once the
// delete has committed (W3: a refused delete must leave the live chat's memory
// alone); a missing or failing sidecar never blocks the delete.
function purgeHarness(sidecarClient) {
  const h = harness();
  const logs = [];
  h.service.sidecarClient = sidecarClient;
  h.service._emitServiceLog = (level, event, details) => logs.push([level, event, details]);
  h.service.sessionTurnActors.awaitQuiescence = async () => { h.calls.push(['actor-wait']); return { ok: true }; };
  h.service.sessionTurnActors.commitDeletion = async () => {
    h.calls.push(['commit']);
    return { ok: true, result: { object: 'session', id: 'a', deleted: true } };
  };
  return { ...h, logs };
}

test('normal deletion purges the chat-scope memories after the chat is removed and bumps the epoch', async () => {
  let h = null;
  h = purgeHarness({
    request: async (method, params) => {
      h.calls.push(['request', method, Object.keys(params).sort(), params.session_id]);
      return { ok: true, removed: 2 };
    },
  });
  const result = await deleteSessionWithQuiescence(h.service, 'a');
  assert.equal(result.deleted, true);
  assert.deepEqual(h.calls, [
    ['begin', false],
    ['actor-wait'],
    ['commit'],
    ['request', 'memory.purge_session', ['accept_version', 'session_id'], 'a'],
    // The epoch bump is pushed to the sidecar's apply fence (row 58 W2).
    ['request', 'memory.policy_epoch', ['accept_version', 'epoch_source', 'policy_epoch'], undefined],
  ]);
  assert.equal(h.service._memoryPolicyEpoch, 1);
  assert.equal(h.logs.some(([, event]) => event === 'lifecycle.session_memory_purge_skipped'), false);
});

test('a committed delete also purges the chat from the conversation index, best effort (row 58 W4)', async () => {
  for (const fail of [false, true]) {
    let h = null;
    h = purgeHarness({
      connected: true,
      request: async (method, params) => {
        h.calls.push(['request', method, params.session_ids || params.session_id]);
        if (fail && method === 'conversations.purge') throw new Error('index down');
        return { ok: true, removed: 1 };
      },
    });
    const result = await deleteSessionWithQuiescence(h.service, 'a');
    assert.equal(result.deleted, true);
    assert.deepEqual(h.calls.filter(call => call[0] === 'request').map(call => call.slice(1)), [
      ['memory.purge_session', 'a'], ['memory.policy_epoch', undefined], ['conversations.purge', ['a']],
    ]);
  }
});

test('a failing or missing sidecar logs the skipped purge and the delete proceeds', async () => {
  const failing = purgeHarness({
    request: async () => { throw Object.assign(new Error('memory.purge_session failed'), { error_code: 'CMP-MEM-0001' }); },
  });
  assert.equal((await deleteSessionWithQuiescence(failing.service, 'a')).deleted, true);
  assert.deepEqual(failing.logs.filter(([, event]) => event === 'lifecycle.session_memory_purge_skipped'),
    [['WARN', 'lifecycle.session_memory_purge_skipped', { reason: 'CMP-MEM-0001' }]]);
  assert.equal(failing.service._memoryPolicyEpoch, undefined, 'a failed purge does not move the epoch');

  const missing = purgeHarness(null);
  assert.equal((await deleteSessionWithQuiescence(missing.service, 'a')).deleted, true);
  assert.deepEqual(missing.logs.filter(([, event]) => event === 'lifecycle.session_memory_purge_skipped'),
    [['INFO', 'lifecycle.session_memory_purge_skipped', { reason: 'sidecar_unavailable' }]]);
});

test('a refused or retained delete never purges the live chat', async () => {
  for (const committed of [
    { ok: false, result: { object: 'session', id: 'a', deleted: false, reason: 'activity_changed' } },
    { ok: true, result: { object: 'session', id: 'a', deleted: false, reason: 'retained' } },
  ]) {
    let requests = 0;
    const h = purgeHarness({ request: async () => { requests += 1; return { ok: true, removed: 0 }; } });
    h.service.sessionTurnActors.commitDeletion = async () => committed;
    assert.equal((await deleteSessionWithQuiescence(h.service, 'a')).deleted, false);
    assert.equal(requests, 0);
  }
});

test('a refused quiescence never purges', async () => {
  let requests = 0;
  const h = purgeHarness({ request: async () => { requests += 1; return { ok: true, removed: 0 }; } });
  h.service.sessionTurnActors.awaitQuiescence = async () => ({ ok: false, reason: 'not_quiescent' });
  const result = await deleteSessionWithQuiescence(h.service, 'a');
  assert.equal(result.deleted, false);
  assert.equal(requests, 0);
});
