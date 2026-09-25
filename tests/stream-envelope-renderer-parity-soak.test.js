const test = require('node:test');
const assert = require('node:assert/strict');

const { createChatStreamBridge } = require('../services/chat-stream-bridge');
const {
  streamEnvelopeToLegacyPayload,
} = require('../renderer/chat/renderer-stream-envelope-v2');
const {
  createHarness,
  createQueuedFrameController,
} = require('./helpers/renderer-stream-handler-harness');
const {
  loadRendererApp,
  waitForUi,
} = require('./helpers/renderer-shell-harness');

const SESSION_ID = 'session-envelope-parity-soak';
const STREAM_ID = 'stream-envelope-parity-soak';
const FINAL_TEXT = 'A\r\n🙂é';
const FINAL_DOM_TEXT = 'A\n🙂é';
const FINAL_UTF8_BYTES = [65, 13, 10, 240, 159, 153, 130, 101, 204, 129];
const REASONING_PHASE_ID = 'phase_reasoning_soak';

const TRANSCRIPT = Object.freeze([
  {
    type: 'started', sessionId: SESSION_ID, streamId: STREAM_ID,
    turnId: STREAM_ID, requestId: STREAM_ID, traceId: 'trace-envelope-parity-soak',
  },
  {
    type: 'delta', sessionId: SESSION_ID, streamId: STREAM_ID,
    sequence: 1, channel: 'reasoning', channelSequence: 1,
    phase: {
      phase_id: REASONING_PHASE_ID,
      phase_kind: 'reasoning',
      iteration: 1,
      thinking_id: 'think-envelope-parity-soak',
    },
    content: '',
    reasoning: {
      source: 'provider',
      entriesDelta: [{ id: 'r1', text: 'Checking intent', timestamp: '' }],
    },
    expectedPrefix: '',
  },
  {
    type: 'delta', sessionId: SESSION_ID, streamId: STREAM_ID,
    sequence: 2, channel: 'response', channelSequence: 1,
    phase: { phase_id: 'phase_text_soak', phase_kind: 'text', iteration: 1 },
    content: 'A\r\n', aggregate: 'A\r\n', aggregateLength: 3,
    expectedPrefix: 'A\r\n',
  },
  {
    type: 'delta', sessionId: SESSION_ID, streamId: STREAM_ID,
    sequence: 3, channel: 'response', channelSequence: 2,
    phase: { phase_id: 'phase_text_soak', phase_kind: 'text', iteration: 1 },
    content: '🙂', aggregateLength: 5,
    expectedPrefix: 'A\r\n🙂',
  },
  {
    type: 'delta', sessionId: SESSION_ID, streamId: STREAM_ID,
    sequence: 4, channel: 'reasoning', channelSequence: 2,
    phase: {
      phase_id: REASONING_PHASE_ID,
      phase_kind: 'reasoning',
      iteration: 1,
      thinking_id: 'think-envelope-parity-soak',
      completed: true,
      completed_at: '2026-09-04T12:00:00.000Z',
    },
    content: '',
    aggregateLength: 5,
    reasoning: {
      source: 'provider',
      entriesDelta: [{ id: 'r1', text: 'Checking intent', timestamp: '', completed: true }],
    },
    expectedPrefix: 'A\r\n🙂',
  },
  {
    type: 'delta', sessionId: SESSION_ID, streamId: STREAM_ID,
    sequence: 5, channel: 'response', channelSequence: 3,
    phase: { phase_id: 'phase_text_soak', phase_kind: 'text', iteration: 1 },
    content: 'é', aggregate: FINAL_TEXT, aggregateLength: 7,
    expectedPrefix: FINAL_TEXT,
  },
  {
    type: 'complete', sessionId: SESSION_ID, streamId: STREAM_ID,
    sequence: 6, status: 'complete', content: FINAL_TEXT,
  },
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createBridgeLane({ envelopeEnabled, parityDiagnostics = false }) {
  const sent = [];
  const logs = [];
  let coalesceTimer = null;
  let receiptWatchdog = null;
  const bridge = createChatStreamBridge({
    sendBridgeEvent(method, payload) {
      sent.push({ method, payload: clone(payload) });
    },
    log(level, event, details) {
      logs.push({ level, event, details: clone(details) });
    },
    now: () => 1_725_470_400_000,
    setCoalesceTimer(callback) {
      coalesceTimer = callback;
      return 'coalesce-timer';
    },
    clearCoalesceTimer() {
      coalesceTimer = null;
    },
    setReceiptWatchdog(callback) {
      receiptWatchdog = callback;
      return 'receipt-watchdog';
    },
    clearReceiptWatchdog() {
      receiptWatchdog = null;
    },
    isStreamEnvelopeV2Enabled: () => envelopeEnabled,
    enableStreamEnvelopeParityDiagnostics: () => parityDiagnostics,
  });
  return {
    bridge,
    sent,
    logs,
    flushDelta() {
      const callback = coalesceTimer;
      coalesceTimer = null;
      assert.equal(typeof callback, 'function', 'each delta boundary schedules a deterministic flush');
      callback();
    },
    takeSent() {
      return sent.splice(0, sent.length);
    },
    clearMeasuredState() {
      sent.length = 0;
      logs.length = 0;
    },
    receiptWatchdogPending() {
      return receiptWatchdog !== null;
    },
  };
}

function proveEnvelopeAck(lane) {
  lane.bridge.recordEnvelopeAck({
    recordType: 'subscription_started', rendererEpoch: 1, mode: 'envelope',
  });
  lane.bridge.handleEvent({
    type: 'started', streamId: 'stream-envelope-parity-handshake', sessionId: SESSION_ID,
  });
  lane.bridge.handleEvent({
    type: 'complete', streamId: 'stream-envelope-parity-handshake', sessionId: SESSION_ID,
  });
  lane.bridge.recordEnvelopeAck({
    recordType: 'terminal_receipt',
    rendererEpoch: 1,
    streamId: 'stream-envelope-parity-handshake',
    receivedCount: 2,
    sequenceStart: 1,
    sequenceEnd: 1,
    channels: { control: { count: 1, sequenceStart: 1, sequenceEnd: 1 } },
    terminalType: 'complete',
    eventKind: 'terminal',
  });
  assert.equal(lane.receiptWatchdogPending(), false);
  lane.clearMeasuredState();
}

function createFocusedState(envelopeEnabled) {
  return {
    currentSessionId: SESSION_ID,
    sessions: [{ id: SESSION_ID }],
    messagesBySession: new Map([[SESSION_ID, []]]),
    features: { featureFlags: { stream_envelope_v2: envelopeEnabled } },
    ui: { activeView: 'chat', chatSendLifecycleBySession: new Map() },
  };
}

function assistantMessages(harness) {
  return (harness.state.messagesBySession.get(SESSION_ID) || [])
    .filter((message) => message.role === 'assistant'
      && String(message.id || '').startsWith(`assistant_${STREAM_ID}`));
}

function assistantContent(harness) {
  return assistantMessages(harness).map((message) => String(message.content || '')).join('');
}

function reasoningMessage(harness) {
  return assistantMessages(harness)
    .find((message) => Array.isArray(message?.reasoning?.entries)
      && message.reasoning.entries.length > 0);
}

function normalizedReasoningEntries(message) {
  return (message?.reasoning?.entries || []).map((entry) => ({
    id: entry.id,
    text: entry.text,
  }));
}

function normalizedReasoningCompletion(payload) {
  const entry = payload?.reasoning?.entriesDelta?.[0] || {};
  const phase = payload?.phase || {};
  return {
    id: entry.id || '',
    text: entry.text || '',
    completed: entry.completed === true,
    phaseId: phase.phaseId || phase.phase_id || '',
    phaseKind: phase.phaseKind || phase.phase_kind || '',
  };
}

function normalizedTerminalPresence(harness) {
  const payload = harness.calls.presence.findLast((entry) => entry.type === 'complete');
  return {
    type: payload?.type || '',
    sessionId: payload?.sessionId || '',
    streamId: payload?.streamId || '',
    status: payload?.status || '',
    terminalStatus: payload?.terminalStatus || '',
    terminalSubcode: payload?.terminalSubcode || '',
  };
}

async function drainAllFrames(frames, maxIterations = 100) {
  let iterations = 0;
  while (frames.pendingCount() > 0 && iterations < maxIterations) {
    await frames.drainNextFrame();
    iterations += 1;
  }
  assert.equal(frames.pendingCount(), 0, 'renderer frame queue drains deterministically');
}

function buildRendererSession(payload) {
  return {
    id: SESSION_ID,
    title: 'Envelope parity soak',
    conversation_mode: 'chat',
    preferred_model: payload.preferredModel || 'test-model',
    reasoning_effort: 'default',
    interactive_round_count: 0,
    interactive_sequence_state: 'idle',
    pending_question_batch: null,
    updated_at: '2026-09-04T12:00:00.000Z',
  };
}

async function loadRendererTestApp(t, frames) {
  const app = await loadRendererApp({
    requestAnimationFrame: frames.requestAnimationFrame.bind(frames),
    cancelAnimationFrame: frames.cancelAnimationFrame.bind(frames),
    shell: {
      chat: {
        async startStream(payload, { state }) {
          state.sessions = [buildRendererSession(payload)];
          state.messagesBySession.set(SESSION_ID, []);
          return { sessionId: SESSION_ID, streamId: STREAM_ID };
        },
      },
    },
  });
  t.after(async () => {
    await app.dispose();
  });
  await drainAllFrames(frames);
  const input = app.window.document.getElementById('chatInput');
  input.value = 'Run the envelope parity soak';
  input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  app.window.document.getElementById('sendButton').click();
  await waitForUi(app.window, 40);
  await drainAllFrames(frames);
  return app;
}

function bubbleText(app) {
  return app.window.document
    .querySelector(`article[data-message-id="assistant_${STREAM_ID}"] .chat-bubble p`)
    ?.textContent;
}

test('stream envelope v2 preserves renderer text, reasoning, and terminal parity', async (t) => {
  const legacyLane = createBridgeLane({ envelopeEnabled: false });
  const envelopeLane = createBridgeLane({ envelopeEnabled: true, parityDiagnostics: true });
  proveEnvelopeAck(envelopeLane);

  const rendererLogs = [];
  const legacyFocusedFrames = createQueuedFrameController();
  const envelopeFocusedFrames = createQueuedFrameController();
  const legacyHarness = createHarness({
    requestAnimationFrameImpl: legacyFocusedFrames.requestAnimationFrame.bind(legacyFocusedFrames),
    cancelAnimationFrameImpl: legacyFocusedFrames.cancelAnimationFrame.bind(legacyFocusedFrames),
    stateOverrides: createFocusedState(false),
    callbackOverrides: {
      appendClientLog(level, event, details) {
        rendererLogs.push({ lane: 'legacy', level, event, details });
      },
    },
  });
  t.after(() => legacyHarness.restore());
  const envelopeWindow = {
    jennyShell: {
      sessions: { async getMessages() { return { data: [] }; } },
      chat: {
        ackEnvelopeReceipt(record) {
          return envelopeLane.bridge.recordEnvelopeAck(record);
        },
      },
    },
  };
  const envelopeHarness = createHarness({
    requestAnimationFrameImpl: envelopeFocusedFrames.requestAnimationFrame.bind(envelopeFocusedFrames),
    cancelAnimationFrameImpl: envelopeFocusedFrames.cancelAnimationFrame.bind(envelopeFocusedFrames),
    stateOverrides: { ...createFocusedState(true), window: envelopeWindow },
    callbackOverrides: {
      appendClientLog(level, event, details) {
        rendererLogs.push({ lane: 'envelope', level, event, details });
      },
    },
  });
  t.after(() => envelopeHarness.restore());

  const capturedLegacy = [];
  const capturedEnvelopes = [];
  for (const frozenFrame of TRANSCRIPT) {
    const frame = clone(frozenFrame);
    delete frame.expectedPrefix;
    legacyLane.bridge.handleEvent(frame);
    envelopeLane.bridge.handleEvent(frame);
    if (frame.type === 'delta') {
      legacyLane.flushDelta();
      envelopeLane.flushDelta();
    }
    const legacyBatch = legacyLane.takeSent()
      .filter((entry) => entry.method === 'chat.onStream')
      .map((entry) => entry.payload);
    const envelopeBatch = envelopeLane.takeSent()
      .filter((entry) => entry.method === 'chat.onStreamEnvelope')
      .map((entry) => entry.payload);
    capturedLegacy.push(...legacyBatch);
    capturedEnvelopes.push(...envelopeBatch);
    for (const payload of legacyBatch) await legacyHarness.emit(payload);
    for (const envelope of envelopeBatch) await envelopeHarness.emitEnvelope(envelope);
    legacyHarness.handler.flushPendingStreamCommitsForSession(SESSION_ID);
    envelopeHarness.handler.flushPendingStreamCommitsForSession(SESSION_ID);
    await drainAllFrames(legacyFocusedFrames);
    await drainAllFrames(envelopeFocusedFrames);
    if (frozenFrame.type === 'delta') {
      assert.equal(assistantContent(legacyHarness), frozenFrame.expectedPrefix);
      assert.equal(assistantContent(envelopeHarness), frozenFrame.expectedPrefix);
    }
  }

  assert.equal(assistantContent(legacyHarness), FINAL_TEXT);
  assert.equal(assistantContent(envelopeHarness), FINAL_TEXT);
  assert.deepEqual([...Buffer.from(assistantContent(legacyHarness), 'utf8')], FINAL_UTF8_BYTES);
  assert.deepEqual([...Buffer.from(assistantContent(envelopeHarness), 'utf8')], FINAL_UTF8_BYTES);

  const expectedReasoning = [{ id: 'r1', text: 'Checking intent' }];
  assert.deepEqual(normalizedReasoningEntries(reasoningMessage(legacyHarness)), expectedReasoning);
  assert.deepEqual(normalizedReasoningEntries(reasoningMessage(envelopeHarness)), expectedReasoning);
  assert.deepEqual(
    normalizedReasoningEntries(reasoningMessage(envelopeHarness)),
    normalizedReasoningEntries(reasoningMessage(legacyHarness))
  );
  const legacyReasoningCompletion = capturedLegacy.find((payload) =>
    payload.reasoning?.entriesDelta?.[0]?.completed === true
  );
  const envelopeReasoningCompletion = capturedEnvelopes
    .filter((envelope) => envelope.channel === 'reasoning')
    .map((envelope) => streamEnvelopeToLegacyPayload(envelope))
    .find((payload) => payload?.reasoning?.entriesDelta?.[0]?.completed === true);
  const expectedReasoningCompletion = {
    id: 'r1', text: 'Checking intent', completed: true,
    phaseId: REASONING_PHASE_ID, phaseKind: 'reasoning',
  };
  assert.deepEqual(normalizedReasoningCompletion(legacyReasoningCompletion), expectedReasoningCompletion);
  assert.deepEqual(normalizedReasoningCompletion(envelopeReasoningCompletion), expectedReasoningCompletion);

  for (const harness of [legacyHarness, envelopeHarness]) {
    assert.equal(
      assistantMessages(harness).every((message) => message.status === 'complete'),
      true
    );
    assert.equal(harness.state.pendingStreams.has(STREAM_ID), false);
    assert.equal(harness.state.ui.chatSendLifecycleBySession.has(SESSION_ID), false);
    assert.equal(harness.multiStreamController.isSessionSendBusy(SESSION_ID), false);
  }
  assert.deepEqual(
    normalizedTerminalPresence(envelopeHarness),
    normalizedTerminalPresence(legacyHarness)
  );
  assert.deepEqual(normalizedTerminalPresence(legacyHarness), {
    type: 'complete',
    sessionId: SESSION_ID,
    streamId: STREAM_ID,
    status: 'complete',
    terminalStatus: 'completed',
    terminalSubcode: '',
  });

  const sparseEnvelope = capturedEnvelopes.find(
    (envelope) => envelope.channel === 'response'
      && envelope.eventKind === 'delta'
      && envelope.payload?.delta === '🙂'
  );
  assert.ok(sparseEnvelope, 'decoded sparse response frame is present');
  assert.equal(sparseEnvelope.payload.aggregateLength, 5);
  assert.equal(Object.hasOwn(sparseEnvelope.payload, 'aggregate'), false);
  const decodedSparse = streamEnvelopeToLegacyPayload(sparseEnvelope);
  assert.equal(decodedSparse.content, '🙂');
  assert.equal(decodedSparse.aggregateLength, 5);
  assert.equal(Object.hasOwn(decodedSparse, 'aggregate'), false);
  assert.equal(envelopeLane.receiptWatchdogPending(), false, 'terminal receipt was acknowledged');

  const diagnosticEvents = [
    ...legacyLane.logs,
    ...envelopeLane.logs,
    ...rendererLogs,
  ].map((entry) => String(entry.event || ''));
  const forbiddenDiagnostic = /(invalid|legacy_fallback|sequence_(?:fault|gap|invalid|regression)|parity_mismatch|no_ack)/;
  assert.deepEqual(diagnosticEvents.filter((event) => forbiddenDiagnostic.test(event)), []);

  const legacyFrames = createQueuedFrameController();
  const envelopeFrames = createQueuedFrameController();
  const legacyApp = await loadRendererTestApp(t, legacyFrames);
  const envelopeApp = await loadRendererTestApp(t, envelopeFrames);
  const legacyTerminal = capturedLegacy.find((payload) => payload.type === 'complete');
  const envelopeTerminal = capturedEnvelopes.find((envelope) => envelope.eventKind === 'terminal');
  for (const payload of capturedLegacy.filter((entry) => entry !== legacyTerminal)) {
    await legacyApp.shell.__emitChat(payload);
    await drainAllFrames(legacyFrames);
  }
  for (const envelope of capturedEnvelopes.filter((entry) => entry !== envelopeTerminal)) {
    const payload = streamEnvelopeToLegacyPayload(envelope);
    assert.ok(payload, 'captured envelope decodes through the production adapter');
    await envelopeApp.shell.__emitChat(payload);
    await drainAllFrames(envelopeFrames);
  }
  await waitForUi(legacyApp.window, 60);
  await waitForUi(envelopeApp.window, 60);
  await drainAllFrames(legacyFrames);
  await drainAllFrames(envelopeFrames);
  assert.equal(bubbleText(legacyApp), FINAL_DOM_TEXT);
  assert.equal(bubbleText(envelopeApp), FINAL_DOM_TEXT);
  assert.equal(bubbleText(envelopeApp), bubbleText(legacyApp));

  await legacyApp.shell.__emitChat(legacyTerminal);
  await envelopeApp.shell.__emitChat(streamEnvelopeToLegacyPayload(envelopeTerminal));
  await drainAllFrames(legacyFrames);
  await drainAllFrames(envelopeFrames);
  assert.equal(bubbleText(envelopeApp), bubbleText(legacyApp));
});
