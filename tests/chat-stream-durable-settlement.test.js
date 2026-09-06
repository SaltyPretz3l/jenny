// CTL-002 acceptance contract: visible completion and durable settlement are
// distinct states. Immediate paint stays, but a refused persist must produce a
// structured degraded result (never a success shape), must retain recovery
// provenance (active_turn, interactive pending state, title), and must surface
// a bounded user-visible "reply not saved" warning. Failures cross seams as
// structured results, not thrown exceptions.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createSessionLifecycleAdapter,
  settleAssistantCompletion,
} = require('../services/backend/chat-stream-session-lifecycle');
const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { SessionShadowStore } = require('../services/backend/session-shadow-store');
const { startManagedSidecarChatStream } = require('../services/backend/managed-sidecar-chat');
const {
  buildManagedChatRequest,
  createManagedChatServiceStub,
} = require('./helpers/managed-sidecar-chat-lifecycle-helpers');
const { createHarness } = require('./helpers/renderer-stream-handler-harness');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

// ---------------------------------------------------------------------------
// Lifecycle seam: settleAssistantCompletion result contract
// ---------------------------------------------------------------------------

function createRefusableAdapterHarness({ refuseAppend = false, refuseIdPattern = null } = {}) {
  const messages = [];
  const preferences = [];
  const titles = [];
  let activeTurn = { request_id: 'req_1', stream_id: 'stream_1', status: 'streaming' };
  const adapter = createSessionLifecycleAdapter({
    appendMessage(message, options = {}) {
      if (refuseAppend || (refuseIdPattern && refuseIdPattern.test(String(message?.id || '')))) {
        return null;
      }
      messages.push({ ...message, _options: { ...options } });
      return message;
    },
    setSessionPreferences(next) {
      preferences.push({ ...next });
      return next;
    },
    getActiveTurn() {
      return activeTurn;
    },
    setActiveTurn(next) {
      activeTurn = next;
      return next;
    },
    touchActiveTurn(match, patch) {
      if (!activeTurn) return null;
      activeTurn = { ...activeTurn, ...patch };
      return activeTurn;
    },
    clearActiveTurn() {
      activeTurn = null;
      return null;
    },
    async applySessionTitle(title, options = {}) {
      titles.push({ title, reason: options.reason });
      return { title };
    },
  });
  return {
    adapter,
    messages,
    preferences,
    titles,
    get activeTurn() { return activeTurn; },
  };
}

const INTERACTIVE_RESPONSE_FIXTURE = {
  batch_id: 'ib_durable_1',
  round_index: 1,
  batch_snapshot: {
    batch_id: 'ib_durable_1',
    round_index: 1,
    questions: [{ id: 'q1', prompt: 'Pace?', options: [{ id: 'steady', label: 'Steady' }] }],
  },
  answers: [{ question_id: 'q1', option_id: 'steady', text: '' }],
};

test('refused assistant append settles as a structured degraded result and retains recovery state', async () => {
  const harness = createRefusableAdapterHarness({ refuseAppend: true });

  const result = await settleAssistantCompletion(harness.adapter, {
    messageId: 'assistant_stream_1',
    content: 'An answer the store refused.',
    reasoningEntries: [],
    model: 'mock-v1',
    requestId: 'req_1',
    streamId: 'stream_1',
    normalizedPreferences: {},
    normalizedInteractiveResponse: INTERACTIVE_RESPONSE_FIXTURE,
    exchangeTitle: 'A title that must not apply',
    timestamp: '2026-07-09T12:00:00.000Z',
  });

  assert.equal(result.ok, false, 'a refused persist must not return a success shape');
  assert.equal(result.reason, 'assistant_persist_refused');
  assert.ok(harness.activeTurn, 'active_turn is the recovery bracket and must survive a refused persist');
  assert.deepEqual(harness.preferences, [], 'interactive pending state must not reset when its message never persisted');
  assert.deepEqual(harness.titles, [], 'the exchange title must not apply on a refused persist');
  assert.deepEqual(harness.messages, [], 'no interactive recap may be appended for an unpersisted completion');
});

// Green pin: the success path keeps today's behavior and now says so explicitly.
test('accepted assistant append settles ok:true and clears interactive pending state', async () => {
  const harness = createRefusableAdapterHarness();

  const result = await settleAssistantCompletion(harness.adapter, {
    messageId: 'assistant_stream_1',
    content: 'All set.',
    reasoningEntries: [],
    model: 'mock-v1',
    requestId: 'req_1',
    streamId: 'stream_1',
    normalizedPreferences: {},
    normalizedInteractiveResponse: null,
    exchangeTitle: 'Applied title',
    timestamp: '2026-07-09T12:00:00.000Z',
  });

  assert.equal(result.ok, true);
  assert.equal(harness.activeTurn, null, 'a durable completion clears the recovery bracket');
  assert.equal(harness.preferences.length, 1);
  assert.deepEqual(harness.titles, [{ title: 'Applied title', reason: 'complete' }]);
  assert.equal(harness.messages[0].id, 'assistant_stream_1');
});

// Code-review pin (2026-07-10): a refused auxiliary recap append must be
// REPORTED by the settle result (recapPersisted:false — the runtime turns it
// into the chat.round_recap_persist_refused WARN), while the reply itself
// stays a durable ok:true settle.
test('refused interactive-round recap: settle stays ok:true but reports recapPersisted:false', async () => {
  const harness = createRefusableAdapterHarness({ refuseIdPattern: /^interactive_round_recap_/ });

  const result = await settleAssistantCompletion(harness.adapter, {
    messageId: 'assistant_stream_1',
    content: 'The durable answer.',
    reasoningEntries: [],
    model: 'mock-v1',
    requestId: 'req_1',
    streamId: 'stream_1',
    normalizedPreferences: {},
    normalizedInteractiveResponse: INTERACTIVE_RESPONSE_FIXTURE,
    exchangeTitle: '',
    timestamp: '2026-07-09T12:00:00.000Z',
  });

  assert.equal(result.ok, true, 'the reply persisted; only the auxiliary recap was refused');
  assert.equal(result.recapPersisted, false, 'the refused recap must be reported, not swallowed');
  assert.equal(harness.messages.length, 1, 'only the assistant row landed');
  assert.equal(harness.messages[0].id, 'assistant_stream_1');
});

// ---------------------------------------------------------------------------
// Store seam: the refusal shapes the settle path must be able to diagnose
// ---------------------------------------------------------------------------

function freshStore(options = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-durable-settle-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'sessions.json');
  const store = new ElectronSessionStore(storePath, { writeDebounceMs: 0, ...options });
  return { store, storePath, userDataPath };
}

function bumpSchemaVersionOnDisk(userDataPath) {
  const stack = [userDataPath];
  let bumped = 0;
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (!entry.name.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(entryPath, 'utf8'));
        if (parsed && typeof parsed === 'object' && Number.isFinite(Number(parsed.schema_version))) {
          parsed.schema_version = Number(parsed.schema_version) + 1;
          fs.writeFileSync(entryPath, JSON.stringify(parsed));
          bumped += 1;
        }
      } catch {
        // Non-JSON or unreadable file: not a schema carrier.
      }
    }
  }
  return bumped;
}

test('future-schema freeze: appendMessage refuses with null and the store reports hasNewerSchema', () => {
  const { store, storePath, userDataPath } = freshStore();
  const { id: sessionId } = store.createSession({ title: 'Freeze' });
  store.appendMessage(sessionId, {
    id: 'user_pre_freeze', role: 'user', content: 'before freeze', timestamp: '2026-07-09T10:00:00.000Z',
  });
  store.flush();
  store.dispose();

  const bumped = bumpSchemaVersionOnDisk(userDataPath);
  assert.ok(bumped > 0, 'fixture must find at least one schema_version carrier on disk');

  const frozen = new ElectronSessionStore(storePath, { writeDebounceMs: 0 });
  assert.equal(frozen.hasNewerSchema(), true, 'the store must expose the freeze so callers can diagnose future_schema');
  const refused = frozen.appendMessage(sessionId, {
    id: 'user_during_freeze', role: 'user', content: 'during freeze', timestamp: '2026-07-09T10:01:00.000Z',
  });
  assert.equal(refused, null, 'a frozen store refuses the append with null, not a phantom summary');
  frozen.dispose();
});

// Green pin: the unknown-session refusal surface the runtime derives its
// `unknown_session` reason from.
test('unknown session: appendMessage refuses with null and hasNewerSchema stays false', () => {
  const { store } = freshStore();
  assert.equal(store.hasNewerSchema(), false);
  const refused = store.appendMessage('session_never_created', {
    id: 'user_orphan', role: 'user', content: 'no home', timestamp: '2026-07-09T10:00:00.000Z',
  });
  assert.equal(refused, null);
  store.dispose();
});

// Characterization pin of the qualified review finding: a flushSession failure
// after a cached accept reports an honest false, retains the record, and a
// later flush (or restart) still lands the message — it is retried, not lost.
test('flushSession failure after cached accept is honest, retained, and recoverable across restart', () => {
  const { store, storePath } = freshStore({ writeDebounceMs: 60000 });
  const { id: sessionId } = store.createSession({ title: 'Flush failure' });
  const accepted = store.appendMessage(sessionId, {
    id: 'assistant_flush_fail', role: 'assistant', content: 'answer at risk', timestamp: '2026-07-09T10:00:00.000Z',
  });
  assert.ok(accepted, 'the append is accepted into cache before any disk write');

  // Deterministic disk-failure injection at the write seam the flush path
  // uses; the retention/reporting logic under test is the real store's.
  const sessionFileStore = store._backend._getOrCreateSessionStore(sessionId);
  const realWriteImmediate = sessionFileStore.writeImmediate.bind(sessionFileStore);
  sessionFileStore.writeImmediate = () => {
    throw new Error('EIO: injected disk failure');
  };
  assert.equal(store.flushSession(sessionId), false, 'a failed durability flush must report false, never true');
  sessionFileStore.writeImmediate = realWriteImmediate;

  assert.equal(store.flushSession(sessionId), true, 'the record is retained and a later flush lands it');
  store.flush();
  store.dispose();

  const reloaded = new ElectronSessionStore(storePath, { writeDebounceMs: 0 });
  const session = reloaded.getSession(sessionId);
  const survived = (session?.messages || []).find((m) => String(m.id) === 'assistant_flush_fail');
  assert.ok(survived, 'the accepted message survives restart once a flush succeeds');
  assert.equal(survived.content, 'answer at risk');
  reloaded.dispose();
});

// ---------------------------------------------------------------------------
// Managed end-to-end: failure after visible paint surfaces a bounded warning
// and keeps the recovery bracket
// ---------------------------------------------------------------------------

function driveSimpleManagedTurn(service, sessionId, { prompt = 'hello', answer = 'the answer' } = {}) {
  service.sessionStore.createSessionWithId(sessionId, {
    title: 'Durable settle',
    preferences: { preferred_model: 'mock-v1', session_start_date: '2026-07-09' },
  });
  service.sidecarClient = {
    chatSend: async (_params, options = {}) => {
      options.onNotification({ method: 'chat.token', params: { delta: answer } });
      options.onNotification({ method: 'chat.done', params: {} });
      return { status: 'completed' };
    },
  };
  return startManagedSidecarChatStream(service, buildManagedChatRequest({ sessionId, prompt }));
}

function findDurabilityEvents(service) {
  return service.emittedEvents.filter(
    (entry) => entry.payload?.type === 'message_updated'
      && entry.payload?.patch?.durability?.state === 'unsaved'
  );
}

test('assistant persist refusal after visible completion: bounded durability warning follows complete, recovery state retained', async () => {
  const service = createManagedChatServiceStub();
  const sessionId = 'session_durable_assistant_refused';
  const preferenceResets = [];
  service.sessionStore.setSessionPreferences = (_sessionId, prefs) => {
    preferenceResets.push(prefs);
  };
  service.sessionStore.appendMessage = (_sessionId, message) => {
    if (String(message?.id || '').startsWith('assistant_')) {
      return null;
    }
    service.sessionMessages.push(message);
    return message;
  };

  const stream = await driveSimpleManagedTurn(service, sessionId);
  const controller = service.activeStreams.get(stream.streamId);
  await controller._pendingPromise;

  const completeIndex = service.emittedEvents.findIndex((entry) => entry.payload?.type === 'complete');
  assert.ok(completeIndex >= 0, 'visible completion must still be emitted immediately (I5)');

  const durabilityEvents = findDurabilityEvents(service);
  assert.equal(durabilityEvents.length, 1, 'exactly one bounded durability warning per turn');
  const durabilityIndex = service.emittedEvents.indexOf(durabilityEvents[0]);
  assert.ok(
    durabilityIndex > completeIndex,
    'the durability warning must FOLLOW visible completion, never delay it (I5)'
  );
  const durability = durabilityEvents[0].payload.patch.durability;
  assert.equal(durability.reason, 'write_failed');
  assert.equal(durability.scope, 'assistant');
  assert.equal(durabilityEvents[0].payload.messageId, `assistant_${stream.streamId}`);

  const activeTurn = service.sessionStore.getActiveTurn(sessionId);
  assert.ok(activeTurn, 'active_turn is retained as recovery provenance when the assistant message never persisted');
  assert.equal(activeTurn.stream_id, stream.streamId);
  assert.deepEqual(preferenceResets, [], 'session preferences must not reset on a refused settle');
  assert.ok(
    service.serviceLogs.some((entry) => entry.event === 'chat.turn_durability_refused'),
    'the refusal is diagnosed with a structured service log'
  );
  // L1 diagnostics (Chat Lifecycle v2 plan §4): a durability-warning emission
  // is one of the two backend durability_degrade sites this wave wires up.
  const lifecycleDurabilityLogs = service.serviceLogs.filter(
    (entry) => entry.event === 'lifecycle.durability_degrade'
  );
  const assistantDurabilityLogs = lifecycleDurabilityLogs.filter(
    (entry) => entry.details.scope === 'assistant'
  );
  assert.equal(assistantDurabilityLogs.length, 1, 'the durability warning must record one assistant-scoped lifecycle diagnostic');
  assert.equal(assistantDurabilityLogs[0].level, 'WARN');
  assert.equal(assistantDurabilityLogs[0].details.reason, 'write_failed');
  assert.equal(assistantDurabilityLogs[0].details.sessionId, sessionId);
  assert.equal(assistantDurabilityLogs[0].details.streamId, stream.streamId);
});

// SP-19 (L0.5): a refused user-message persist FAILS the start before any
// provider invocation — the prior contract (turn proceeds, scope-user
// durability warning at settle) let generation run on an unpersisted prompt.
test('user persist refusal fails the start before provider invocation: no generation, one error terminal, bracket released', async () => {
  const service = createManagedChatServiceStub();
  const sessionId = 'session_durable_user_refused';
  service.sessionStore.appendMessage = (_sessionId, message) => {
    if (String(message?.id || '').startsWith('user_')) {
      return null;
    }
    service.sessionMessages.push(message);
    return message;
  };
  service.sessionStore.createSessionWithId(sessionId, {
    title: 'Durable settle',
    preferences: { preferred_model: 'mock-v1', session_start_date: '2026-07-09' },
  });
  let chatSendCalls = 0;
  service.sidecarClient = {
    chatSend: async (_params, options = {}) => {
      chatSendCalls += 1;
      options.onNotification({ method: 'chat.token', params: { delta: 'the answer' } });
      options.onNotification({ method: 'chat.done', params: {} });
      return { status: 'completed' };
    },
  };

  const stream = await startManagedSidecarChatStream(
    service,
    buildManagedChatRequest({ sessionId, prompt: 'a prompt the store loses' })
  );
  const controller = service.activeStreams.get(stream.streamId);
  await controller._pendingPromise;

  assert.equal(chatSendCalls, 0, 'a refused prompt persist must never reach the provider');
  assert.equal(
    service.emittedEvents.findIndex((entry) => entry.payload?.type === 'complete'),
    -1,
    'no visible completion exists for a turn that never started'
  );
  assert.ok(
    service.emittedEvents.some((entry) => entry.payload?.type === 'error'),
    'the failed start surfaces exactly as a terminal error event'
  );
  assert.equal(
    findDurabilityEvents(service).length,
    0,
    'the failed start replaces the old scope-user durability warning entirely'
  );
  assert.equal(
    service.sessionStore.getActiveTurn(sessionId),
    null,
    'the active-turn claim made before the refused persist is released'
  );
  assert.ok(
    service.serviceLogs.some((entry) => entry.event === 'chat.user_message_persist_failed'),
    'the user-append refusal keeps its structured warning'
  );
});

// ---------------------------------------------------------------------------
// Renderer: the bounded "reply not saved" warning
// ---------------------------------------------------------------------------

async function completeRendererTurn(harness, sessionId, streamId, content) {
  await harness.emit({ type: 'started', sessionId, streamId });
  await harness.emit({
    type: 'complete', sessionId, streamId, content,
  });
}

test('durability warning patch on a settled message shows the bounded reply-not-saved toast and merges provenance', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await completeRendererTurn(harness, 'session-1', 'stream-durable-toast', 'a visible answer');
  const toastCountBefore = harness.calls.toasts.length;

  await harness.emit({
    type: 'message_updated',
    sessionId: 'session-1',
    streamId: 'stream-durable-toast',
    messageId: 'assistant_stream-durable-toast',
    patch: { durability: { state: 'unsaved', reason: 'write_failed', scope: 'assistant' } },
  });

  const durabilityToasts = harness.calls.toasts.slice(toastCountBefore)
    .filter((entry) => entry.options?.title === 'Reply not saved');
  assert.equal(durabilityToasts.length, 1, 'a durability warning must surface exactly one bounded toast');
  assert.match(durabilityToasts[0].message, /not.*saved|saved.*not|couldn't be saved/i);
  assert.ok(durabilityToasts[0].options.dedupeKey, 'the toast must carry a dedupe key so repeats stay bounded');

  const message = harness.state.messagesBySession.get('session-1')
    .find((entry) => entry.id === 'assistant_stream-durable-toast');
  assert.equal(message.content, 'a visible answer', 'the locally visible answer is retained for copy/retry');
  assert.equal(message.status, 'complete');
  assert.equal(message.durability?.state, 'unsaved', 'durability provenance merges onto the local message');
});

// Green guard: ordinary settled-message reconciliation traffic must never trip
// the durability toast.
test('monitor reconciliation patches do not trigger the durability toast', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await completeRendererTurn(harness, 'session-1', 'stream-durable-monitor', 'tool ran');
  const toastCountBefore = harness.calls.toasts.length;

  await harness.emit({
    type: 'message_updated',
    sessionId: 'session-1',
    streamId: 'stream-durable-monitor',
    messageId: 'assistant_stream-durable-monitor',
    patch: { tool_result: { metadata: { monitor: { progress: 0.9, note: 'background refresh' } } } },
  });

  assert.equal(harness.calls.toasts.length, toastCountBefore, 'no toast for ordinary reconciliation patches');
});

// Wave-7 audit pin (surviving-mutant closure, A3 retention half): a MID-TURN
// segment refusal in a turn whose other segments persisted must still settle
// as a refusal. The final slice's append is ACCEPTED, so only the
// `segmentPersistRefused` disjunct in the settle callback reports the earlier
// loss — without it the turn settles success-shaped and clears active_turn,
// dropping the recovery bracket for a reply that is partially non-durable.
// (The durability warning fires from an independent read of the flag and is
// covered above; this pins the PROVENANCE RETENTION half.)
test('mid-turn segment refusal with surviving final segment: settle refuses and active_turn is retained', async () => {
  const service = createManagedChatServiceStub();
  const sessionId = 'session_durable_segment_refused_midturn';
  service.sessionStore.createSessionWithId(sessionId, {
    title: 'Durable settle',
    preferences: { preferred_model: 'mock-v1', session_start_date: '2026-07-09' },
  });
  const refusedIds = [];
  service.sessionStore.appendMessage = (_sessionId, message) => {
    if (/_seg1$/.test(String(message?.id || ''))) {
      refusedIds.push(String(message.id));
      return null;
    }
    service.sessionMessages.push(message);
    return message;
  };
  service.sidecarClient = {
    chatSend: async (_params, options = {}) => {
      options.onNotification({ method: 'chat.token', params: { delta: 'first slice ' } });
      options.onNotification({ method: 'tool.executing', params: { tool_call_id: 'call_seg_1', tool_name: 'shell' } });
      options.onNotification({ method: 'tool.result', params: { tool_call_id: 'call_seg_1', tool_name: 'shell', output: 'ok' } });
      options.onNotification({ method: 'chat.token', params: { delta: 'second slice ' } });
      options.onNotification({ method: 'tool.executing', params: { tool_call_id: 'call_seg_2', tool_name: 'shell' } });
      options.onNotification({ method: 'tool.result', params: { tool_call_id: 'call_seg_2', tool_name: 'shell', output: 'ok' } });
      options.onNotification({ method: 'chat.token', params: { delta: 'final slice' } });
      options.onNotification({ method: 'chat.done', params: {} });
      return { status: 'completed' };
    },
  };

  const stream = await startManagedSidecarChatStream(
    service,
    buildManagedChatRequest({ sessionId, prompt: 'run tools' })
  );
  const controller = service.activeStreams.get(stream.streamId);
  await controller._pendingPromise;

  assert.equal(refusedIds.length, 1, 'exactly the mid-turn segment append is refused');
  assert.match(refusedIds[0], /_seg1$/);
  const firstSegment = service.sessionMessages.find((m) => /_seg0$/.test(String(m.id)));
  const finalSegment = service.sessionMessages.find((m) => /_seg2$/.test(String(m.id)));
  assert.ok(firstSegment, 'the first segment persisted (hasPersistedSegments is true)');
  assert.ok(finalSegment, 'the FINAL slice persisted — only the refusal flag can report the mid-turn loss');
  assert.ok(
    service.sessionStore.getActiveTurn(sessionId),
    'active_turn must be RETAINED: part of the reply is non-durable and recovery needs the bracket'
  );
  assert.equal(findDurabilityEvents(service).length, 1, 'the single bounded durability warning still fires');
});

// ---------------------------------------------------------------------------
// Code-review pins (2026-07-10): the segment-refusal latch must not cry wolf.
// A refused BOUNDARY segment whose turn recovers through the full-append
// settle path (hasPersistedSegments stays false, assistantText still carries
// the whole reply) ends fully durable — no durability warning, recovery state
// cleared. Same for a refusal wiped out by a discarding stream_reset: the
// restarted reply persists cleanly and must settle clean.
// ---------------------------------------------------------------------------

function refuseSegmentAppends(service, pattern) {
  const refused = [];
  service.sessionStore.appendMessage = (_sessionId, message) => {
    if (pattern.test(String(message?.id || ''))) {
      refused.push(String(message.id));
      return null;
    }
    service.sessionMessages.push(message);
    return message;
  };
  return refused;
}

test('refused boundary segment recovered by the full-append settle: fully durable, no warning, turn cleared', async () => {
  const service = createManagedChatServiceStub();
  const sessionId = 'session_durable_segment_refused_recovered';
  service.sessionStore.createSessionWithId(sessionId, {
    title: 'Durable settle',
    preferences: { preferred_model: 'mock-v1', session_start_date: '2026-07-09' },
  });
  const refused = refuseSegmentAppends(service, /_seg\d+$/);
  service.sidecarClient = {
    chatSend: async (_params, options = {}) => {
      options.onNotification({ method: 'chat.token', params: { delta: 'first slice ' } });
      options.onNotification({ method: 'tool.executing', params: { tool_call_id: 'call_rec_1', tool_name: 'shell' } });
      options.onNotification({ method: 'tool.result', params: { tool_call_id: 'call_rec_1', tool_name: 'shell', output: 'ok' } });
      options.onNotification({ method: 'chat.token', params: { delta: 'final slice' } });
      options.onNotification({ method: 'chat.done', params: {} });
      return { status: 'completed' };
    },
  };

  const stream = await startManagedSidecarChatStream(
    service,
    buildManagedChatRequest({ sessionId, prompt: 'run tools' })
  );
  const controller = service.activeStreams.get(stream.streamId);
  await controller._pendingPromise;

  assert.ok(refused.length >= 1, 'the boundary segment append was refused');
  const fullAppendRow = service.sessionMessages.find(
    (m) => String(m.id) === `assistant_${stream.streamId}`
  );
  assert.ok(fullAppendRow, 'the settle recovered the reply through the full-append path');
  assert.match(String(fullAppendRow.content), /first slice /, 'the recovered row carries the refused slice text');
  assert.match(String(fullAppendRow.content), /final slice/, 'the recovered row carries the final slice text');
  assert.deepEqual(
    findDurabilityEvents(service),
    [],
    'a fully-recovered reply must not emit a durability warning (crying wolf)'
  );
  assert.equal(
    service.sessionStore.getActiveTurn(sessionId),
    null,
    'a fully-durable settle clears the recovery bracket'
  );
});

test('segment refusal wiped by a discarding stream_reset: the clean restarted reply settles without a warning', async () => {
  const service = createManagedChatServiceStub();
  const sessionId = 'session_durable_segment_refused_reset';
  service.sessionStore.createSessionWithId(sessionId, {
    title: 'Durable settle',
    preferences: { preferred_model: 'mock-v1', session_start_date: '2026-07-09' },
  });
  // Refuse only the pre-reset boundary segment (seg0); everything after the
  // discarding reset persists cleanly.
  const refused = refuseSegmentAppends(service, /_seg0$/);
  service.sidecarClient = {
    chatSend: async (_params, options = {}) => {
      options.onNotification({ method: 'chat.token', params: { delta: 'doomed pre-reset text ' } });
      options.onNotification({ method: 'tool.executing', params: { tool_call_id: 'call_rst_1', tool_name: 'shell' } });
      options.onNotification({ method: 'tool.result', params: { tool_call_id: 'call_rst_1', tool_name: 'shell', output: 'ok' } });
      options.onNotification({ method: 'chat.stream_reset', params: { reason: 'deterministic_replacement' } });
      // Post-reset the reply persists cleanly INCLUDING a tool-boundary
      // segment, so the settle routes through the segments path — the stale
      // pre-reset refusal latch must not veto it there either.
      options.onNotification({ method: 'chat.token', params: { delta: 'the clean restarted answer ' } });
      options.onNotification({ method: 'tool.executing', params: { tool_call_id: 'call_rst_2', tool_name: 'shell' } });
      options.onNotification({ method: 'tool.result', params: { tool_call_id: 'call_rst_2', tool_name: 'shell', output: 'ok' } });
      options.onNotification({ method: 'chat.token', params: { delta: 'with a final slice' } });
      options.onNotification({ method: 'chat.done', params: {} });
      return { status: 'completed' };
    },
  };

  const stream = await startManagedSidecarChatStream(
    service,
    buildManagedChatRequest({ sessionId, prompt: 'run tools' })
  );
  const controller = service.activeStreams.get(stream.streamId);
  await controller._pendingPromise;

  assert.ok(refused.length >= 1, 'the pre-reset segment append was refused');
  assert.deepEqual(
    findDurabilityEvents(service),
    [],
    'a refusal whose content the reset discarded must not warn about the clean restarted reply'
  );
  assert.equal(
    service.sessionStore.getActiveTurn(sessionId),
    null,
    'the clean restarted reply settles and clears the recovery bracket'
  );
});

test('completed managed turn prunes durable plain mirror rows but retains local tool transcript rows', async (t) => {
  const service = createManagedChatServiceStub();
  const sessionId = 'session_managed_durable_refresh_prune';
  service.sessionStore.createSessionWithId(sessionId, {
    title: 'Managed durable refresh',
    preferences: { preferred_model: 'mock-v1' },
  });
  service.sidecarClient = {
    connected: true,
    async chatSend(_params, { onNotification }) {
      onNotification({
        method: 'tool.executing',
        params: { tool_call_id: 'call_mirror_prune', tool_name: 'read_file' },
      });
      onNotification({
        method: 'tool.result',
        params: {
          tool_call_id: 'call_mirror_prune',
          tool_name: 'read_file',
          output: 'durable tool output',
          success: true,
        },
      });
      onNotification({ method: 'chat.token', params: { delta: 'Durable managed answer.' } });
      onNotification({ method: 'chat.done', params: {} });
      return { status: 'completed' };
    },
  };

  const stream = await startManagedSidecarChatStream(
    service,
    buildManagedChatRequest({ sessionId, prompt: 'Run the managed tool' })
  );
  await service.activeStreams.get(stream.streamId)._pendingPromise;
  const durableMessages = service.sessionStore.getSessionMessages(sessionId);
  const mirrorPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-mirror-prune-')),
    'session-shadow.json'
  );
  trackDirectory(path.dirname(mirrorPath));
  const mirror = new SessionShadowStore(mirrorPath, { writeDebounceMs: 0 });
  t.after(() => mirror.dispose());
  mirror.upsertSession(sessionId, { title: 'Managed durable refresh' });
  for (const message of durableMessages) mirror.appendLocalMessage(sessionId, message);

  const durablePlainIds = durableMessages
    .filter((message) => message.kind !== 'tool_use' && message.kind !== 'tool_result')
    .map((message) => message.client_message_id || message.id);
  assert.deepEqual(durablePlainIds.sort(), [
    `assistant_${stream.streamId}`,
    `user_${stream.streamId}`,
  ].sort());
  const prunedSummary = mirror.prunePersistedPlainMessages(sessionId, durablePlainIds);
  assert.equal(prunedSummary.id, sessionId);
  assert.equal(prunedSummary.message_count, 2);

  const surviving = mirror.getMessages(sessionId);
  assert.equal(surviving.some((message) => message.id === `user_${stream.streamId}`), false);
  assert.equal(surviving.some((message) => message.id === `assistant_${stream.streamId}`), false);
  assert.deepEqual(
    surviving.map((message) => [message.kind, message.tool_call?.call_id || message.tool_result?.call_id]),
    [
      ['tool_use', 'call_mirror_prune'],
      ['tool_result', 'call_mirror_prune'],
    ]
  );
});
