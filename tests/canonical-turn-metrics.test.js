'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CANONICAL_TURN_COUNTER_FIELDS,
  CanonicalTurnMetrics,
} = require('../services/backend/canonical-turn-metrics');

test('canonical turn metrics records bounded counters without event payloads', () => {
  const metrics = new CanonicalTurnMetrics({ sampleLimit: 3 });

  metrics.recordCanonicalEvent({
    event_id: 'turn:canonical:1',
    type: 'tool_call_requested',
    payload: {
      prompt: 'private prompt text',
      path: 'C:/Users/example/private.txt',
    },
  });
  metrics.recordLegacyNotification({ method: 'tool.executing', params: { output: 'secret' } });
  metrics.recordLatency('sidecar_notification_to_electron_ms', 12);
  metrics.recordLatency('electron_ingest_to_renderer_commit_ms', 24);
  metrics.recordOrphanToolRepair();
  metrics.recordLiveReplayDivergence();
  metrics.recordDroppedCanonicalEvent({ code: 'unsupported_event_type' });

  const snapshot = metrics.snapshot();
  assert.deepEqual(snapshot.counter_fields, CANONICAL_TURN_COUNTER_FIELDS);
  assert.equal(snapshot.counters.canonical_events_emitted, 1);
  assert.equal(snapshot.counters.legacy_notifications_emitted, 1);
  assert.equal(snapshot.counters.orphan_tool_repair_count, 1);
  assert.equal(snapshot.counters.live_replay_divergence_count, 1);
  assert.equal(snapshot.counters.unknown_or_dropped_canonical_event_count, 1);
  assert.equal(snapshot.latency_ms.sidecar_notification_to_electron_ms.p50, 12);
  assert.equal(snapshot.latency_ms.electron_ingest_to_renderer_commit_ms.p50, 24);

  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes('private prompt text'), false);
  assert.equal(serialized.includes('private.txt'), false);
  assert.equal(serialized.includes('secret'), false);
});

test('canonical turn metrics bounds latency samples and keeps totals', () => {
  const metrics = new CanonicalTurnMetrics({ sampleLimit: 3 });

  [10, 20, 30, 40].forEach((value) => {
    metrics.recordLatency('electron_ingest_to_renderer_commit_ms', value);
  });

  const snapshot = metrics.snapshot();
  const latency = snapshot.latency_ms.electron_ingest_to_renderer_commit_ms;
  assert.equal(latency.count, 3);
  assert.equal(latency.total_count, 4);
  assert.equal(latency.min, 20);
  assert.equal(latency.p50, 30);
  assert.equal(latency.p95, 40);
  assert.equal(latency.max, 40);
});

test('canonical turn metrics rejects unknown latency names and non-finite values', () => {
  const metrics = new CanonicalTurnMetrics();

  assert.equal(metrics.recordLatency('unknown_metric', 1), false);
  assert.equal(metrics.recordLatency('sidecar_notification_to_electron_ms', -1), false);
  assert.equal(metrics.recordLatency('sidecar_notification_to_electron_ms', Number.NaN), false);
  assert.equal(metrics.recordLatency('sidecar_notification_to_electron_ms', 1), true);

  assert.equal(
    metrics.snapshot().latency_ms.sidecar_notification_to_electron_ms.count,
    1
  );
});
