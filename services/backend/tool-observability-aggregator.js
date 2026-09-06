'use strict';

const { normalizeText: normalizeString } = require('../shared/normalize');

const DEFAULT_SAMPLES_PER_TOOL = 256;
const DEFAULT_RECENT_LIMIT = 20;
const DEFAULT_SLOW_TOOL_THRESHOLD_MS = 2000;
const DEFAULT_MAX_OPEN_CALLS = 512;
const DEFAULT_MAX_TOOL_BUCKETS = 256;

function normalizePositiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizeDurationMs(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function isoFromMs(value) {
  const numeric = Number(value);
  const date = Number.isFinite(numeric) ? new Date(numeric) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function nearestRank(sortedSamples, percentile) {
  if (!sortedSamples.length) {
    return null;
  }
  const rank = Math.ceil((percentile / 100) * sortedSamples.length);
  const index = Math.min(Math.max(rank - 1, 0), sortedSamples.length - 1);
  return sortedSamples[index];
}

function pushBounded(list, entry, limit) {
  list.push(entry);
  while (list.length > limit) {
    list.shift();
  }
}

function callKey(sessionId, streamId, callId) {
  const call = normalizeString(callId);
  if (!call) {
    return '';
  }
  return `${normalizeString(sessionId) || 'session'}:${normalizeString(streamId) || 'stream'}:${call}`;
}

function normalizeCallIdentity({ sessionId = '', streamId = '', callId = '' } = {}) {
  const normalizedSessionId = normalizeString(sessionId);
  const normalizedStreamId = normalizeString(streamId);
  const normalizedCallId = normalizeString(callId);
  return {
    sessionId: normalizedSessionId,
    streamId: normalizedStreamId,
    callId: normalizedCallId,
    key: callKey(normalizedSessionId, normalizedStreamId, normalizedCallId),
  };
}

function createToolStats() {
  return {
    count: 0,
    successCount: 0,
    errorCount: 0,
    slowCount: 0,
    durations: [],
    errorCodes: new Map(),
    recentErrors: [],
    recentSlow: [],
    lastResult: null,
  };
}

function buildLatencySnapshot(samples) {
  if (!samples.length) {
    return {
      count: 0,
      p50: null,
      p95: null,
      p99: null,
      min: null,
      max: null,
      last: null,
      last_N: 0,
    };
  }
  const sorted = samples.slice().sort((a, b) => a - b);
  return {
    count: samples.length,
    p50: nearestRank(sorted, 50),
    p95: nearestRank(sorted, 95),
    p99: nearestRank(sorted, 99),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    last: samples[samples.length - 1],
    last_N: samples.length,
  };
}

function mapToObject(map) {
  const result = {};
  for (const [key, value] of Array.from(map.entries()).sort(([left], [right]) => (
    left.localeCompare(right)
  ))) {
    result[key] = value;
  }
  return result;
}

class ToolObservabilityAggregator {
  constructor({
    samplesPerTool = DEFAULT_SAMPLES_PER_TOOL,
    recentLimit = DEFAULT_RECENT_LIMIT,
    slowThresholdMs = DEFAULT_SLOW_TOOL_THRESHOLD_MS,
    maxOpenCalls = DEFAULT_MAX_OPEN_CALLS,
    maxToolBuckets = DEFAULT_MAX_TOOL_BUCKETS,
    now = () => Date.now(),
  } = {}) {
    this.samplesPerTool = normalizePositiveInteger(samplesPerTool, DEFAULT_SAMPLES_PER_TOOL);
    this.recentLimit = normalizePositiveInteger(recentLimit, DEFAULT_RECENT_LIMIT);
    this.slowThresholdMs = normalizePositiveInteger(
      slowThresholdMs,
      DEFAULT_SLOW_TOOL_THRESHOLD_MS
    );
    this.maxOpenCalls = normalizePositiveInteger(maxOpenCalls, DEFAULT_MAX_OPEN_CALLS);
    this.maxToolBuckets = normalizePositiveInteger(maxToolBuckets, DEFAULT_MAX_TOOL_BUCKETS);
    this._now = typeof now === 'function' ? now : () => Date.now();
    this._openCalls = new Map();
    this._tools = new Map();
    this._openCallEvictionCount = 0;
    this._toolBucketEvictionCount = 0;
  }

  _nowMs() {
    const numeric = Number(this._now());
    return Number.isFinite(numeric) ? numeric : Date.now();
  }

  _getToolStats(toolName) {
    const name = normalizeString(toolName);
    if (!this._tools.has(name)) {
      if (this._tools.size >= this.maxToolBuckets) {
        const oldestToolName = this._tools.keys().next().value;
        if (oldestToolName) {
          this._tools.delete(oldestToolName);
          this._toolBucketEvictionCount += 1;
        }
      }
      this._tools.set(name, createToolStats());
    }
    return this._tools.get(name);
  }

  recordToolExecuting({
    streamId = '',
    sessionId = '',
    callId = '',
    toolName = '',
    startedAtMs = null,
  } = {}) {
    const identity = normalizeCallIdentity({ sessionId, streamId, callId });
    const normalizedToolName = normalizeString(toolName);
    const startedAt = startedAtMs == null ? this._nowMs() : normalizeDurationMs(startedAtMs);
    if (!identity.key || !normalizedToolName || startedAt == null) {
      return false;
    }
    const replacedOpenCall = this._openCalls.delete(identity.key);
    if (!replacedOpenCall && this._openCalls.size >= this.maxOpenCalls) {
      const oldestKey = this._openCalls.keys().next().value;
      if (oldestKey) {
        this._openCalls.delete(oldestKey);
        this._openCallEvictionCount += 1;
      }
    }
    this._openCalls.set(identity.key, {
      streamId: identity.streamId,
      sessionId: identity.sessionId,
      callId: identity.callId,
      toolName: normalizedToolName,
      startedAtMs: startedAt,
    });
    return true;
  }

  recordToolResult({
    streamId = '',
    sessionId = '',
    callId = '',
    toolName = '',
    success = true,
    errorCode = '',
    durationMs = null,
    completedAtMs = null,
    terminalState = '',
  } = {}) {
    const identity = normalizeCallIdentity({ sessionId, streamId, callId });
    const openCall = identity.key ? this._openCalls.get(identity.key) : null;
    const normalizedToolName = normalizeString(toolName) || normalizeString(openCall?.toolName);
    const explicitDuration = durationMs == null ? null : normalizeDurationMs(durationMs);
    if (!identity.key || !normalizedToolName || (durationMs != null && explicitDuration == null)) {
      return false;
    }

    const completedAt = completedAtMs == null ? this._nowMs() : normalizeDurationMs(completedAtMs);
    if (completedAt == null) {
      return false;
    }
    const measuredDuration = openCall?.startedAtMs != null
      ? Math.max(completedAt - openCall.startedAtMs, 0)
      : 0;
    const duration = explicitDuration != null ? explicitDuration : measuredDuration;
    const isSuccess = success !== false;
    const normalizedErrorCode = isSuccess ? '' : (normalizeString(errorCode) || 'unknown');
    const row = {
      ts: isoFromMs(completedAt),
      stream_id: identity.streamId || normalizeString(openCall?.streamId),
      session_id: identity.sessionId || normalizeString(openCall?.sessionId),
      tool_call_id: identity.callId,
      tool_name: normalizedToolName,
      duration_ms: duration,
      error_code: normalizedErrorCode,
      terminal_state: normalizeString(terminalState),
    };
    const stats = this._getToolStats(normalizedToolName);
    stats.count += 1;
    if (isSuccess) {
      stats.successCount += 1;
    } else {
      stats.errorCount += 1;
      stats.errorCodes.set(
        normalizedErrorCode,
        (stats.errorCodes.get(normalizedErrorCode) || 0) + 1
      );
      pushBounded(stats.recentErrors, row, this.recentLimit);
    }
    pushBounded(stats.durations, duration, this.samplesPerTool);
    if (duration >= this.slowThresholdMs) {
      stats.slowCount += 1;
      pushBounded(stats.recentSlow, row, this.recentLimit);
    }
    stats.lastResult = row;
    this._openCalls.delete(identity.key);
    return true;
  }

  reset() {
    this._openCalls.clear();
    this._tools.clear();
    this._openCallEvictionCount = 0;
    this._toolBucketEvictionCount = 0;
    return this.snapshot();
  }

  snapshot() {
    const tools = {};
    for (const [toolName, stats] of Array.from(this._tools.entries()).sort(([left], [right]) => (
      left.localeCompare(right)
    ))) {
      tools[toolName] = {
        count: stats.count,
        success_count: stats.successCount,
        error_count: stats.errorCount,
        error_rate: stats.count > 0 ? stats.errorCount / stats.count : 0,
        slow_count: stats.slowCount,
        error_codes: mapToObject(stats.errorCodes),
        latency_ms: buildLatencySnapshot(stats.durations),
        recent_slow: stats.recentSlow.slice(),
        recent_errors: stats.recentErrors.slice(),
        last_result: stats.lastResult ? { ...stats.lastResult } : null,
      };
    }
    return {
      generated_at: isoFromMs(this._nowMs()),
      retention: {
        samples_per_tool: this.samplesPerTool,
        recent_limit: this.recentLimit,
        slow_threshold_ms: this.slowThresholdMs,
        max_open_calls: this.maxOpenCalls,
        max_tool_buckets: this.maxToolBuckets,
      },
      open_call_count: this._openCalls.size,
      open_call_eviction_count: this._openCallEvictionCount,
      tool_bucket_eviction_count: this._toolBucketEvictionCount,
      tools,
    };
  }
}

function createToolObservabilityAggregator(options = {}) {
  return new ToolObservabilityAggregator(options);
}

module.exports = {
  DEFAULT_RECENT_LIMIT,
  DEFAULT_MAX_OPEN_CALLS,
  DEFAULT_MAX_TOOL_BUCKETS,
  DEFAULT_SAMPLES_PER_TOOL,
  DEFAULT_SLOW_TOOL_THRESHOLD_MS,
  ToolObservabilityAggregator,
  createToolObservabilityAggregator,
};
