const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STREAM_ENVELOPE_SCHEMA_VERSION: PRODUCER_SCHEMA_VERSION,
} = require('../services/stream-envelope-shape');
const {
  streamEnvelopeToLegacyPayload,
} = require('../renderer/chat/renderer-stream-envelope-v2');
const { createHarness } = require('./helpers/renderer-stream-handler-harness');

test('producer schema version decodes through the renderer consumer', () => {
  const payload = streamEnvelopeToLegacyPayload({
    schemaVersion: PRODUCER_SCHEMA_VERSION,
    eventKind: 'started',
    channel: 'control',
    streamId: 'stream-schema-contract',
    turnId: 'turn-schema-contract',
    sessionId: 'session-1',
    payload: { type: 'started' },
  });

  assert.ok(payload);
  assert.equal(payload.type, 'started');
});

test('version-mismatched envelope falls back to the legacy stream', async (t) => {
  const logs = [];
  const harness = createHarness({
    stateOverrides: {
      features: { featureFlags: { stream_envelope_v2: true } },
    },
    callbackOverrides: {
      appendClientLog(level, eventName, details) {
        logs.push({ level, eventName, details });
      },
    },
  });
  t.after(() => harness.restore());

  await harness.emitEnvelope({
    schemaVersion: PRODUCER_SCHEMA_VERSION + 1,
    eventKind: 'started',
    channel: 'control',
    streamId: 'stream-schema-mismatch',
    turnId: 'turn-schema-mismatch',
    sessionId: 'session-1',
    payload: { type: 'started' },
  });

  assert.deepEqual(harness.state.messagesBySession.get('session-1'), []);
  assert.equal(harness.calls.renderMessages, 0);
  assert.equal(
    logs.some((entry) => entry.eventName === 'stream.envelope_v2_legacy_fallback'
      && entry.details.reason === 'envelope_schema_mismatch'),
    true
  );
});

test('structurally malformed envelope does not fall back to the legacy stream', async (t) => {
  const logs = [];
  const harness = createHarness({
    stateOverrides: {
      features: { featureFlags: { stream_envelope_v2: true } },
    },
    callbackOverrides: {
      appendClientLog(level, eventName, details) {
        logs.push({ level, eventName, details });
      },
    },
  });
  t.after(() => harness.restore());

  await harness.emitEnvelope({
    schemaVersion: PRODUCER_SCHEMA_VERSION,
    eventKind: 'started',
    channel: 'unknown',
    streamId: 'stream-schema-malformed',
    turnId: 'turn-schema-malformed',
    sessionId: 'session-1',
    payload: { type: 'started' },
  });

  assert.equal(
    logs.some((entry) => entry.eventName === 'stream.envelope_v2_invalid'),
    true
  );
  assert.equal(
    logs.some((entry) => entry.eventName === 'stream.envelope_v2_legacy_fallback'),
    false
  );
});

test('invalid envelope log carries the schema version', async (t) => {
  const logs = [];
  const harness = createHarness({
    stateOverrides: {
      features: { featureFlags: { stream_envelope_v2: true } },
    },
    callbackOverrides: {
      appendClientLog(level, eventName, details) {
        logs.push({ level, eventName, details });
      },
    },
  });
  t.after(() => harness.restore());
  const mismatchedVersion = PRODUCER_SCHEMA_VERSION + 1;

  await harness.emitEnvelope({
    schemaVersion: mismatchedVersion,
    eventKind: 'started',
    channel: 'control',
    streamId: 'stream-schema-log',
    turnId: 'turn-schema-log',
    sessionId: 'session-1',
    payload: { type: 'started' },
  });

  const invalidLog = logs.find((entry) => entry.eventName === 'stream.envelope_v2_invalid');
  assert.ok(invalidLog);
  assert.equal(invalidLog.details.schemaVersion, String(mismatchedVersion));
});
