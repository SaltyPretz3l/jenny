'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  startManagedSidecarChatStream,
} = require('../../services/backend/managed-sidecar-chat');
const {
  ensureSessionTurnActorRegistry,
} = require('../../services/backend/session-turn-actor');
const {
  buildManagedChatRequest,
  createManagedChatServiceStub,
  waitForDiagnosticDump,
} = require('../helpers/managed-sidecar-chat-lifecycle-helpers');

test('managed sidecar diagnostic engine type follows runtime, running engine, then model inference', async (t) => {
  const model = 'gemma4:12b-qat-ud-q4-k-xl';
  const cases = [
    {
      name: 'running engine identifies a local GGUF tag',
      currentEngineType: ' OpenAI-Compatible ',
      runtimePreferredEngineType: '',
      expected: 'openai-compatible',
    },
    {
      name: 'model inference remains the fallback when the running engine is absent',
      runtimePreferredEngineType: '',
      expected: 'ollama',
    },
    {
      name: 'runtime preference wins over the running engine',
      currentEngineType: 'openai-compatible',
      runtimePreferredEngineType: ' VLLM ',
      expected: 'vllm',
    },
  ];

  for (const [index, entry] of cases.entries()) {
    await t.test(entry.name, async (subtest) => {
      const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-diagnostic-engine-'));
      subtest.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
      const service = createManagedChatServiceStub();
      service.options = { userDataPath };
      if (Object.hasOwn(entry, 'currentEngineType')) {
        service.currentEngineType = entry.currentEngineType;
      }
      service.sidecarManager = {
        process: { pid: 4242 },
        getStatus: () => ({ phase: 'ready' }),
      };
      service.ollamaManager = {
        ensureRunning: async () => ({ ready: true, started: false, external: false }),
      };
      service._resolveModel = async () => model;
      service.sidecarClient = {
        connected: true,
        async harnessTurnDiagnostic() { return null; },
        async chatSend(_params, { onNotification }) {
          onNotification({ method: 'chat.token', params: { delta: 'Done.' } });
          onNotification({ method: 'chat.done', params: {} });
          return { status: 'completed' };
        },
      };

      const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
        sessionId: `session_diagnostic_engine_${index}`,
        runtimePreferredModel: model,
        runtimePreferredEngineType: entry.runtimePreferredEngineType,
        normalizedPreferences: { preferred_model: model },
      }));
      await service.activeStreams.get(stream.streamId)._pendingPromise;
      const diagnosticPath = await waitForDiagnosticDump(service, stream.streamId);
      const diagnostic = JSON.parse(fs.readFileSync(diagnosticPath, 'utf8'));

      assert.equal(diagnostic.engine_type, entry.expected);
    });
  }
});

test('managed sidecar snapshots a new session once after persisting its first user message', async () => {
  const service = createManagedChatServiceStub();
  service.sidecarManager = {
    process: { pid: 4242 },
    getStatus: () => ({ phase: 'ready' }),
  };
  const readCounts = { getSession: 0, getSessionMessages: 0 };
  for (const method of Object.keys(readCounts)) {
    const original = service.sessionStore[method].bind(service.sessionStore);
    service.sessionStore[method] = (...args) => {
      readCounts[method] += 1;
      return original(...args);
    };
  }
  let capturedChatSend = null;
  let readCountsAtSend = null;
  service.sidecarClient = {
    connected: true,
    async chatSend(params, { onNotification }) {
      capturedChatSend = params;
      readCountsAtSend = { ...readCounts };
      onNotification({ method: 'chat.token', params: { delta: 'Created.' } });
      onNotification({ method: 'chat.done', params: {} });
      return { status: 'completed' };
    },
  };

  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId: '',
    prompt: 'Start a clean session',
  }));
  const controller = service.activeStreams.get(stream.streamId);
  assert.ok(controller);
  await controller._pendingPromise;

  // The two getSession calls before the snapshot belong to internal actor admission.
  assert.deepEqual(readCountsAtSend, { getSession: 3, getSessionMessages: 0 });
  assert.deepEqual(capturedChatSend.canonical_session_messages, []);
  assert.equal(
    capturedChatSend.canonical_session_messages.some(
      (message) => message.id === `user_${stream.streamId}`
    ),
    false
  );
});

test('managed sidecar reuses one existing-session snapshot for history and approved-plan fields', async () => {
  const service = createManagedChatServiceStub();
  const sessionId = 'session_store_read_history';
  service.sessionStore.createSessionWithId(sessionId, { title: 'Snapshot history' });
  const approvedPlanMessage = {
    id: 'approved_plan_message',
    role: 'assistant',
    kind: 'plan_document',
    content: '',
    plan_document: {
      plan_id: 'plan_store_reads',
      state: 'approved',
      title: 'Consolidate reads',
      summary: 'Keep one normalized session snapshot.',
      steps: ['Capture the snapshot', 'Reuse both message views'],
      notes: '',
      verification: 'Run focused tests',
    },
  };
  const priorUserMessages = Array.from({ length: 9 }, (_value, index) => ({
    id: `prior_user_${index + 1}`,
    role: 'user',
    content: `Prior user turn ${index + 1}`,
  }));
  const priorHistory = [approvedPlanMessage, ...priorUserMessages];
  service.sessionMessages.push(...priorHistory);
  service.sidecarManager = {
    process: { pid: 4242 },
    getStatus: () => ({ phase: 'ready' }),
  };
  const firstLease = ensureSessionTurnActorRegistry(service).reserveStart({
    sessionId,
    store: service.sessionStore,
    activeStreams: service.activeStreams,
    prompt: 'Continue the approved plan',
    path: 'managed',
  });
  const readCounts = { getSession: 0, getSessionMessages: 0 };
  for (const method of Object.keys(readCounts)) {
    const original = service.sessionStore[method].bind(service.sessionStore);
    service.sessionStore[method] = (...args) => {
      readCounts[method] += 1;
      return original(...args);
    };
  }
  const capturedSends = [];
  service.sidecarClient = {
    connected: true,
    async chatSend(params, { onNotification }) {
      capturedSends.push({ params, readCounts: { ...readCounts } });
      onNotification({ method: 'chat.token', params: { delta: 'Continued.' } });
      onNotification({ method: 'chat.done', params: {} });
      return { status: 'completed' };
    },
  };

  const firstStream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId,
    prompt: 'Continue the approved plan',
    normalizedPreferences: { plan_mode: true },
    turnLease: firstLease,
  }));
  const firstController = service.activeStreams.get(firstStream.streamId);
  assert.ok(firstController);
  await firstController._pendingPromise;

  // Before consolidation this path made 2 getSession and 3 getSessionMessages calls.
  assert.deepEqual(capturedSends[0].readCounts, { getSession: 2, getSessionMessages: 0 });
  // The wire copy is projected by projectCanonicalSessionMessagesForSend: this
  // fixture is prose-only, so no message matches a Python consumer shape and a
  // single placeholder stands in to keep the list non-empty for the truthiness
  // test at chat_decision.py:774. The FULL priorHistory stays on the local
  // canonicalSessionMessages, which recall, compaction, and the transcript query
  // read -- projecting that local array instead of the wire value is the mistake
  // this assertion exists to catch.
  assert.deepEqual(capturedSends[0].params.canonical_session_messages, [
    { id: 'prior_user_9', kind: 'projected_placeholder' },
  ]);
  // The placeholder carries the LAST input message's id, so this also proves the
  // projection was handed all 10 prior messages rather than an already-trimmed view.
  assert.equal(priorHistory[priorHistory.length - 1].id, 'prior_user_9');
  assert.equal(
    capturedSends[0].params.canonical_session_messages.some(
      (message) => message.id === `user_${firstStream.streamId}`
    ),
    false
  );
  assert.equal(capturedSends[0].params.plan_mode, true);
  assert.deepEqual(capturedSends[0].params.approved_plan, {
    plan_id: 'plan_store_reads',
    title: 'Consolidate reads',
    summary: 'Keep one normalized session snapshot.',
    steps: ['Capture the snapshot', 'Reuse both message views'],
    notes: '',
    verification: 'Run focused tests',
  });

  const secondLease = ensureSessionTurnActorRegistry(service).reserveStart({
    sessionId,
    store: service.sessionStore,
    activeStreams: service.activeStreams,
    prompt: 'Continue once more',
    path: 'managed',
  });
  readCounts.getSession = 0;
  readCounts.getSessionMessages = 0;
  const secondStream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId,
    prompt: 'Continue once more',
    normalizedPreferences: { plan_mode: true },
    turnLease: secondLease,
  }));
  const secondController = service.activeStreams.get(secondStream.streamId);
  assert.ok(secondController);
  await secondController._pendingPromise;

  assert.deepEqual(capturedSends[1].readCounts, { getSession: 2, getSessionMessages: 0 });
  assert.equal(capturedSends[1].params.plan_mode, true);
  assert.equal(
    Object.hasOwn(capturedSends[1].params, 'approved_plan'),
    false,
    'the unfiltered current user turn must expire continuity after eleven user turns'
  );
  assert.equal(
    capturedSends[1].params.canonical_session_messages.some(
      (message) => message.id === `user_${secondStream.streamId}`
    ),
    false
  );
});
