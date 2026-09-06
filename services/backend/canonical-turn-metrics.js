'use strict';

const {
  CANONICAL_TURN_COUNTER_FIELDS,
} = require('./canonical-turn-event');

const LATENCY_COUNTERS = new Set([
  'sidecar_notification_to_electron_ms',
  'electron_ingest_to_renderer_commit_ms',
]);

function coerceSampleLimit(value) {
  const numeric = Number.parseInt(value, 10);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 256;
}

function estimateJsonBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch (_error) {
    return 0;
  }
}

function createCounterBag() {
  const counters = {};
  for (const field of CANONICAL_TURN_COUNTER_FIELDS) {
    counters[field] = 0;
  }
  return counters;
}

function percentile(sortedSamples, percentileRank) {
  if (!sortedSamples.length) {
    return 0;
  }
  const index = Math.max(
    0,
    Math.ceil((percentileRank / 100) * sortedSamples.length) - 1
  );
  return sortedSamples[Math.min(index, sortedSamples.length - 1)];
}

function summarizeLatencyBucket(bucket) {
  const samples = [...bucket.samples].sort((a, b) => a - b);
  if (!samples.length) {
    return {
      count: 0,
      total_count: bucket.totalCount,
      min: 0,
      p50: 0,
      p95: 0,
      max: 0,
    };
  }
  return {
    count: samples.length,
    total_count: bucket.totalCount,
    min: samples[0],
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    max: samples[samples.length - 1],
  };
}

class CanonicalTurnMetrics {
  constructor({ sampleLimit = 256 } = {}) {
    this.sampleLimit = coerceSampleLimit(sampleLimit);
    this.counters = createCounterBag();
    this.latencies = new Map();
    for (const field of LATENCY_COUNTERS) {
      this.latencies.set(field, {
        samples: [],
        totalCount: 0,
      });
    }
  }

  recordCanonicalEvent(event) {
    this.counters.canonical_events_emitted += 1;
    this.counters.canonical_event_bytes += estimateJsonBytes(event);
    return true;
  }

  recordLegacyNotification(notification) {
    this.counters.legacy_notifications_emitted += 1;
    this.counters.legacy_notification_bytes += estimateJsonBytes(notification);
    return true;
  }

  recordLatency(name, value) {
    if (!LATENCY_COUNTERS.has(name)) {
      return false;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) {
      return false;
    }
    const bucket = this.latencies.get(name);
    bucket.samples.push(numeric);
    bucket.totalCount += 1;
    while (bucket.samples.length > this.sampleLimit) {
      bucket.samples.shift();
    }
    this.counters[name] = numeric;
    return true;
  }

  recordOrphanToolRepair() {
    this.counters.orphan_tool_repair_count += 1;
  }

  recordLiveReplayDivergence() {
    this.counters.live_replay_divergence_count += 1;
  }

  recordDroppedCanonicalEvent() {
    this.counters.unknown_or_dropped_canonical_event_count += 1;
  }

  snapshot() {
    const latencyMs = {};
    for (const name of LATENCY_COUNTERS) {
      latencyMs[name] = summarizeLatencyBucket(this.latencies.get(name));
    }
    return {
      counter_fields: [...CANONICAL_TURN_COUNTER_FIELDS],
      counters: { ...this.counters },
      latency_ms: latencyMs,
      retention: {
        sample_limit: this.sampleLimit,
      },
    };
  }
}

module.exports = {
  CANONICAL_TURN_COUNTER_FIELDS,
  CanonicalTurnMetrics,
};
