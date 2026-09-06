const test = require('node:test');
const assert = require('node:assert/strict');

const { INTERACTIVE_ERROR_CODES } = require('../services/backend/error-codes');
const {
  SessionTurnActorRegistry,
  ensureSessionTurnActorRegistry,
} = require('../services/backend/session-turn-actor');

const NOW_MS = Date.parse('2026-07-13T18:00:00.000Z');

function createIdFactory() {
  let sequence = 0;
  return () => `id${++sequence}`;
}

function baseSession(patch = {}) {
  return {
    id: patch.id || 'session',
    messages: [],
    pending_question_batch: null,
    active_turn: null,
    ...patch,
  };
}

class FakeStore {
  constructor(sessions = {}, {
    flushResults = [],
    preferenceResults = [],
    clearResults = [],
  } = {}) {
    this.sessions = new Map(
      Object.entries(sessions).map(([id, session]) => [id, baseSession({ ...session, id })])
    );
    this.flushResults = [...flushResults];
    this.preferenceResults = [...preferenceResults];
    this.clearResults = [...clearResults];
    this.sequence = [];
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  getSessionMessages(sessionId) {
    return this.getSession(sessionId)?.messages || [];
  }

  getActiveTurn(sessionId) {
    return this.getSession(sessionId)?.active_turn || null;
  }

  setActiveTurn(sessionId, activeTurn, { expectedPriorStreamId } = {}) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    const current = session.active_turn;
    if (
      expectedPriorStreamId
      && current
      && current.stream_id !== expectedPriorStreamId
    ) return null;
    session.active_turn = { ...activeTurn };
    this.sequence.push(`claim:${activeTurn.stream_id}`);
    return session;
  }

  setTurnIdentity(sessionId, identity) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    Object.assign(session, identity);
    this.sequence.push(`identity:${identity.turn_generation}`);
    return session;
  }

  clearActiveTurn(sessionId, match = {}) {
    const session = this.getSession(sessionId);
    const current = session?.active_turn;
    if (!current) return null;
    if (match.request_id && match.request_id !== current.request_id) return null;
    if (match.stream_id && match.stream_id !== current.stream_id) return null;
    if (this.clearResults.length && this.clearResults.shift() === false) {
      this.sequence.push(`clear_refused:${current.stream_id}`);
      return null;
    }
    this.sequence.push(`clear:${current.stream_id}`);
    session.active_turn = null;
    return session;
  }

  appendMessage(sessionId, message) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    session.messages.push({ ...message });
    this.sequence.push(`append:${message.id}`);
    return session;
  }

  updateMessage(sessionId, messageId, patch) {
    const session = this.getSession(sessionId);
    const index = session?.messages.findIndex((message) => message.id === messageId) ?? -1;
    if (index < 0) return null;
    session.messages[index] = { ...session.messages[index], ...patch, id: messageId };
    this.sequence.push(`update:${messageId}`);
    return session;
  }

  setSessionPreferences(sessionId, preferences) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    if (this.preferenceResults.length && this.preferenceResults.shift() === false) {
      this.sequence.push('token:refused');
      return null;
    }
    Object.assign(session, preferences);
    this.sequence.push(
      `token:${preferences.pending_question_batch?.continuation_token?.consumed}`
    );
    return session;
  }

  flushSession(sessionId) {
    this.sequence.push(`flush:${sessionId}`);
    return this.flushResults.length ? this.flushResults.shift() : true;
  }
}

function createRegistry(options = {}) {
  return new SessionTurnActorRegistry({
    now: () => NOW_MS,
    createId: createIdFactory(),
    ...options,
  });
}

function reserve(registry, store, sessionId, patch = {}) {
  return registry.reserveStart({
    sessionId,
    store,
    activeStreams: patch.activeStreams || new Map(),
    prompt: 'hello',
    ...patch,
  });
}

function questionBatch(batchId = 'batch_1') {
  return {
    batch_id: batchId,
    round_index: 1,
    intro_text: '',
    questions: [{
      id: 'question_1',
      prompt: 'Which option?',
      options: [{ id: 'option_1', label: 'One' }],
    }],
  };
}

test('reserveStart performs a synchronous same-session CAS and returns authoritative identity', () => {
  const store = new FakeStore({ s1: {} });
  const registry = createRegistry();
  const lease = reserve(registry, store, 's1');

  assert.deepEqual(Object.keys(lease.identity), [
    'sessionId',
    'sessionIncarnation',
    'generation',
    'turnId',
    'streamId',
    'userMessageId',
    'sessionRevision',
  ]);
  assert.equal(lease.identity.sessionId, 's1');
  assert.equal(lease.identity.generation, 1);
  assert.equal(lease.identity.turnId, lease.identity.streamId);
  assert.equal(lease.identity.userMessageId, `user_${lease.identity.streamId}`);
  assert.equal(lease.identity.sessionRevision, null);
  assert.equal(store.getActiveTurn('s1').stream_id, lease.identity.streamId);

  assert.throws(
    () => reserve(registry, store, 's1'),
    (error) => error.code === 'session_busy' && error.reason === 'lease_active'
  );
});

test('independent sessions reserve concurrently', () => {
  const store = new FakeStore({ s1: {}, s2: {} });
  const registry = createRegistry();
  const first = reserve(registry, store, 's1');
  const second = reserve(registry, store, 's2');

  assert.equal(first.identity.generation, 1);
  assert.equal(second.identity.generation, 1);
  assert.notEqual(first.identity.sessionIncarnation, second.identity.sessionIncarnation);
  assert.equal(registry.size, 2);
});

test('pending settlement barriers include only live unattached leases', () => {
  const store = new FakeStore({ s1: {}, s2: {} });
  const registry = createRegistry();
  const pending = reserve(registry, store, 's1');
  const attached = reserve(registry, store, 's2');
  registry.attachController(attached, new AbortController());

  assert.deepEqual(registry.pendingUnattachedLeaseSettlementBarriers(),
    [pending.settledPromise]);
  registry.release(pending, { status: 'cancelled' });
  assert.deepEqual(registry.pendingUnattachedLeaseSettlementBarriers(), []);
});

test('reserveStart reports no lease until the exact active-turn claim is durable', () => {
  const store = new FakeStore({ s1: {} }, { flushResults: [false, true] });
  const registry = createRegistry();

  assert.throws(
    () => reserve(registry, store, 's1'),
    (error) => error.code === 'active_turn_recovery_failed'
      && error.reason === 'active_turn_claim_flush_refused'
  );
  assert.equal(store.getActiveTurn('s1'), null);

  const retry = reserve(registry, store, 's1');
  assert.equal(retry.identity.generation, 2);
});

test('release keeps a recovery bracket when active-turn clear or flush is refused', () => {
  for (const options of [
    { clearResults: [false] },
    { flushResults: [true, false, true] },
  ]) {
    const store = new FakeStore({ s1: {} }, options);
    const registry = createRegistry();
    const lease = reserve(registry, store, 's1');
    const released = registry.release(lease, { status: 'cancelled' });

    assert.equal(released.recoveryBlocked, 'active_turn_release_failed');
    assert.equal(store.getActiveTurn('s1').stream_id, lease.identity.streamId);
    const replacement = reserve(registry, store, 's1');
    assert.equal(replacement.identity.generation, 2);
  }
});

test('orphan reclaim durably writes interrupted terminal before clear and G+1 claim', () => {
  const stale = {
    request_id: 'old_turn',
    turn_id: 'old_turn',
    stream_id: 'old_stream',
    user_message_id: 'old_user',
    session_incarnation: 'inc_existing',
    generation: 4,
    started_at: '2026-07-13T10:00:00.000Z',
    last_event_at: '2026-07-13T10:00:00.000Z',
    status: 'streaming',
  };
  const store = new FakeStore({
    s1: {
      active_turn: stale,
      messages: [{
        id: 'assistant_old_stream',
        role: 'assistant',
        content: 'Partial answer',
        status: 'streaming',
      }],
    },
  });
  const registry = createRegistry();
  const lease = reserve(registry, store, 's1');

  assert.equal(lease.identity.sessionIncarnation, 'inc_existing');
  assert.equal(lease.identity.generation, 5);
  assert.deepEqual(store.sequence, [
    'update:assistant_old_stream',
    'flush:s1',
    'clear:old_stream',
    'flush:s1',
    'identity:5',
    `claim:${lease.identity.streamId}`,
    'flush:s1',
  ]);
  const interrupted = store.getSessionMessages('s1')[0];
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.terminal_status, 'interrupted');
  assert.equal(interrupted.content, 'Partial answer');
  assert.equal(store.getSessionMessages('s1').length, 1, 'repair updates instead of duplicating');
});

test('orphan reclaim fails closed when interrupted terminal durability is refused', () => {
  const stale = {
    request_id: 'old_turn',
    stream_id: 'old_stream',
    user_message_id: 'old_user',
    started_at: '2026-07-13T10:00:00.000Z',
    last_event_at: '2026-07-13T10:00:00.000Z',
    status: 'streaming',
  };
  const store = new FakeStore(
    { s1: { active_turn: stale } },
    { flushResults: [false] }
  );
  const registry = createRegistry();

  assert.throws(
    () => reserve(registry, store, 's1'),
    (error) => error.code === 'active_turn_recovery_failed'
      && error.reason === 'interrupted_flush_refused'
  );
  assert.equal(store.sequence.some((entry) => entry.startsWith('claim:')), false);
  const recovered = reserve(registry, store, 's1');
  assert.equal(recovered.identity.generation, 1);
  assert.equal(store.getSessionMessages('s1').length, 1, 'blocked retry cannot duplicate repair');
});

test('orphan clear flush failure restores the durable bracket and retries cleanly', () => {
  const stale = {
    request_id: 'old_turn',
    stream_id: 'old_stream',
    user_message_id: 'old_user',
    session_incarnation: 'inc_orphan_clear',
    generation: 4,
    started_at: '2026-07-13T10:00:00.000Z',
    last_event_at: '2026-07-13T10:00:00.000Z',
    status: 'streaming',
  };
  const store = new FakeStore({
    s1: {
      active_turn: stale,
      messages: [{
        id: 'assistant_old_stream',
        role: 'assistant',
        content: 'Already complete.',
        status: 'completed',
        terminal_status: 'completed',
        parent_stream_id: 'old_stream',
      }],
    },
  }, { flushResults: [false, true] });
  const registry = createRegistry();

  assert.throws(
    () => reserve(registry, store, 's1'),
    (error) => error.code === 'active_turn_recovery_failed'
      && error.reason === 'active_turn_clear_durability_failed'
  );
  assert.equal(store.getActiveTurn('s1').stream_id, 'old_stream');

  const retry = reserve(registry, store, 's1');
  assert.equal(retry.identity.generation, 5);
  assert.equal(store.getActiveTurn('s1').stream_id, retry.identity.streamId);
});

test('fresh persisted bracket without a controller is reclaimed immediately', () => {
  const store = new FakeStore({
    s1: {
      active_turn: {
        request_id: 'fresh_turn',
        stream_id: 'fresh_stream',
        user_message_id: 'fresh_user',
        session_incarnation: 'inc_fresh_orphan',
        generation: 2,
        started_at: new Date(NOW_MS).toISOString(),
        last_event_at: new Date(NOW_MS).toISOString(),
        status: 'streaming',
      },
    },
  });
  const registry = createRegistry();

  const lease = reserve(registry, store, 's1');

  assert.equal(lease.identity.generation, 3);
  assert.equal(store.getSessionMessages('s1')[0].status, 'interrupted');
});

test('orphan reclaim treats durable question and plan rows as terminal evidence', () => {
  for (const kind of ['question_batch', 'plan_proposal']) {
    const streamId = `${kind}_stream`;
    const store = new FakeStore({
      s1: {
        active_turn: {
          request_id: streamId,
          stream_id: streamId,
          user_message_id: `user_${streamId}`,
          session_incarnation: 'inc_terminal_variant',
          generation: 4,
          started_at: '2026-07-13T10:00:00.000Z',
          last_event_at: '2026-07-13T10:00:00.000Z',
          status: 'streaming',
        },
        messages: [{
          id: `${kind}_${streamId}`,
          role: 'assistant',
          kind,
          content: `${kind} content`,
        }],
      },
    });
    const registry = createRegistry();

    const lease = reserve(registry, store, 's1');

    assert.equal(lease.identity.generation, 5);
    assert.equal(store.getSessionMessages('s1').length, 1);
    assert.equal(
      store.getSessionMessages('s1').some((message) => message.status === 'interrupted'),
      false
    );
  }
});

test('orphan continuation restores failure terminals but never replays a successful terminal', () => {
  for (const terminalKind of ['failure', 'success']) {
    const batch = questionBatch(`batch_${terminalKind}`);
    const token = {
      token_id: `token_${terminalKind}`,
      session_id: 's1',
      session_incarnation: 'inc_continuation_orphan',
      batch_id: batch.batch_id,
      prior_generation: 1,
      consumed: true,
      issued_at: '2026-07-13T10:00:00.000Z',
    };
    const streamId = `stream_${terminalKind}`;
    const store = new FakeStore({
      s1: {
        pending_question_batch: { ...batch, continuation_token: token },
        active_turn: {
          request_id: streamId,
          stream_id: streamId,
          user_message_id: `user_${streamId}`,
          session_incarnation: token.session_incarnation,
          generation: 2,
          started_at: '2026-07-13T10:00:00.000Z',
          last_event_at: '2026-07-13T10:00:00.000Z',
          status: 'streaming',
        },
        messages: [{
          id: `assistant_${streamId}`,
          role: 'assistant',
          content: terminalKind === 'failure' ? 'Turn failed.' : 'Turn completed.',
          ...(terminalKind === 'failure'
            ? { status: 'runtime_error', terminal_status: 'runtime_error', retryable: true }
            : {}),
        }],
      },
    });
    const registry = createRegistry();
    const response = {
      batch_id: batch.batch_id,
      batch_snapshot: { ...batch, continuation_token: token },
      continuation_token: { ...token, consumed: false },
    };

    if (terminalKind === 'failure') {
      const retry = reserve(registry, store, 's1', { interactiveResponse: response });
      assert.equal(retry.identity.generation, 3);
      assert.equal(store.getSessionMessages('s1').length, 1);
    } else {
      assert.throws(
        () => reserve(registry, store, 's1', { interactiveResponse: response }),
        (error) => error.reason === 'token_consumed'
      );
      assert.equal(store.getActiveTurn('s1'), null);
    }
  }
});

test('continuation token is consumed, restored after preflight failure, and rejects replay', () => {
  const store = new FakeStore({ s1: {} });
  const registry = createRegistry();
  const initial = reserve(registry, store, 's1');
  const batch = registry.attachContinuationToken(initial, questionBatch());
  const token = batch.continuation_token;

  assert.deepEqual(Object.keys(token), [
    'token_id',
    'session_id',
    'session_incarnation',
    'batch_id',
    'prior_generation',
    'consumed',
    'issued_at',
  ]);
  assert.equal(store.getSession('s1').pending_question_batch.continuation_token.consumed, false);
  registry.release(initial, { status: 'question_batch' });

  const response = {
    batch_id: batch.batch_id,
    batch_snapshot: batch,
    continuation_token: token,
  };
  const attempt = reserve(registry, store, 's1', { interactiveResponse: response });
  assert.equal(attempt.identity.generation, 2);
  assert.equal(store.getSession('s1').pending_question_batch.continuation_token.consumed, true);

  const failed = registry.release(attempt, { status: 'preflight_failure' });
  assert.equal(failed.restoredContinuation, true);
  assert.equal(store.getSession('s1').pending_question_batch.continuation_token.consumed, false);

  const retry = reserve(registry, store, 's1', { interactiveResponse: response });
  assert.equal(retry.identity.generation, 3);
  registry.release(retry, { status: 'completed' });
  assert.equal(store.getSession('s1').pending_question_batch.continuation_token.consumed, true);
  assert.throws(
    () => reserve(registry, store, 's1', { interactiveResponse: response }),
    (error) => error.code === INTERACTIVE_ERROR_CODES.INVALID_CONTINUATION
      && error.reason === 'token_consumed'
  );
});

test('continuation consume rollback leaves no consumed token without a recovery bracket', () => {
  const store = new FakeStore({ s1: {} });
  const registry = createRegistry();
  const initial = reserve(registry, store, 's1');
  const batch = registry.attachContinuationToken(initial, questionBatch());
  registry.release(initial, { status: 'question_batch' });
  const response = {
    batch_id: batch.batch_id,
    batch_snapshot: batch,
    continuation_token: batch.continuation_token,
  };
  store.flushResults = [true, false, true, true];

  assert.throws(
    () => reserve(registry, store, 's1', { interactiveResponse: response }),
    (error) => error.code === INTERACTIVE_ERROR_CODES.INVALID_CONTINUATION
      && error.reason === 'consume_persist_failed'
  );
  assert.equal(store.getActiveTurn('s1'), null);
  assert.equal(
    store.getSession('s1').pending_question_batch.continuation_token.consumed,
    false
  );
  const retry = reserve(registry, store, 's1', { interactiveResponse: response });
  assert.equal(retry.identity.generation, 3);
});

test('continuation restore refusal persists a recovery marker and heals before retry', () => {
  for (const failureMode of ['update', 'flush']) {
    const store = new FakeStore({ s1: {} });
    const registry = createRegistry();
    const initial = reserve(registry, store, 's1');
    const batch = registry.attachContinuationToken(initial, questionBatch());
    registry.release(initial, { status: 'question_batch' });
    const response = {
      batch_id: batch.batch_id,
      batch_snapshot: batch,
      continuation_token: batch.continuation_token,
    };
    if (failureMode === 'update') store.preferenceResults = [true, false];
    if (failureMode === 'flush') store.flushResults = [true, true, false, true];

    const attempt = reserve(registry, store, 's1', { interactiveResponse: response });
    const released = registry.release(attempt, { status: 'runtime_error' });
    assert.equal(released.recoveryBlocked, 'continuation_restore_failed');
    assert.equal(
      store.getActiveTurn('s1').continuation_restore_required,
      true
    );

    const retry = reserve(registry, store, 's1', { interactiveResponse: response });
    assert.equal(retry.identity.generation, 3);
    assert.equal(
      store.getSession('s1').pending_question_batch.continuation_token.consumed,
      true
    );
  }
});

test('failed continuation replacement restores the prior token and leaves no ghost batch', () => {
  const store = new FakeStore({ s1: {} });
  const registry = createRegistry();
  const initial = reserve(registry, store, 's1');

  store.flushResults = [false, true];
  assert.throws(
    () => registry.attachContinuationToken(initial, questionBatch('ghost')),
    (error) => error.reason === 'token_persist_failed'
  );
  assert.equal(store.getSession('s1').pending_question_batch, null);

  const firstBatch = registry.attachContinuationToken(initial, questionBatch('first'));
  registry.release(initial, { status: 'question_batch' });
  const response = {
    batch_id: firstBatch.batch_id,
    batch_snapshot: firstBatch,
    continuation_token: firstBatch.continuation_token,
  };
  const continuation = reserve(registry, store, 's1', { interactiveResponse: response });
  store.flushResults = [false, true];
  assert.throws(
    () => registry.attachContinuationToken(continuation, questionBatch('replacement')),
    (error) => error.reason === 'token_persist_failed'
  );
  assert.equal(
    store.getSession('s1').pending_question_batch.continuation_token.token_id,
    firstBatch.continuation_token.token_id
  );
  registry.release(continuation, { status: 'runtime_error' });
  assert.equal(
    store.getSession('s1').pending_question_batch.continuation_token.consumed,
    false
  );
  const retry = reserve(registry, store, 's1', { interactiveResponse: response });
  assert.equal(retry.identity.generation, 3);
});

test('continuation validation rejects a tampered batch snapshot before consuming the token', () => {
  const store = new FakeStore({ s1: {} });
  const registry = createRegistry();
  const initial = reserve(registry, store, 's1');
  const batch = registry.attachContinuationToken(initial, questionBatch());
  registry.release(initial, { status: 'question_batch' });

  assert.throws(
    () => reserve(registry, store, 's1', {
      interactiveResponse: {
        batch_id: batch.batch_id,
        batch_snapshot: {
          ...batch,
          questions: [{ ...batch.questions[0], prompt: 'Tampered prompt' }],
        },
        continuation_token: batch.continuation_token,
      },
    }),
    (error) => error.code === INTERACTIVE_ERROR_CODES.INVALID_CONTINUATION
      && error.reason === 'batch_snapshot_mismatch'
  );
  assert.equal(
    store.getSession('s1').pending_question_batch.continuation_token.consumed,
    false
  );
  assert.equal(store.getActiveTurn('s1'), null);
});

test('legacy pending batches upgrade once and retain a retryable token after failure', () => {
  const legacyBatch = questionBatch('legacy_batch');
  const store = new FakeStore({
    s1: { pending_question_batch: legacyBatch },
  });
  const registry = createRegistry();
  const interactiveResponse = {
    batch_id: legacyBatch.batch_id,
    batch_snapshot: legacyBatch,
  };

  const attempt = reserve(registry, store, 's1', { interactiveResponse });
  assert.equal(attempt.identity.generation, 2);
  const upgraded = store.getSession('s1').pending_question_batch.continuation_token;
  assert.ok(upgraded.token_id);
  assert.equal(upgraded.consumed, true);

  registry.release(attempt, { status: 'preflight_failure' });
  assert.equal(
    store.getSession('s1').pending_question_batch.continuation_token.consumed,
    false
  );

  const retry = reserve(registry, store, 's1', { interactiveResponse });
  registry.release(retry, { status: 'completed' });
  assert.throws(
    () => reserve(registry, store, 's1', { interactiveResponse }),
    (error) => error.code === INTERACTIVE_ERROR_CODES.INVALID_CONTINUATION
      && error.reason === 'token_consumed'
  );
});

test('first store attachment hydrates persisted identity after a metadata mutation', async () => {
  const batch = questionBatch('batch_after_rename');
  const token = {
    token_id: 'token_after_rename',
    session_id: 's1',
    session_incarnation: 'inc_persisted',
    batch_id: batch.batch_id,
    prior_generation: 4,
    consumed: false,
    issued_at: '2026-07-13T10:00:00.000Z',
  };
  const store = new FakeStore({
    s1: {
      session_incarnation: token.session_incarnation,
      turn_generation: 4,
      pending_question_batch: { ...batch, continuation_token: token },
    },
  });
  const registry = createRegistry();

  await registry.runSessionMutation('s1', 'test.rename', () => ({ renamed: true }));
  const lease = reserve(registry, store, 's1', {
    interactiveResponse: {
      batch_id: batch.batch_id,
      batch_snapshot: { ...batch, continuation_token: token },
      continuation_token: token,
    },
  });

  assert.equal(lease.identity.sessionIncarnation, token.session_incarnation);
  assert.equal(lease.identity.generation, 5);
});

test('idle-only session mutations reject an active turn before commit', () => {
  const store = new FakeStore({ s1: {} });
  const registry = createRegistry();
  const lease = reserve(registry, store, 's1');
  let committed = false;

  assert.throws(
    () => registry.runSessionMutation(
      's1',
      'test.edit',
      () => null,
      () => { committed = true; },
      { requireIdle: true }
    ),
    (error) => error.code === 'session_busy'
  );
  assert.equal(committed, false);
  registry.release(lease, { status: 'completed' });
});

test('deletion settles while cancelling, then tombstone drops writes during async delete', async () => {
  const logs = [];
  const store = new FakeStore({ s1: {} });
  const registry = createRegistry({ logger: (...entry) => logs.push(entry) });
  const lease = reserve(registry, store, 's1');
  let aborted = 0;
  let settle;
  const controller = {
    abort() { aborted += 1; },
    _pendingPromise: new Promise((resolve) => { settle = resolve; }),
  };
  registry.attachController(lease, controller);

  const handle = registry.beginDeletion('s1');
  let mutated = false;
  assert.equal(registry.guard(lease, 'test.settle_write', () => { mutated = true; }), undefined);
  assert.equal(mutated, true, 'the current lease may settle before quiescence');
  assert.equal(aborted, 1);
  assert.throws(() => reserve(registry, store, 's1'), (error) => error.code === 'session_busy');

  settle();
  registry.release(lease, { status: 'cancelled' });
  assert.equal((await registry.awaitQuiescence(handle, { timeoutMs: 50 })).ok, true);
  let finishDelete;
  const deletion = registry.commitDeletion(handle, async () => {
    await new Promise((resolve) => { finishDelete = resolve; });
    return { ok: true, deleted: true };
  });
  assert.equal(registry.guard(lease, 'test.delete_write', () => true), null);
  assert.ok(logs.some(([level, event, details]) => (
    level === 'WARN'
    && event === 'lifecycle.stale_mutation_dropped'
    && details.reason === 'session_tombstoned'
  )));
  finishDelete();
  assert.deepEqual(await deletion, { ok: true, result: { ok: true, deleted: true } });
  assert.equal(registry.guard(lease, 'test.after_delete', () => true), null);
});

test('deletion rollback keeps an unresolved aborted lease as the admission barrier', async () => {
  const store = new FakeStore({ s1: {} });
  const registry = createRegistry();
  const lease = reserve(registry, store, 's1');
  let aborted = false;
  let settle;
  registry.attachController(lease, {
    abort() { aborted = true; },
    _pendingPromise: new Promise((resolve) => { settle = resolve; }),
  });

  const handle = registry.beginDeletion('s1');
  assert.deepEqual(await registry.awaitQuiescence(handle, { timeoutMs: 0 }), {
    ok: false,
    quiesced: false,
    timedOut: true,
    reason: 'quiescence_timeout',
  });
  assert.equal(registry.rollbackDeletion(handle), true);
  assert.equal(aborted, true);
  assert.throws(() => reserve(registry, store, 's1'), (error) => (
    error.code === 'session_busy' && error.reason === 'lease_active'
  ));

  settle();
  registry.release(lease, { status: 'cancelled' });
  const replacement = reserve(registry, store, 's1');
  assert.equal(replacement.identity.generation, 2);
});

test('deletion waits on the actor lease even before a controller pending promise exists', async () => {
  const store = new FakeStore({ s1: {} });
  const registry = createRegistry();
  const lease = reserve(registry, store, 's1');

  const handle = registry.beginDeletion('s1');
  assert.deepEqual(await registry.awaitQuiescence(handle, { timeoutMs: 0 }), {
    ok: false,
    quiesced: false,
    timedOut: true,
    reason: 'quiescence_timeout',
  });
  assert.equal(registry.rollbackDeletion(handle), true);

  registry.release(lease, { status: 'preflight_failed' });
  const replacement = reserve(registry, store, 's1');
  assert.equal(replacement.identity.generation, 2);
});

test('deletion waits for lease settlement after provider quiescence', async () => {
  const store = new FakeStore({ s1: {} });
  const registry = createRegistry();
  const lease = reserve(registry, store, 's1');
  const handle = registry.beginDeletion('s1');

  registry.markProviderQuiesced(lease);
  assert.deepEqual(await registry.awaitQuiescence(handle, { timeoutMs: 0 }), {
    ok: false,
    quiesced: false,
    timedOut: true,
    reason: 'quiescence_timeout',
  });

  registry.release(lease, { status: 'cancelled' });
  assert.equal((await registry.awaitQuiescence(handle, { timeoutMs: 50 })).ok, true);
});

test('controller attached after deletion begins is cancelled and never left registered', async () => {
  const store = new FakeStore({ s1: {} });
  const registry = createRegistry();
  const activeStreams = new Map();
  const lease = reserve(registry, store, 's1', { activeStreams });
  let abortReason = null;
  const controller = {
    abort(reason) { abortReason = reason; },
  };
  const handle = registry.beginDeletion('s1', {
    cancel(streamId, attachedController) {
      if (!attachedController) return false;
      attachedController.abort(Object.assign(new Error('deleted'), {
        cancel_reason: 'session_delete',
      }));
      activeStreams.delete(streamId);
      return true;
    },
  });

  assert.equal(registry.attachController(lease, controller), false);
  assert.equal(abortReason.cancel_reason, 'session_delete');
  assert.equal(activeStreams.has(lease.identity.streamId), false);

  registry.release(lease, { status: 'cancelled' });
  assert.equal((await registry.awaitQuiescence(handle, { timeoutMs: 50 })).ok, true);
});

test('concurrent deletion commits share one physical mutation and stable result', async () => {
  const store = new FakeStore({ s1: {} });
  const registry = createRegistry();
  const handle = registry.beginDeletion('s1');
  assert.equal((await registry.awaitQuiescence(handle)).quiesced, true);
  let mutations = 0;
  let finishDelete;
  const mutation = async () => {
    mutations += 1;
    await new Promise((resolve) => { finishDelete = resolve; });
    return { object: 'session', id: 's1', deleted: true };
  };

  const first = registry.commitDeletion(handle, mutation);
  const second = registry.commitDeletion(handle, mutation);
  assert.equal(first, second);
  assert.equal(mutations, 1);
  assert.throws(() => reserve(registry, store, 's1'), (error) => (
    error.code === 'session_busy' && error.reason === 'session_deleting'
  ));

  finishDelete();
  const expected = {
    ok: true,
    result: { object: 'session', id: 's1', deleted: true },
  };
  assert.deepEqual(await first, expected);
  assert.deepEqual(await second, expected);

  const repeated = registry.beginDeletion('s1');
  assert.equal(repeated.alreadyCommitted, true);
  assert.deepEqual(await registry.commitDeletion(repeated, async () => {
    throw new Error('must not run');
  }), { ...expected, alreadyCommitted: true });
  assert.equal(mutations, 1);
});

test('refused deletion rolls back only after the shared physical mutation settles', async () => {
  const store = new FakeStore({ s1: {} });
  const registry = createRegistry();
  const handle = registry.beginDeletion('s1');
  assert.equal((await registry.awaitQuiescence(handle)).quiesced, true);

  const first = registry.commitDeletion(handle, async () => ({
    object: 'session', id: 's1', deleted: false,
  }));
  const second = registry.commitDeletion(handle, async () => {
    throw new Error('duplicate mutation must not run');
  });
  assert.equal(first, second);
  assert.deepEqual(await first, {
    ok: false,
    reason: 'delete_refused',
    result: { object: 'session', id: 's1', deleted: false },
  });
  assert.equal(registry.rollbackDeletion(handle), true);
  assert.equal(registry.rollbackDeletion(handle), false);
  const replacement = reserve(registry, store, 's1');
  assert.equal(replacement.identity.generation, 1);
});

test('deletion commit rejects malformed or ambiguous success shapes', async () => {
  for (const result of [null, {}, { deleted: null }, { ok: false }, { deleted: false }]) {
    const registry = createRegistry();
    const handle = registry.beginDeletion('s1');
    assert.equal((await registry.awaitQuiescence(handle)).ok, true);

    assert.deepEqual(await registry.commitDeletion(handle, async () => result), {
      ok: false,
      reason: 'delete_refused',
      result,
    });
    assert.equal(registry.rollbackDeletion(handle), true);
  }
});

test('bounded registry evicts the oldest idle actor', () => {
  const logs = [];
  const store = new FakeStore({ s1: {}, s2: {}, s3: {} });
  const registry = createRegistry({
    maxActors: 2,
    logger: (...entry) => logs.push(entry),
  });

  const first = reserve(registry, store, 's1');
  registry.release(first, { status: 'completed' });
  const second = reserve(registry, store, 's2');
  registry.release(second, { status: 'completed' });
  const third = reserve(registry, store, 's3');

  assert.equal(registry.size, 2);
  assert.ok(logs.some(([, event, details]) => (
    event === 'lifecycle.session_turn_actor_evicted' && details.sessionId === 's1'
  )));
  assert.equal(registry.guard(first, 'test.evicted_actor', () => true), null);
  registry.release(third, { status: 'completed' });
});

test('actor eviction reloads the same incarnation and advances persisted generation', () => {
  const store = new FakeStore({ s1: {}, s2: {} });
  const registry = createRegistry({ maxActors: 1 });
  const first = reserve(registry, store, 's1');
  const incarnation = first.identity.sessionIncarnation;
  registry.release(first, { status: 'completed' });
  const other = reserve(registry, store, 's2');
  registry.release(other, { status: 'completed' });

  const next = reserve(registry, store, 's1');

  assert.equal(next.identity.sessionIncarnation, incarnation);
  assert.equal(next.identity.generation, 2);
});

test('registry never evicts a fail-closed recovery actor', () => {
  const store = new FakeStore({
    s1: {
      active_turn: {
        request_id: 'blocked_turn',
        stream_id: 'blocked_stream',
        user_message_id: 'blocked_user',
        session_incarnation: 'inc_blocked',
        generation: 1,
        started_at: '2026-07-13T10:00:00.000Z',
        last_event_at: '2026-07-13T10:00:00.000Z',
        status: 'streaming',
      },
      messages: [{
        id: 'assistant_blocked_stream',
        role: 'assistant',
        content: 'Complete.',
        status: 'completed',
        terminal_status: 'completed',
        parent_stream_id: 'blocked_stream',
      }],
    },
    s2: {},
    s3: {},
  }, { flushResults: [false, true] });
  const registry = createRegistry({ maxActors: 2 });
  assert.throws(() => reserve(registry, store, 's1'));
  const second = reserve(registry, store, 's2');
  registry.release(second, { status: 'completed' });
  const third = reserve(registry, store, 's3');

  const recovered = reserve(registry, store, 's1');

  assert.equal(recovered.identity.sessionIncarnation, 'inc_blocked');
  assert.equal(registry.guard(second, 'test.evicted_recovery_peer', () => true), null);
  registry.release(third, { status: 'completed' });
});

test('ensureSessionTurnActorRegistry memoizes both service aliases', () => {
  const service = { _emitServiceLog() {} };
  const first = ensureSessionTurnActorRegistry(service);
  const second = ensureSessionTurnActorRegistry(service);

  assert.equal(first, second);
  assert.equal(service.sessionTurnActorRegistry, first);
  assert.equal(service.sessionTurnActors, first);
});
