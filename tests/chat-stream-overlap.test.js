'use strict';

// Red-first coverage for B1 (backend per-session in-flight admission control)
// and the B3 follow-on (activeStreams leak no longer locks out inline
// completion) — see the plan at
// the original B1/B3 concurrency plan, Slice 1.
//
// B1: startManagedSidecarChatStream / startExternalChatStream must reject a
// second concurrent send on the same session with a structured
// `code: 'session_busy'` error, UNLESS the prior active_turn is orphaned
// (no live activeStreams controller AND a stale heartbeat).
//
// B3 follow-on: a rejected preflight (managed image-attachment validation,
// external resolveModel failure — covered directly in
// tests/managed-sidecar/managed-sidecar-chat-preflight.test.js for managed)
// must not leave a phantom activeStreams entry; this file asserts the
// downstream consumer (generateInlineCompletion) is unblocked afterward.

const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  startManagedSidecarChatStream,
} = require('../services/backend/managed-sidecar-chat');
const {
  generateInlineCompletion,
} = require('../services/backend/backend-inline-complete');
const {
  startActiveTurn,
} = require('../services/backend/chat-stream-session-lifecycle');
const { BackendService } = require('../services/backend/backend-service');
const {
  buildManagedChatRequest,
  createManagedChatServiceStub,
} = require('./helpers/managed-sidecar-chat-lifecycle-helpers');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');
const {
  makeTextChunk,
  makeFinishChunk,
} = require('./helpers/tool-loop-harness');
const {
  CHAT_STREAM_IDLE_TIMEOUT_MS,
} = require('../services/backend/chat-stream-admission');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

// --- managed-mode helpers ---

// Makes the managed stub's chatSend hang until the test resolves it,
// simulating a genuinely in-flight (not-yet-terminal) turn.
function stubHangingChatSend(service) {
  let releaseFirstSend = null;
  service.sidecarManager = {
    process: { pid: 4242 },
    getStatus: () => ({ phase: 'ready' }),
  };
  service.sidecarClient = {
    connected: true,
    async chatSend() {
      return new Promise((resolve) => {
        releaseFirstSend = () => resolve({ status: 'completed' });
      });
    },
  };
  return {
    release: () => releaseFirstSend && releaseFirstSend(),
  };
}

// --- external-mode helpers ---

function createExternalBackendService(overrides = {}) {
  const userDataPath = createTrackedTempDir('jenny-chat-stream-overlap-');
  const service = new BackendService({
    userDataPath,
    backendUrl: 'http://127.0.0.1:0/external-stub',
    safeStorage: createFakeSafeStorage(),
    ...overrides,
  });
  return service;
}

function buildExternalRequest({ sessionId, prompt, traceId }) {
  return {
    sessionId,
    prompt,
    visiblePrompt: prompt,
    traceId,
    attachments: [],
    normalizedInteractiveResponse: null,
    normalizedPreferences: {
      preferred_model: '',
      reasoning_effort: 'default',
      conversation_mode: 'chat',
      pending_question_batch: null,
      pending_plan_proposal: null,
      interactive_sequence_state: 'idle',
      interactive_round_count: 0,
      plan_mode: false,
    },
    contextPreferences: undefined,
    clientTiming: null,
  };
}

// --- B1: managed concurrent sends ---

test('B1 managed: a second concurrent send on the same session is rejected as session_busy', async () => {
  const service = createManagedChatServiceStub();
  const hang = stubHangingChatSend(service);
  const sessionId = 'session_overlap_managed_busy';
  service.sessionStore.createSessionWithId(sessionId, {});

  const first = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId,
    prompt: 'first send',
  }));

  // Give the first send's async body a tick to persist the user message and
  // write active_turn before the second send races in.
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(
    startManagedSidecarChatStream(service, buildManagedChatRequest({
      sessionId,
      prompt: 'second send while first is in flight',
    })),
    (error) => {
      assert.equal(error.code, 'session_busy');
      return true;
    }
  );

  assert.equal(service.activeStreams.size, 1, 'only the first controller may be registered');
  assert.equal(
    service.activeStreams.has(first.streamId),
    true,
    'the first stream controller must still be the one registered'
  );
  const activeTurn = service.sessionStore.getActiveTurn(sessionId);
  assert.equal(activeTurn.stream_id, first.streamId, 'active_turn must still point at the first turn');

  hang.release();
  await service.activeStreams.get(first.streamId)._pendingPromise;
});

// L1 scaffolding (Chat Lifecycle v2 plan §3.4/§4): the managed start result
// gains an ADDITIVE `identity` bundle (diagnostics only until wave L2) with
// userMessageId null -- the managed persist happens later, inside pendingRun's
// async body, so it is not known at start-result time (unlike external).
test('B1 managed: start result carries the authoritative actor identity and emits a chat.start_identity debug log', async () => {
  const service = createManagedChatServiceStub();
  const hang = stubHangingChatSend(service);
  const sessionId = 'session_overlap_managed_identity';
  service.sessionStore.createSessionWithId(sessionId, {});

  const result = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId,
    prompt: 'identity bundle send',
  }));

  assert.equal(result.sessionId, sessionId);
  assert.deepEqual(result.identity, {
    sessionId,
    streamId: result.streamId,
    turnId: result.streamId,
    userMessageId: `user_${result.streamId}`,
    sessionRevision: null,
    generation: 1,
  });

  const identityLogs = service.serviceLogs.filter((entry) => entry.event === 'chat.start_identity');
  assert.equal(identityLogs.length, 1);
  assert.equal(identityLogs[0].level, 'DEBUG');
  assert.deepEqual(identityLogs[0].details.identity, result.identity);

  // pendingRun's chatSend() call hasn't been reached yet (the managed
  // entrypoint returns before the async body runs -- see the same-tick race
  // test above); give it a tick before releasing so hang.release() actually
  // has a pending sendCall to resolve.
  await new Promise((resolve) => setImmediate(resolve));
  hang.release();
  await service.activeStreams.get(result.streamId)._pendingPromise;
});

// Finding F-01 (managed): admission is checked synchronously at entry, but
// the durable claim (startActiveTurn) only happens deep inside pendingRun's
// persistUserMessage(), after a setImmediate yield and an awaited prefs
// write -- unlike the external path, the managed entrypoint always returns a
// stream handle immediately (before pendingRun runs at all), so two sends
// fired in the same tick BOTH pass the entry gate. This test does NOT use
// the `await new Promise(setImmediate)` serialization the test above relies
// on -- it fires both sends back-to-back, matching the true race window.
test('B1 managed same-tick race: two concurrent sends racing before either claims win exactly one; the loser is rejected as session_busy with no duplicate turn', async () => {
  const service = createManagedChatServiceStub();
  service.sidecarManager = {
    process: { pid: 4242 },
    getStatus: () => ({ phase: 'ready' }),
  };
  let chatSendCount = 0;
  let releaseWinner = null;
  service.sidecarClient = {
    connected: true,
    async chatSend() {
      chatSendCount += 1;
      return new Promise((resolve) => {
        releaseWinner = releaseWinner || (() => resolve({ status: 'completed' }));
      });
    },
  };

  const sessionId = 'session_overlap_managed_same_tick';
  service.sessionStore.createSessionWithId(sessionId, {});

  // Fire both without awaiting in between. The actor's synchronous reservation
  // is the admission point, so only one outer start may return a stream handle.
  const pA = startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId,
    prompt: 'send A',
  }));
  const pB = startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId,
    prompt: 'send B',
  }));
  const results = await Promise.allSettled([pA, pB]);
  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter((result) => result.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one racing send must be admitted');
  assert.equal(rejected.length, 1, 'exactly one racing send must be rejected');
  assert.equal(rejected[0].reason.code, 'session_busy');
  const winner = fulfilled[0].value;

  // Poll (bounded) for the race to resolve: the loser's `finally` block
  // unregisters its controller once its pendingRun catch path completes;
  // the winner's controller stays registered (chatSend hangs). Pre-fix, both
  // sends are admitted and both hang inside chatSend forever, so
  // activeStreams never drops back to 1 and this loop exhausts its budget.
  let settled = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (service.activeStreams.size === 1 && chatSendCount === 1) {
      settled = true;
      break;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(
    settled,
    true,
    'exactly one racing send must lose and unregister its controller (pre-fix: both are admitted and neither ever settles)'
  );

  assert.equal(chatSendCount, 1, 'only the winning send may reach the sidecar chat.send transport');

  const activeTurn = service.sessionStore.getActiveTurn(sessionId);
  const winnerStreamId = activeTurn && activeTurn.stream_id;
  assert.equal(winnerStreamId, winner.streamId, 'active_turn must point at the admitted send');

  assert.equal(service.activeStreams.has(winnerStreamId), true, 'the winner\'s controller must remain registered');

  const userMessages = service.sessionMessages.filter((message) => message.role === 'user');
  assert.equal(userMessages.length, 1, 'no duplicate user message may be persisted');

  if (releaseWinner) {
    releaseWinner();
  }
  await service.activeStreams.get(winnerStreamId)?._pendingPromise;
});

// --- B1: external concurrent sends ---

// --- orphan-reclaim ---

test('B1 orphan-reclaim: a stale active_turn with no live controller does not block a new managed send', async () => {
  const service = createManagedChatServiceStub();
  service.sidecarManager = {
    process: { pid: 4242 },
    getStatus: () => ({ phase: 'ready' }),
  };
  service.sidecarClient = {
    connected: true,
    async chatSend(_params, options = {}) {
      options.onNotification({ method: 'chat.token', params: { delta: 'Reclaimed.' } });
      options.onNotification({ method: 'chat.done', params: {} });
      return { status: 'completed' };
    },
  };

  const sessionId = 'session_overlap_orphan_reclaim';
  service.sessionStore.createSessionWithId(sessionId, {});
  // Seed a stale active_turn: heartbeat well past CHAT_STREAM_IDLE_TIMEOUT_MS
  // and, critically, NO controller registered in activeStreams for it.
  const staleTimestamp = new Date(Date.now() - (CHAT_STREAM_IDLE_TIMEOUT_MS + 60_000)).toISOString();
  service.sessionStore.setActiveTurn(sessionId, {
    request_id: 'stale_request',
    stream_id: 'stale_stream_no_controller',
    user_message_id: 'user_stale',
    started_at: staleTimestamp,
    last_event_at: staleTimestamp,
    status: 'awaiting_assistant',
  });

  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId,
    prompt: 'send after orphaned turn',
  }));

  await service.activeStreams.get(stream.streamId)._pendingPromise;

  assert.equal(
    service.emittedEvents.some(
      (entry) => entry.eventName === 'chat-stream' && entry.payload?.type === 'complete'
    ),
    true,
    'the new send must complete normally, proving it was not rejected as busy'
  );
});

// --- cancel-race ---

test('B1 cancel-race: busy while the controller is live; crash evidence is reclaimed once it is gone', async () => {
  const service = createManagedChatServiceStub();
  const sessionId = 'session_overlap_cancel_race';
  service.sessionStore.createSessionWithId(sessionId, {});

  const freshTimestamp = new Date().toISOString();
  // Simulate the intentional cancel window: active_turn retained, a
  // controller is still registered (cancel/teardown has not finished).
  service.sessionStore.setActiveTurn(sessionId, {
    request_id: 'cancelled_request',
    stream_id: 'cancelled_stream_live',
    user_message_id: 'user_cancelled',
    started_at: freshTimestamp,
    last_event_at: freshTimestamp,
    status: 'awaiting_assistant',
  });
  service.activeStreams.set('cancelled_stream_live', new AbortController());

  await assert.rejects(
    startManagedSidecarChatStream(service, buildManagedChatRequest({
      sessionId,
      prompt: 'send during cancel teardown',
    })),
    (error) => {
      assert.equal(error.code, 'session_busy');
      return true;
    }
  );

  // Once the controller finishes tearing down, persisted active_turn is crash
  // evidence rather than a runtime mutex. The actor reclaims it immediately.
  service.activeStreams.delete('cancelled_stream_live');
  service.sidecarManager = {
    process: { pid: 4242 },
    getStatus: () => ({ phase: 'ready' }),
  };
  service.sidecarClient = {
    connected: true,
    async chatSend(_params, options = {}) {
      options.onNotification({ method: 'chat.token', params: { delta: 'Recovered.' } });
      options.onNotification({ method: 'chat.done', params: {} });
      return { status: 'completed' };
    },
  };

  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId,
    prompt: 'send once the prior controller is gone',
  }));
  await service.activeStreams.get(stream.streamId)._pendingPromise;

  assert.equal(
    service.emittedEvents.some(
      (entry) => entry.eventName === 'chat-stream' && entry.payload?.type === 'complete'
    ),
    true
  );
});

// --- B3 follow-on: external resolveModel failure does not leak activeStreams ---

// --- B3 follow-on: inline completion is unblocked after a rejected send ---

test('B3 follow-on: generateInlineCompletion is no longer locked out after a rejected managed send', async () => {
  const service = createManagedChatServiceStub();
  const tempDir = createTrackedTempDir('jenny-overlap-image-reject-');
  service.sidecarManager = {
    process: { pid: 4242 },
    getStatus: () => ({ phase: 'ready' }),
  };
  service.attachmentAssetStore = {
    resolveManagedAssetRealPath() {
      // Falsy return forces validateImageAttachmentsForManagedSend to throw
      // "Image attachments must come from the app-managed local asset store."
      return '';
    },
  };
  let chatSendCount = 0;
  service.sidecarClient = {
    connected: true,
    async chatSend() {
      chatSendCount += 1;
      throw new Error('chat.send must not run when image validation rejects the send');
    },
  };

  await assert.rejects(
    startManagedSidecarChatStream(service, buildManagedChatRequest({
      sessionId: 'session_overlap_inline_unblock',
      prompt: 'Describe this image',
      attachments: [{
        id: 'att_overlap',
        kind: 'image',
        assetPath: path.join(tempDir, 'logical.png'),
        displayName: 'logical.png',
        mimeType: 'image/png',
        sizeBytes: 10,
        width: 1,
        height: 1,
      }],
    })),
    /app-managed local asset store/
  );

  assert.equal(chatSendCount, 0);
  assert.equal(service.activeStreams.size, 0, 'rejected preflight must not leak an active stream');

  // Prove the lockout is gone: inline completion must not see chat_stream_active.
  service.sidecarManager = { getStatus: () => ({ phase: 'ready' }) };
  let requestCalled = false;
  service.sidecarClient = {
    async request(_method, _params) {
      requestCalled = true;
      return { completion: 'const x = 1;' };
    },
  };
  const result = await generateInlineCompletion(service, {
    prefix: 'const x =',
    suffix: '',
    model: 'fim-model',
  });

  assert.equal(result.ok, true);
  assert.notEqual(result.reason, 'chat_stream_active');
  assert.equal(requestCalled, true);
});

// --- CAS-aware setActiveTurn: second line of defense ---

test('startActiveTurn CAS guard: a stale write is rejected once a different stream already claimed the slot', () => {
  const sessionRecords = new Map();
  const adapter = {
    setActiveTurn(activeTurn, options) {
      const sessionId = 'session_cas_guard';
      const current = sessionRecords.get(sessionId) || null;
      if (options?.expectedPriorStreamId && current
        && current.stream_id !== options.expectedPriorStreamId) {
        return null;
      }
      sessionRecords.set(sessionId, activeTurn);
      return activeTurn;
    },
  };

  // Turn A claims the empty slot.
  const resultA = startActiveTurn(adapter, {
    requestId: 'req_a',
    streamId: 'stream_a',
    userMessageId: 'user_a',
    expectedPriorStreamId: 'stream_a',
  });
  assert.ok(resultA, 'the first CAS write into an empty slot must succeed');
  assert.equal(resultA.stream_id, 'stream_a');

  // Turn B races in with a stale pre-read (its own CAS token) after A already
  // won -- the guard must reject B's write rather than clobber A.
  const resultB = startActiveTurn(adapter, {
    requestId: 'req_b',
    streamId: 'stream_b',
    userMessageId: 'user_b',
    expectedPriorStreamId: 'stream_b',
  });
  assert.equal(resultB, null, 'a second claim on an already-owned slot must be rejected');
  assert.equal(sessionRecords.get('session_cas_guard').stream_id, 'stream_a', 'A must remain the owner');
});

test('setActiveTurn CAS guard: electron-session-store and session-shadow-store both honor expectedPriorStreamId', () => {
  const {
    ElectronSessionStore,
  } = require('../services/backend/electron-session-store');
  const {
    SessionShadowStore,
  } = require('../services/backend/session-shadow-store');

  for (const StoreClass of [ElectronSessionStore, SessionShadowStore]) {
    const tempDir = createTrackedTempDir('jenny-cas-guard-store-');
    const filePath = path.join(tempDir, 'store.json');
    const store = new StoreClass(filePath);
    const sessionId = 'session_cas_guard_store';
    if (typeof store.createSessionWithId === 'function') {
      store.createSessionWithId(sessionId, { title: 'CAS guard' });
    } else {
      store.upsertSession(sessionId, { title: 'CAS guard' });
    }

    const timestamp = new Date().toISOString();
    const turnA = {
      request_id: 'req_a',
      stream_id: 'stream_a',
      user_message_id: 'user_a',
      started_at: timestamp,
      last_event_at: timestamp,
      status: 'awaiting_assistant',
    };
    store.setActiveTurn(sessionId, turnA, { expectedPriorStreamId: 'stream_a' });
    assert.equal(store.getActiveTurn(sessionId).stream_id, 'stream_a');

    const turnB = {
      request_id: 'req_b',
      stream_id: 'stream_b',
      user_message_id: 'user_b',
      started_at: timestamp,
      last_event_at: timestamp,
      status: 'awaiting_assistant',
    };
    const rejected = store.setActiveTurn(sessionId, turnB, { expectedPriorStreamId: 'stream_b' });
    assert.equal(rejected, null, `${StoreClass.name} must reject a CAS write when the slot is already owned`);
    assert.equal(store.getActiveTurn(sessionId).stream_id, 'stream_a', `${StoreClass.name} must keep the original owner`);

    // Omitting the guard preserves the historical bare-overwrite behavior.
    store.setActiveTurn(sessionId, turnB);
    assert.equal(store.getActiveTurn(sessionId).stream_id, 'stream_b', `${StoreClass.name} must still allow an unguarded overwrite`);
  }
});

// --- external active_turn lifecycle (audit follow-ups on the external bracket) ---

// Regression guard for a real invariant (this was NOT a live bug): a completed
// external turn must leave NO active_turn, so the next send is admitted rather
// than falsely gated as session_busy, and so the startup reconciler does not
// crash-settle a turn that actually completed. settleAssistantCompletion clears
// the bracket on normal completion (settleQuestionBatch on the question-batch
// L1 scaffolding (Chat Lifecycle v2 plan §3.4/§4): startExternalChatStream's
// return value gains an ADDITIVE `identity` bundle (the §3.4 authoritative
// identity shape, diagnostics-only until wave L2 makes it the real contract)
// plus a 'chat.start_identity' debug log. streamId/sessionId stay unchanged.
// outcome; the catch clears it on failure/cancel) — this locks that in end-to-end.
test('B1 managed: success clears active_turn so an immediate follow-up send is admitted', async () => {
  const service = createManagedChatServiceStub();
  service.sidecarManager = {
    process: { pid: 4242 },
    getStatus: () => ({ phase: 'ready' }),
  };
  let sendCount = 0;
  service.sidecarClient = {
    connected: true,
    async chatSend(_params, { onNotification }) {
      sendCount += 1;
      onNotification({ method: 'chat.token', params: { delta: `Reply ${sendCount}.` } });
      onNotification({ method: 'chat.done', params: {} });
      return { status: 'completed' };
    },
  };
  const sessionId = 'session_managed_success_clear';
  service.sessionStore.createSessionWithId(sessionId, {});

  const first = await startManagedSidecarChatStream(
    service,
    buildManagedChatRequest({ sessionId, prompt: 'first managed send' })
  );
  await service.activeStreams.get(first.streamId)._pendingPromise;
  assert.equal(service.sessionStore.getActiveTurn(sessionId), null);
  assert.equal(service.activeStreams.size, 0);

  const second = await startManagedSidecarChatStream(
    service,
    buildManagedChatRequest({ sessionId, prompt: 'immediate follow-up' })
  );
  await service.activeStreams.get(second.streamId)._pendingPromise;
  assert.equal(sendCount, 2);
  assert.notEqual(second.streamId, first.streamId);
});

// L4 terminal coordination keeps the actor bracket and durable repair artifact
// intact when the external store refuses the terminal commit.
// L3 durability fencing rejects an external turn before provider admission
// when its user message cannot be proven durable.
// Finding: the external startActiveTurn passed expectedPriorStreamId=<new streamId>,
// so a CAS write over an admissible reclaimable orphan (a stale, DIFFERENT stream_id)
// silently no-oped, stranding active_turn on the dead stream instead of claiming it.
// Finding: external admission is checked synchronously at entry, but active_turn
// and the controller are not claimed until AFTER several async-preflight awaits,
// so a second concurrent send passes the entry gate during the first send's
// preflight and (pre-fix) ran a duplicate turn. The synchronous re-check + claim
// must let exactly one send win.
