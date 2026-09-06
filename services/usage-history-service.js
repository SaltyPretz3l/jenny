'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { FileJsonStore } = require('./backend/file-json-store');
const {
  TERMINAL_STATUSES,
  normalizeTerminalStatus,
} = require('./backend/generated-chat-lifecycle-contract');
const { normalizeText } = require('./shared/normalize');

const USAGE_HISTORY_SCHEMA_VERSION = 2;
const USAGE_HISTORY_FILE = 'usage-history.json';
const LEGACY_COST_FILE = 'cost-tracker.json';
const DEFAULT_MAX_TURNS = 500;
const DEFAULT_MAX_AGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ID_CHARS = 160;
const MAX_MODEL_CHARS = 200;
const MAX_PROVIDER_CHARS = 80;
const MAX_OUTCOME_DETAIL_CHARS = 120;
const MAX_PROVIDER_COST_USD = 1_000_000_000;
const MAX_TOKEN_COUNT = 1_000_000_000;
const MAX_DURATION_MS = 7 * DAY_MS;
const LOCAL_ZERO_PROVIDERS = new Set([
  'ollama',
  'vllm',
  'openai-compatible',
  'openai-compatible-local',
  'replay',
  'mock',
]);

function boundedText(value, limit) {
  return normalizeText(value).slice(0, limit);
}

function nonNegativeInt(value, maximum = MAX_TOKEN_COUNT) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0
    ? Math.min(Math.trunc(numeric), maximum)
    : 0;
}

function nonNegativeNumber(value, maximum = MAX_DURATION_MS) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.min(numeric, maximum) : 0;
}

function boundedErrorReason(error, fallback = 'operation_failed') {
  return boundedText(error?.code, 40) || fallback;
}

function normalizeIsoTimestamp(value) {
  const numeric = Date.parse(String(value || ''));
  return Number.isFinite(numeric) ? new Date(numeric).toISOString() : '';
}

function normalizeLimit(value, fallback, maximum = fallback) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return fallback;
  }
  return Math.min(numeric, maximum);
}

function normalizeOutcome(value, fallback = 'complete') {
  const normalized = normalizeTerminalStatus(value);
  if (TERMINAL_STATUSES.has(normalized)) {
    return normalized;
  }
  const normalizedFallback = normalizeTerminalStatus(fallback);
  return TERMINAL_STATUSES.has(normalizedFallback) ? normalizedFallback : 'complete';
}

function normalizeOutcomeDetail(value) {
  const detail = boundedText(value, MAX_OUTCOME_DETAIL_CHARS);
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(detail) ? detail : '';
}

function emptyOutcomes() {
  const outcomes = {};
  for (const status of TERMINAL_STATUSES) {
    outcomes[status] = 0;
  }
  return outcomes;
}

function resolveCost(usage, provider) {
  if (LOCAL_ZERO_PROVIDERS.has(provider)) {
    return { cost_source: 'local_zero', cost_usd: 0 };
  }
  const requestedSource = boundedText(usage?.cost_source, 32).toLowerCase();
  if (requestedSource === 'provider') {
    const numeric = usage?.cost_usd;
    if (typeof numeric === 'number' && Number.isFinite(numeric) && numeric >= 0) {
      return {
        cost_source: 'provider',
        cost_usd: Math.min(numeric, MAX_PROVIDER_COST_USD),
      };
    }
  }
  return { cost_source: 'unavailable', cost_usd: null };
}

function buildRecordId(_sessionId, streamId, requestId) {
  if (streamId) {
    return `stream:${streamId}`;
  }
  if (requestId) {
    return `request:${requestId}`;
  }
  return '';
}

function normalizeTurnRow(value, { nowIso = '', requireTimestamp = true } = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const sessionId = boundedText(source.session_id || source.sessionId, MAX_ID_CHARS);
  const streamId = boundedText(source.stream_id || source.streamId, MAX_ID_CHARS);
  const requestId = boundedText(source.request_id || source.requestId, MAX_ID_CHARS);
  const recordId = buildRecordId(sessionId, streamId, requestId);
  const recordedAt = normalizeIsoTimestamp(source.recorded_at || source.recordedAt || nowIso);
  if (!recordId || (requireTimestamp && !recordedAt)) {
    return null;
  }
  const provider = boundedText(source.provider, MAX_PROVIDER_CHARS).toLowerCase();
  const cost = resolveCost(source, provider);
  const inputTokens = nonNegativeInt(source.input_tokens);
  const outputTokens = nonNegativeInt(source.output_tokens);
  const reportedTotal = nonNegativeInt(source.total_tokens);
  return {
    record_id: recordId,
    recorded_at: recordedAt,
    session_id: sessionId,
    stream_id: streamId,
    request_id: requestId,
    trace_id: boundedText(source.trace_id || source.traceId, MAX_ID_CHARS),
    model: boundedText(source.model || 'unknown', MAX_MODEL_CHARS) || 'unknown',
    provider,
    terminal_type: boundedText(source.terminal_type || source.terminalType || 'complete', 40),
    outcome: normalizeOutcome(source.outcome),
    outcome_detail: normalizeOutcomeDetail(
      source.outcome_detail || source.outcomeDetail,
    ),
    duration_ms: nonNegativeNumber(source.duration_ms ?? source.durationMs),
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: Math.max(reportedTotal, inputTokens + outputTokens),
    generation_tokens: nonNegativeInt(source.generation_tokens ?? source.generationTokens),
    generation_duration_ms: nonNegativeNumber(
      source.generation_duration_ms ?? source.generationDurationMs
    ),
    ttft_ms: nonNegativeNumber(
      source.ttft_ms ?? source.time_to_first_token_ms ?? source.timeToFirstTokenMs
    ),
    estimated: source.estimated === true,
    ...cost,
  };
}

function compareRows(left, right) {
  const timeDelta = Date.parse(left.recorded_at) - Date.parse(right.recorded_at);
  if (timeDelta) {
    return timeDelta;
  }
  if (left.record_id === right.record_id) {
    return 0;
  }
  return left.record_id < right.record_id ? -1 : 1;
}

function pruneRows(rows, { nowMs, maxAgeMs, maxTurns }) {
  const cutoff = nowMs - maxAgeMs;
  const byId = new Map();
  for (const row of rows) {
    if (Date.parse(row.recorded_at) < cutoff) {
      continue;
    }
    const previous = byId.get(row.record_id);
    if (!previous || compareRows(previous, row) <= 0) {
      byId.set(row.record_id, row);
    }
  }
  return [...byId.values()].sort(compareRows).slice(-maxTurns);
}

function emptyTotals() {
  return {
    turn_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    generation_tokens: 0,
    generation_duration_ms: 0,
    estimated_turns: 0,
    duration_ms: 0,
    outcomes: emptyOutcomes(),
    provider_cost_usd: 0,
    cost_coverage: {
      local_zero_turns: 0,
      provider_reported_turns: 0,
      unavailable_turns: 0,
    },
    models: {},
  };
}

function nearestRank(sortedSamples, percentile) {
  if (!sortedSamples.length) {
    return 0;
  }
  const rank = Math.ceil((percentile / 100) * sortedSamples.length);
  const index = Math.min(Math.max(rank - 1, 0), sortedSamples.length - 1);
  return sortedSamples[index];
}

function buildSpeed(rows) {
  const speedSamples = [];
  const ttftSamples = [];
  for (const row of rows) {
    const durationMs = nonNegativeNumber(row?.generation_duration_ms);
    if (durationMs <= 0) {
      continue;
    }
    const generationTokens = nonNegativeInt(row?.generation_tokens);
    speedSamples.push((generationTokens * 1000) / durationMs);
    const ttftMs = nonNegativeNumber(row?.ttft_ms);
    if (ttftMs > 0) {
      ttftSamples.push(ttftMs);
    }
  }
  speedSamples.sort((left, right) => left - right);
  ttftSamples.sort((left, right) => left - right);
  return {
    measured_turns: speedSamples.length,
    tokens_per_second: {
      median: nearestRank(speedSamples, 50),
      p10: nearestRank(speedSamples, 10),
      p90: nearestRank(speedSamples, 90),
    },
    ttft_ms: {
      measured_turns: ttftSamples.length,
      median: nearestRank(ttftSamples, 50),
    },
  };
}

function buildTotals(rows) {
  const totals = emptyTotals();
  const rowsByModel = new Map();
  for (const row of rows) {
    const inputTokens = nonNegativeInt(row?.input_tokens);
    const outputTokens = nonNegativeInt(row?.output_tokens);
    const totalTokens = Math.max(nonNegativeInt(row?.total_tokens), inputTokens + outputTokens);
    const generationTokens = nonNegativeInt(row?.generation_tokens);
    const generationDurationMs = nonNegativeNumber(row?.generation_duration_ms);
    const durationMs = nonNegativeNumber(row?.duration_ms);
    const model = boundedText(row?.model || 'unknown', MAX_MODEL_CHARS) || 'unknown';
    const costSource = ['local_zero', 'provider', 'unavailable'].includes(row?.cost_source)
      ? row.cost_source
      : 'unavailable';
    totals.turn_count += 1;
    totals.input_tokens += inputTokens;
    totals.output_tokens += outputTokens;
    totals.total_tokens += totalTokens;
    totals.generation_tokens += generationTokens;
    totals.generation_duration_ms += generationDurationMs;
    totals.estimated_turns += row?.estimated === true ? 1 : 0;
    totals.duration_ms += durationMs;
    totals.outcomes[normalizeOutcome(row?.outcome)] += 1;
    const coverageKey = costSource === 'provider'
      ? 'provider_reported_turns'
      : `${costSource}_turns`;
    totals.cost_coverage[coverageKey] += 1;
    if (costSource === 'provider') {
      const providerCost = Number(row?.cost_usd);
      totals.provider_cost_usd += Number.isFinite(providerCost) && providerCost > 0
        ? Math.min(providerCost, MAX_PROVIDER_COST_USD)
        : 0;
    }
    let bucket;
    if (Object.prototype.hasOwnProperty.call(totals.models, model)) {
      bucket = totals.models[model];
    } else {
      bucket = {
        turn_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        generation_tokens: 0,
        generation_duration_ms: 0,
        estimated_turns: 0,
        duration_ms: 0,
        outcomes: emptyOutcomes(),
      };
      Object.defineProperty(totals.models, model, {
        value: bucket,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    bucket.turn_count += 1;
    bucket.input_tokens += inputTokens;
    bucket.output_tokens += outputTokens;
    bucket.total_tokens += totalTokens;
    bucket.generation_tokens += generationTokens;
    bucket.generation_duration_ms += generationDurationMs;
    bucket.estimated_turns += row?.estimated === true ? 1 : 0;
    bucket.duration_ms += durationMs;
    bucket.outcomes[normalizeOutcome(row?.outcome)] += 1;
    const modelRows = rowsByModel.get(model) || [];
    modelRows.push(row);
    rowsByModel.set(model, modelRows);
  }
  totals.speed = buildSpeed(rows);
  for (const [model, modelRows] of rowsByModel) {
    totals.models[model].speed = buildSpeed(modelRows);
  }
  return totals;
}

function cloneRows(rows) {
  return rows.map((row) => ({ ...row }));
}

class UsageHistoryService extends EventEmitter {
  constructor({
    userDataPath,
    logger = null,
    now = () => Date.now(),
    maxTurns = DEFAULT_MAX_TURNS,
    maxAgeDays = DEFAULT_MAX_AGE_DAYS,
    store = null,
    fsImpl = fs,
  } = {}) {
    super();
    this._logger = typeof logger === 'function' ? logger : null;
    this._now = typeof now === 'function' ? now : () => Date.now();
    this._maxTurns = normalizeLimit(maxTurns, DEFAULT_MAX_TURNS, DEFAULT_MAX_TURNS);
    this._maxAgeMs = normalizeLimit(maxAgeDays, DEFAULT_MAX_AGE_DAYS, DEFAULT_MAX_AGE_DAYS) * DAY_MS;
    this._store = store || (userDataPath
      ? new FileJsonStore(path.join(userDataPath, USAGE_HISTORY_FILE), { logger: this._logger })
      : null);
    this._legacyPath = userDataPath ? path.join(userDataPath, LEGACY_COST_FILE) : '';
    this._fs = fsImpl;
    this._rows = [];
    this._lastRecordError = null;
    this._readOnlyReason = '';
    this._load();
  }

  _log(level, event, details = {}) {
    try {
      this._logger?.(level, event, details);
    } catch (_error) {
      // Diagnostics must never interfere with chat settlement.
    }
  }

  _payload(rows = this._rows) {
    return {
      schema_version: USAGE_HISTORY_SCHEMA_VERSION,
      updated_at: new Date(this._now()).toISOString(),
      turns: rows,
    };
  }

  _load() {
    if (!this._store) {
      return;
    }
    const status = this._store.readWithStatus(null);
    if (status.corrupted) {
      this._readOnlyReason = 'corrupt_store';
      this._log('WARN', 'usage_history.load_failed', { reason: 'corrupt_store' });
      return;
    }
    if (status.missing) {
      try {
        this._store.writeImmediate(this._payload([]));
        this._retireLegacyCostFile();
      } catch (error) {
        this._readOnlyReason = 'initialize_failed';
        this._log('WARN', 'usage_history.initialize_failed', {
          errorCode: boundedText(error?.code, 40),
        });
      }
      return;
    }
    const source = status.value && typeof status.value === 'object' && !Array.isArray(status.value)
      ? status.value
      : {};
    const version = Number(source.schema_version ?? USAGE_HISTORY_SCHEMA_VERSION);
    if (!Number.isInteger(version) || version > USAGE_HISTORY_SCHEMA_VERSION) {
      this._readOnlyReason = 'future_schema';
      const futureRows = Array.isArray(source.turns) ? source.turns : [];
      this._rows = pruneRows(
        futureRows.map((row) => normalizeTurnRow(row)).filter(Boolean),
        this._retentionOptions()
      );
      this._log('WARN', 'usage_history.future_schema', { observedVersion: version });
      return;
    }
    const rawRows = Array.isArray(source.turns) ? source.turns : [];
    const normalized = rawRows
      .map((row) => normalizeTurnRow(row))
      .filter(Boolean);
    this._rows = pruneRows(normalized, this._retentionOptions());
    const repaired = version !== USAGE_HISTORY_SCHEMA_VERSION
      || this._rows.length !== rawRows.length
      || JSON.stringify(this._rows) !== JSON.stringify(rawRows);
    if (repaired) {
      this._log('WARN', 'usage_history.rows_repaired', {
        droppedCount: Math.max(rawRows.length - this._rows.length, 0),
      });
      try {
        this._store.writeImmediate(this._payload());
      } catch (error) {
        this._lastRecordError = boundedErrorReason(error, 'repair_persist_failed');
        this._log('WARN', 'usage_history.repair_persist_failed', {
          errorCode: boundedText(error?.code, 40),
        });
      }
    }
    this._retireLegacyCostFile();
  }

  _retentionOptions() {
    return {
      nowMs: this._now(),
      maxAgeMs: this._maxAgeMs,
      maxTurns: this._maxTurns,
    };
  }

  _retireLegacyCostFile() {
    if (!this._legacyPath) {
      return;
    }
    try {
      this._fs.unlinkSync(this._legacyPath);
      this._log('INFO', 'usage_history.legacy_cost_retired');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this._log('WARN', 'usage_history.legacy_cost_retire_failed', {
          errorCode: boundedText(error?.code, 40),
        });
      }
    }
  }

  _commit(nextRows, { clearRecordError = true } = {}) {
    if (this._readOnlyReason) {
      throw new Error(`Usage history is read-only (${this._readOnlyReason}).`);
    }
    const pruned = pruneRows(nextRows, this._retentionOptions());
    if (this._store) {
      this._store.writeImmediate(this._payload(pruned));
    }
    this._rows = pruned;
    if (clearRecordError) {
      this._lastRecordError = null;
    }
    return { durable: Boolean(this._store), rows: pruned };
  }

  _retainedRows() {
    const retained = pruneRows(this._rows, this._retentionOptions());
    return retained.length === this._rows.length ? this._rows : retained;
  }

  recordTurnUsage(sessionId, usage, metadata = {}) {
    if (!usage || typeof usage !== 'object') {
      return { recorded: false, reason: 'missing_usage' };
    }
    const nowIso = new Date(this._now()).toISOString();
    const row = normalizeTurnRow({
      ...usage,
      session_id: sessionId,
      stream_id: metadata.streamId || metadata.stream_id,
      request_id: metadata.requestId || metadata.request_id,
      trace_id: metadata.traceId || metadata.trace_id,
      terminal_type: metadata.terminalType || metadata.terminal_type,
      outcome: metadata.outcome,
      outcome_detail: metadata.outcomeDetail || metadata.outcome_detail,
      duration_ms: metadata.durationMs ?? metadata.duration_ms,
      model: usage.model || metadata.model,
      recorded_at: nowIso,
    }, { nowIso });
    if (!row) {
      this._log('WARN', 'usage_history.record_rejected', { reason: 'missing_stable_identity' });
      return { recorded: false, reason: 'missing_stable_identity' };
    }
    const nextRows = this._rows.filter((entry) => entry.record_id !== row.record_id);
    nextRows.push(row);
    const result = this._commit(nextRows);
    this.emit('updated', { sessionId: row.session_id, recordId: row.record_id });
    return { recorded: true, durable: result.durable };
  }

  reportRecordFailure({ sessionId, error } = {}) {
    this._lastRecordError = boundedErrorReason(error, 'record_failed');
    this.emit('updated', {
      sessionId: boundedText(sessionId, MAX_ID_CHARS),
      recordFailed: true,
      record_failed: true,
      last_record_error: this._lastRecordError,
    });
  }

  getSnapshot({ sessionId = '', limit = 50 } = {}) {
    const retainedRows = this._retainedRows();
    const normalizedSessionId = boundedText(sessionId, MAX_ID_CHARS);
    const sessionRows = normalizedSessionId
      ? retainedRows.filter((row) => row.session_id === normalizedSessionId)
      : [];
    const recentLimit = normalizeLimit(limit, 50, this._maxTurns);
    const oldest = retainedRows[0]?.recorded_at || '';
    const now = new Date(this._now());
    const todayStartMs = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate()
    ).getTime();
    const todayRows = retainedRows.filter((row) => Date.parse(row.recorded_at) >= todayStartMs);
    return {
      available: !this._readOnlyReason,
      persistence: {
        available: Boolean(this._store) && !this._readOnlyReason,
        durable: Boolean(this._store) && !this._readOnlyReason,
        read_only_reason: this._readOnlyReason || null,
      },
      retention: {
        max_age_days: this._maxAgeMs / DAY_MS,
        max_turns: this._maxTurns,
        retained_turns: retainedRows.length,
        oldest_at: oldest,
      },
      session_id: normalizedSessionId,
      today: buildTotals(todayRows),
      session: buildTotals(sessionRows),
      cumulative: buildTotals(retainedRows),
      recent_turns: cloneRows(retainedRows.slice(-recentLimit).reverse()),
      last_record_error: this._lastRecordError,
    };
  }

  getExportRows({ sessionId = '', scope = 'all', limit = DEFAULT_MAX_TURNS } = {}) {
    const normalizedScope = boundedText(scope, 16).toLowerCase();
    if (!['session', 'today', 'all'].includes(normalizedScope)) {
      return {
        ok: false,
        scope: normalizedScope,
        rows: [],
        persistence: {
          available: Boolean(this._store) && !this._readOnlyReason,
          durable: Boolean(this._store) && !this._readOnlyReason,
          read_only_reason: this._readOnlyReason || null,
        },
        retention: {
          max_age_days: this._maxAgeMs / DAY_MS,
          max_turns: this._maxTurns,
          retained_turns: this._retainedRows().length,
          oldest_at: this._retainedRows()[0]?.recorded_at || '',
        },
        error: 'invalid_scope',
      };
    }
    const retainedRows = this._retainedRows();
    const normalizedSessionId = boundedText(sessionId, MAX_ID_CHARS);
    const now = new Date(this._now());
    const todayStartMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const scopedRows = retainedRows.filter((row) => {
      if (normalizedScope === 'session') {
        return Boolean(normalizedSessionId) && row.session_id === normalizedSessionId;
      }
      if (normalizedScope === 'today') {
        return Date.parse(row.recorded_at) >= todayStartMs;
      }
      return true;
    });
    const exportLimit = normalizeLimit(limit, DEFAULT_MAX_TURNS, DEFAULT_MAX_TURNS);
    return {
      ok: true,
      scope: normalizedScope,
      rows: cloneRows(scopedRows.slice(-exportLimit).reverse()),
      persistence: {
        available: Boolean(this._store) && !this._readOnlyReason,
        durable: Boolean(this._store) && !this._readOnlyReason,
        read_only_reason: this._readOnlyReason || null,
      },
      retention: {
        max_age_days: this._maxAgeMs / DAY_MS,
        max_turns: this._maxTurns,
        retained_turns: retainedRows.length,
        oldest_at: retainedRows[0]?.recorded_at || '',
      },
    };
  }

  getRecentTurnUsage({ sessionId = '', limit = 50 } = {}) {
    const snapshot = this.getSnapshot({ sessionId, limit });
    return snapshot.recent_turns;
  }

  resetSession(sessionId) {
    const normalized = boundedText(sessionId, MAX_ID_CHARS);
    if (!normalized) {
      return { ok: true, cleared_turn_count: 0, durable: Boolean(this._store) };
    }
    const nextRows = this._rows.filter((row) => row.session_id !== normalized);
    const cleared = this._rows.length - nextRows.length;
    try {
      const result = this._commit(nextRows);
      this.emit('updated', { sessionId: normalized, clearedTurnCount: cleared });
      return { ok: true, cleared_turn_count: cleared, durable: result.durable };
    } catch (error) {
      this._lastRecordError = boundedErrorReason(error, 'reset_failed');
      this._log('WARN', 'usage_history.reset_failed', {
        errorCode: boundedText(error?.code, 40),
      });
      return {
        ok: false,
        cleared_turn_count: 0,
        durable: false,
        error: `Usage history could not be reset (${this._lastRecordError}).`,
      };
    }
  }

  clearHistory() {
    const cleared = this._rows.length;
    try {
      const result = this._commit([]);
      this.emit('updated', { cleared: true, clearedTurnCount: cleared });
      return { ok: true, cleared_turn_count: cleared, durable: result.durable };
    } catch (error) {
      this._lastRecordError = boundedErrorReason(error, 'clear_failed');
      this._log('WARN', 'usage_history.clear_failed', {
        errorCode: boundedText(error?.code, 40),
      });
      return {
        ok: false,
        cleared_turn_count: 0,
        durable: false,
        error: `Usage history could not be cleared (${this._lastRecordError || 'clear_failed'}).`,
      };
    }
  }
}

module.exports = {
  DEFAULT_MAX_AGE_DAYS,
  DEFAULT_MAX_TURNS,
  USAGE_HISTORY_SCHEMA_VERSION,
  UsageHistoryService,
  buildSpeed,
  buildTotals,
  normalizeTurnRow,
  pruneRows,
};
