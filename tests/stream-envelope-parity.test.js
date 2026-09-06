const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createStreamEnvelopeParityTracker,
  diffStreamEnvelopeProjections,
  projectEnvelope,
  projectLegacyStreamPayload,
} = require('../services/stream-envelope-parity');

function projectItems(projectItem, items) {
  const projection = {
    content: '',
    reasoningEntries: [],
    phases: [],
    tools: [],
    terminalStatus: '',
  };
  for (const item of items) {
    projectItem(projection, item);
  }
  return projection;
}

test('stream envelope parity projection matches legacy content, reasoning, phases, tools, and terminal state', () => {
  const legacyProjection = projectItems(projectLegacyStreamPayload, [
    { type: 'started', streamId: 'stream-1' },
    {
      type: 'delta',
      streamId: 'stream-1',
      content: 'Hello',
      phaseId: 'phase_text_1',
      phaseKind: 'text',
    },
    {
      type: 'delta',
      streamId: 'stream-1',
      reasoning: {
        entriesDelta: [{ id: 'reason_1', text: 'Checking intent' }],
      },
      phaseId: 'phase_reasoning_1',
      phaseKind: 'reasoning',
    },
    {
      type: 'tool_use',
      streamId: 'stream-1',
      callId: 'call_read',
      toolName: 'read_file',
      status: 'running',
    },
    { type: 'complete', streamId: 'stream-1' },
  ]);
  const envelopeProjection = projectItems(projectEnvelope, [
    {
      eventKind: 'delta',
      channel: 'response',
      streamId: 'stream-1',
      phase: { phaseId: 'phase_text_1', phaseKind: 'text' },
      payload: { delta: 'Hello' },
    },
    {
      eventKind: 'delta',
      channel: 'reasoning',
      streamId: 'stream-1',
      phase: { phaseId: 'phase_reasoning_1', phaseKind: 'reasoning' },
      payload: { entriesDelta: [{ id: 'reason_1', text: 'Checking intent' }] },
    },
    {
      eventKind: 'started',
      channel: 'tool',
      streamId: 'stream-1',
      payload: {
        type: 'tool_use',
        callId: 'call_read',
        toolName: 'read_file',
        status: 'running',
      },
    },
    {
      eventKind: 'terminal',
      channel: 'control',
      streamId: 'stream-1',
      payload: { type: 'complete' },
    },
  ]);

  assert.deepEqual(diffStreamEnvelopeProjections(legacyProjection, envelopeProjection), {});
});

test('stream envelope parity tracker logs mismatches only at terminal', () => {
  const logs = [];
  const tracker = createStreamEnvelopeParityTracker({
    log(level, event, details) {
      logs.push({ level, event, details });
    },
  });

  tracker.noteLegacy({
    type: 'delta',
    streamId: 'stream-2',
    content: 'legacy text',
  });
  tracker.noteEnvelope({
    eventKind: 'delta',
    channel: 'response',
    streamId: 'stream-2',
    payload: { delta: 'envelope text' },
  });
  assert.equal(logs.length, 0);

  tracker.noteLegacy({ type: 'complete', streamId: 'stream-2' });
  tracker.noteEnvelope({
    eventKind: 'terminal',
    channel: 'control',
    streamId: 'stream-2',
    payload: { type: 'complete' },
  });

  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'WARN');
  assert.equal(logs[0].event, 'chat.stream_envelope_v2_parity_mismatch');
  assert.equal(logs[0].details.streamId, 'stream-2');
  assert.deepEqual(logs[0].details.diff.content, {
    legacy: 'legacy text',
    envelope: 'envelope text',
  });
});

test('stream envelope parity projects reasoning deltas without treating them as response text', () => {
  const projection = projectItems(projectEnvelope, [
    {
      eventKind: 'delta',
      channel: 'reasoning',
      streamId: 'stream-reasoning-delta',
      sequence: 2,
      channelSequence: 1,
      payload: { delta: 'Private reasoning delta' },
    },
  ]);

  assert.equal(projection.content, '');
  assert.deepEqual(projection.reasoningEntries, [{
    id: 'reasoning_stream-reasoning-delta_1',
    text: 'Private reasoning delta',
  }]);
});

test('stream envelope parity tracker keeps projections incremental instead of buffering raw events', () => {
  const tracker = createStreamEnvelopeParityTracker({ log() {} });

  for (let index = 0; index < 100; index += 1) {
    tracker.noteLegacy({
      type: 'delta',
      streamId: 'stream-incremental',
      content: 'x',
    });
    tracker.noteEnvelope({
      eventKind: 'delta',
      channel: 'response',
      streamId: 'stream-incremental',
      sequence: index + 1,
      payload: { delta: 'x' },
    });
  }

  assert.deepEqual(tracker.diff(), {});
});
