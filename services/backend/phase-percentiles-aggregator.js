const DEFAULT_SAMPLES_PER_PHASE = 256;

const PHASE_PERCENTILE_TARGETS = Object.freeze({
  click_to_optimistic_render: Object.freeze({ p50: 10, p95: 30 }),
  optimistic_render_to_context_assembly_started: Object.freeze({ p50: 15, p95: 40 }),
  context_assembly_elapsed_no_memory_git: Object.freeze({ p50: 30, p95: 100 }),
  context_assembly_elapsed_memory_git: Object.freeze({ p50: 120, p95: 350 }),
  context_assembly_completed_to_sidecar_request_sent: Object.freeze({ p50: 5, p95: 25 }),
  sidecar_request_sent_to_provider_request_start: Object.freeze({ p50: 15, p95: 60 }),
  provider_request_start_to_first_chunk: Object.freeze({ p50: 150, p95: 400 }),
  first_chunk_to_first_visible_token: Object.freeze({ p50: 20, p95: 100 }),
  completion_to_terminal_persist: Object.freeze({ p50: 20, p95: 120 }),
});

function _normalizePhaseName(value) {
  const phase = String(value || '').trim();
  return Object.hasOwn(PHASE_PERCENTILE_TARGETS, phase) ? phase : '';
}

function _normalizeDurationMs(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function normalizePhaseClientTiming(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const sendStartedAtMs = _normalizeDurationMs(source.send_started_at_ms);
  const optimisticRenderedAtMs = _normalizeDurationMs(source.optimistic_rendered_at_ms);
  const localRenderLatencyMs = _normalizeDurationMs(source.local_render_latency_ms);
  return {
    sendStartedAtMs,
    optimisticRenderedAtMs,
    localRenderLatencyMs: localRenderLatencyMs != null
      ? localRenderLatencyMs
      : (
          sendStartedAtMs != null && optimisticRenderedAtMs != null
            ? Math.max(optimisticRenderedAtMs - sendStartedAtMs, 0)
            : null
        ),
  };
}

function recordServicePhasePercentile(service, phaseName, durationMs) {
  if (
    service?.phasePercentilesAggregator
    && typeof service.phasePercentilesAggregator.record === 'function'
  ) {
    service.phasePercentilesAggregator.record(phaseName, durationMs);
  }
}

function _nearestRank(sortedSamples, percentile) {
  if (!sortedSamples.length) {
    return null;
  }
  const rank = Math.ceil((percentile / 100) * sortedSamples.length);
  const index = Math.min(Math.max(rank - 1, 0), sortedSamples.length - 1);
  return sortedSamples[index];
}

function _createPhaseBuffer(capacity) {
  return {
    samples: new Array(capacity),
    nextIndex: 0,
    count: 0,
  };
}

function _appendToPhaseBuffer(buffer, capacity, duration) {
  buffer.samples[buffer.nextIndex] = duration;
  buffer.nextIndex = (buffer.nextIndex + 1) % capacity;
  buffer.count = Math.min(buffer.count + 1, capacity);
}

function _readPhaseBuffer(buffer, capacity) {
  if (!buffer || buffer.count <= 0) {
    return [];
  }
  if (buffer.count < capacity) {
    return buffer.samples.slice(0, buffer.count);
  }
  return buffer.samples.slice(buffer.nextIndex).concat(buffer.samples.slice(0, buffer.nextIndex));
}

class PhasePercentilesAggregator {
  constructor({ samplesPerPhase = DEFAULT_SAMPLES_PER_PHASE } = {}) {
    const normalizedSamplesPerPhase = Number(samplesPerPhase);
    this.samplesPerPhase = Number.isInteger(normalizedSamplesPerPhase) && normalizedSamplesPerPhase > 0
      ? normalizedSamplesPerPhase
      : DEFAULT_SAMPLES_PER_PHASE;
    this._buffers = new Map();
  }

  record(phaseName, durationMs) {
    const phase = _normalizePhaseName(phaseName);
    const duration = _normalizeDurationMs(durationMs);
    if (!phase || duration == null) {
      return false;
    }
    let buffer = this._buffers.get(phase);
    if (!buffer) {
      buffer = _createPhaseBuffer(this.samplesPerPhase);
      this._buffers.set(phase, buffer);
    }
    _appendToPhaseBuffer(buffer, this.samplesPerPhase, duration);
    return true;
  }

  reset() {
    this._buffers.clear();
    return this.snapshot();
  }

  snapshot() {
    const phases = {};
    const names = Array.from(this._buffers.keys()).sort();
    for (const name of names) {
      const samples = _readPhaseBuffer(this._buffers.get(name), this.samplesPerPhase);
      if (!samples.length) {
        continue;
      }
      const sorted = samples.slice().sort((a, b) => a - b);
      phases[name] = {
        count: samples.length,
        p50: _nearestRank(sorted, 50),
        p95: _nearestRank(sorted, 95),
        p99: _nearestRank(sorted, 99),
        min: sorted[0],
        max: sorted[sorted.length - 1],
        last_N: samples.length,
      };
    }
    return {
      generated_at: new Date().toISOString(),
      retention: {
        samples_per_phase: this.samplesPerPhase,
      },
      targets: PHASE_PERCENTILE_TARGETS,
      phases,
    };
  }
}

function createPhasePercentilesAggregator(options = {}) {
  return new PhasePercentilesAggregator(options);
}

module.exports = {
  PHASE_PERCENTILE_TARGETS,
  createPhasePercentilesAggregator,
  normalizePhaseClientTiming,
  recordServicePhasePercentile,
};
