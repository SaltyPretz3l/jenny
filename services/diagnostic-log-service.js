const crypto = require('node:crypto');

const { normalizeLogEntry, toPersistedMainLog } = require('./log-entry-normalizer');
const { ShellLogStore } = require('./shell-log-store');
const { readProcessLogHistory } = require('./process-log-reader');

const DIAGNOSTIC_SNAPSHOT_SCHEMA_VERSION = 1;
const CURRENT_RUN_LIMIT = 750;
const PRIOR_RUN_LIMIT = 250;
const MAX_ENTRY_BYTES = 16 * 1024;
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_DROP_COUNT = 1_000_000_000;
const SNAPSHOT_METADATA_RESERVE_BYTES = 64 * 1024;
const SOURCE_NAMES = Object.freeze(['electron', 'renderer', 'sidecar']);

function createRunId() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
}

function serializedBytes(value) {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch (_error) { return Infinity; }
}

function boundedText(value, maxBytes) {
  const text = String(value == null ? '' : value);
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const suffix = '…';
  const contentBudget = Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'));
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), 'utf8') <= contentBudget) low = middle;
    else high = middle - 1;
  }
  let prefix = text.slice(0, low);
  const lastCodeUnit = prefix.charCodeAt(prefix.length - 1);
  if (lastCodeUnit >= 0xD800 && lastCodeUnit <= 0xDBFF) prefix = prefix.slice(0, -1);
  return `${prefix}${suffix}`;
}

function boundEntry(entry) {
  if (serializedBytes(entry) <= MAX_ENTRY_BYTES) return entry;
  const data = entry?.data && typeof entry.data === 'object' ? entry.data : {};
  const originalSize = serializedBytes(entry);
  const bounded = {
    ts: boundedText(entry?.ts, 80), level: boundedText(entry?.level, 16),
    layer: boundedText(entry?.layer, 64), source: boundedText(entry?.source || entry?.layer, 64),
    component: boundedText(entry?.component, 160), event: boundedText(entry?.event, 240),
    message: boundedText(entry?.message, 4096), status: boundedText(entry?.status, 80),
    duration_ms: Number.isFinite(Number(entry?.duration_ms)) ? Number(entry.duration_ms) : null,
    trace_id: boundedText(entry?.trace_id, 160), request_id: boundedText(entry?.request_id, 160),
    session_id: boundedText(entry?.session_id, 160), tool_call_id: boundedText(entry?.tool_call_id, 160),
    approval_id: boundedText(entry?.approval_id, 160), rpc_id: boundedText(entry?.rpc_id, 160),
    run_id: boundedText(entry?.run_id, 160), entry_id: boundedText(entry?.entry_id, 240),
    origin_entry_id: boundedText(entry?.origin_entry_id, 160), sequence: Number(entry?.sequence) || 0,
    redaction_mode: 'redacted', schema_version: Number(entry?.schema_version) || 1,
    data: {
      _truncated: true,
      _original_size: originalSize,
      keys: Object.keys(data).slice(0, 24).map((key) => boundedText(key, 160)),
    },
  };
  bounded.details = { ...bounded.data, message: bounded.message, status: bounded.status };
  if (serializedBytes(bounded) <= MAX_ENTRY_BYTES) return bounded;
  return {
    ts: bounded.ts,
    level: bounded.level,
    layer: bounded.layer,
    source: bounded.source,
    component: boundedText(bounded.component, 80),
    event: boundedText(bounded.event, 120),
    message: boundedText(bounded.message, 512),
    run_id: bounded.run_id,
    entry_id: bounded.entry_id,
    origin_entry_id: bounded.origin_entry_id,
    sequence: bounded.sequence,
    redaction_mode: 'redacted',
    schema_version: bounded.schema_version,
    data: { _truncated: true, _original_size: originalSize },
    details: { _truncated: true, _original_size: originalSize },
  };
}

function normalizeDropCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.min(Math.floor(count), MAX_DROP_COUNT);
}

function entrySource(entry) {
  const source = String(entry?.layer || entry?.source || '').trim().toLowerCase();
  return SOURCE_NAMES.includes(source) ? source : 'electron';
}

function entryRemovalRank(entry) {
  const level = String(entry?.level || 'INFO').toUpperCase();
  return level === 'DEBUG' ? 0 : level === 'INFO' ? 1 : 2;
}

function selectEntriesWithinBudget(entries, maxBytes) {
  const sizes = entries.map((entry) => serializedBytes(entry) + 1);
  let total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= maxBytes) return { entries: entries.slice(), removed: [] };
  const retained = entries.map(() => true);
  const removed = [];
  for (let rank = 0; rank <= 2 && total > maxBytes; rank += 1) {
    for (let index = 0; index < entries.length && total > maxBytes; index += 1) {
      if (!retained[index] || entryRemovalRank(entries[index]) !== rank) continue;
      retained[index] = false;
      total -= sizes[index];
      removed.push(entries[index]);
    }
  }
  return { entries: entries.filter((_entry, index) => retained[index]), removed };
}

function sourceSummary(entries, integrity) {
  const sources = {};
  for (const source of SOURCE_NAMES) {
    const matching = entries.filter((entry) => String(entry?.layer || entry?.source || '') === source);
    const last = matching[matching.length - 1] || null;
    sources[source] = {
      state: matching.length > 0 ? 'observed' : 'waiting',
      capture_state: matching.length > 0 ? 'capturing' : 'awaiting_first_entry',
      count: matching.length,
      last_seen: last?.ts || null,
      dropped: Number(integrity.dropped_by_source[source] || 0),
    };
  }
  return sources;
}

class DiagnosticLogService {
  constructor({
    store,
    writer = null,
    filePath = '',
    onEntry = () => {},
    now = () => new Date(),
    runId = createRunId(),
    historyReader = readProcessLogHistory,
  } = {}) {
    this.store = store || new ShellLogStore({ limit: CURRENT_RUN_LIMIT, maxBytes: MAX_SNAPSHOT_BYTES });
    this.writer = writer;
    this.filePath = filePath;
    this.onEntry = typeof onEntry === 'function' ? onEntry : () => {};
    this.now = now;
    this.runId = boundedText(runId || createRunId(), 160);
    this.startedAt = this.now().toISOString();
    this.sequence = 0;
    this.originIds = new Set();
    this.historyReader = historyReader;
    this.historyPromise = null;
    this.priorEntries = [];
    this.priorRun = null;
    this.priorDroppedBySource = {};
    this.historyIntegrity = { malformed_count: 0, truncated: false, errors: [] };
    this.droppedBySource = { electron: 0, renderer: 0, sidecar: 0 };
  }

  append(rawEntry, { broadcast = true, persist = true, defaults = {} } = {}) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) return null;
    const originEntryId = boundedText(String(rawEntry.origin_entry_id || '').trim(), 160);
    if (originEntryId && this.originIds.has(originEntryId)) return null;
    let normalized;
    try {
      normalized = normalizeLogEntry({ ...rawEntry, redaction_mode: 'redacted' }, {
        ...defaults,
        redaction_mode: 'redacted',
      });
    } catch (_error) {
      return null;
    }
    this.sequence += 1;
    normalized.run_id = this.runId;
    normalized.sequence = this.sequence;
    normalized.entry_id = `${this.runId}:${this.sequence}`;
    if (originEntryId) normalized.origin_entry_id = originEntryId;
    normalized = boundEntry(normalized);
    const persisted = this.store.append(toPersistedMainLog(normalized.level, normalized));
    if (originEntryId) {
      this.originIds.add(originEntryId);
      if (this.originIds.size > CURRENT_RUN_LIMIT * 2) {
        const oldest = this.originIds.values().next().value;
        this.originIds.delete(oldest);
      }
    }
    if (persist && this.writer && typeof this.writer.write === 'function') {
      try { this.writer.write(persisted); } catch (_error) { /* diagnostics never break runtime */ }
    }
    if (broadcast) {
      try { this.onEntry(persisted); } catch (_error) { /* renderer availability is optional */ }
    }
    return persisted;
  }

  list() {
    return this.store.list();
  }

  getActiveRunMetadata() {
    return { run_id: this.runId, started_at: this.startedAt };
  }

  recordDrop(source, count = 1) {
    const key = SOURCE_NAMES.includes(source) ? source : 'electron';
    this.droppedBySource[key] = Math.min(
      MAX_DROP_COUNT,
      this.droppedBySource[key] + normalizeDropCount(count),
    );
  }

  getCurrentDiagnosticsMetadata() {
    const entries = this.list();
    const storeStats = typeof this.store.getStats === 'function' ? this.store.getStats() : {};
    const droppedBySource = { ...this.droppedBySource };
    for (const [source, count] of Object.entries(storeStats.dropped_by_source || {})) {
      const key = SOURCE_NAMES.includes(source) ? source : 'electron';
      droppedBySource[key] = Math.min(
        MAX_DROP_COUNT,
        droppedBySource[key] + normalizeDropCount(count),
      );
    }
    const writerDrops = this.writer?.stats?.droppedByLevel
      ? Object.values(this.writer.stats.droppedByLevel).reduce(
        (sum, count) => Math.min(MAX_DROP_COUNT, sum + normalizeDropCount(count)),
        0,
      )
      : 0;
    if (writerDrops > 0) droppedBySource.writer = writerDrops;
    const partialReasons = [];
    if (Object.values(droppedBySource).some((count) => count > 0)) partialReasons.push('entries_dropped');
    if (this.writer?.fileDisabled === true) partialReasons.push('history_writer_unavailable');
    const integrity = {
      complete: partialReasons.length === 0,
      partial_reasons: partialReasons,
      dropped_by_source: droppedBySource,
      capture_policy: {
        electron: 'info_and_above_with_debug_when_emitted',
        renderer: 'info_and_above; debug_in_agent_mode',
        sidecar: 'configured_sidecar_log_level',
      },
    };
    return { sources: sourceSummary(entries, integrity), integrity };
  }

  async _loadHistory() {
    if (!this.filePath || typeof this.historyReader !== 'function') return;
    const result = await this.historyReader({ filePath: this.filePath });
    this.historyIntegrity = result || this.historyIntegrity;
    const recovered = Array.isArray(result?.entries) ? result.entries : [];
    const candidates = recovered.filter((entry) => String(entry?.run_id || '') !== this.runId);
    const priorRawRunId = String(candidates[candidates.length - 1]?.run_id || '').trim();
    const priorRunId = boundedText(priorRawRunId, 160);
    const selected = priorRawRunId
      ? candidates.filter((entry) => String(entry?.run_id || '') === priorRawRunId)
      : candidates.filter((entry) => !String(entry?.run_id || '').trim());
    const legacy = !priorRunId;
    const priorStore = new ShellLogStore({ limit: PRIOR_RUN_LIMIT, maxBytes: MAX_SNAPSHOT_BYTES });
    selected.forEach((raw, index) => {
      const entry = boundEntry(normalizeLogEntry({ ...raw, redaction_mode: 'redacted' }));
      entry.run_id = priorRunId || 'legacy-prior';
      entry.sequence = Number(raw?.sequence) || index + 1;
      entry.entry_id = boundedText(raw?.entry_id || `${entry.run_id}:${entry.sequence}`, 240);
      priorStore.append(boundEntry(entry));
    });
    this.priorEntries = priorStore.list();
    this.priorDroppedBySource = priorStore.getStats().dropped_by_source;
    if (this.priorEntries.length > 0) {
      this.priorRun = {
        run_id: priorRunId || 'legacy-prior',
        started_at: this.priorEntries[0]?.ts || null,
        ended_at: this.priorEntries[this.priorEntries.length - 1]?.ts || null,
        legacy,
      };
    }
  }

  async getSnapshot() {
    if (!this.historyPromise) {
      this.historyPromise = this._loadHistory().catch((error) => {
        this.historyIntegrity.errors = [{ code: String(error?.code || 'history_read_failed') }];
      });
    }
    await this.historyPromise;
    const currentEntries = this.list();
    const metadata = this.getCurrentDiagnosticsMetadata();
    const historyReasons = [];
    if (Number(this.historyIntegrity?.malformed_count || 0) > 0) historyReasons.push('history_malformed');
    if (this.historyIntegrity?.truncated === true) historyReasons.push('history_truncated');
    if (Array.isArray(this.historyIntegrity?.errors) && this.historyIntegrity.errors.length > 0) {
      historyReasons.push('history_unavailable');
    }
    if (Object.values(this.priorDroppedBySource).some((count) => count > 0)) {
      historyReasons.push('prior_retention_truncated');
    }
    const globalPartialReasons = Array.from(new Set([
      ...metadata.integrity.partial_reasons,
      ...historyReasons,
    ]));
    const candidates = [...this.priorEntries, ...currentEntries];
    const entryBudget = Math.max(0, MAX_SNAPSHOT_BYTES - SNAPSHOT_METADATA_RESERVE_BYTES);
    const selection = selectEntriesWithinBudget(candidates, entryBudget);
    let entries = selection.entries;
    const snapshotDrops = {};
    const snapshotDropsByRun = {};
    for (const removed of selection.removed) {
      const source = entrySource(removed);
      const runId = String(removed?.run_id || this.runId);
      snapshotDrops[source] = Number(snapshotDrops[source] || 0) + 1;
      snapshotDropsByRun[runId] = Number(snapshotDropsByRun[runId] || 0) + 1;
    }
    if (Object.keys(snapshotDrops).length > 0) globalPartialReasons.push('snapshot_truncated');
    const droppedBySource = { ...metadata.integrity.dropped_by_source };
    for (const [source, count] of Object.entries(this.priorDroppedBySource)) {
      droppedBySource[source] = Number(droppedBySource[source] || 0) + normalizeDropCount(count);
    }
    for (const [source, count] of Object.entries(snapshotDrops)) {
      droppedBySource[source] = Number(droppedBySource[source] || 0) + count;
    }
    const currentRetained = entries.filter((entry) => String(entry?.run_id || '') === this.runId);
    const activeReasons = metadata.integrity.partial_reasons.slice();
    if (snapshotDropsByRun[this.runId] > 0) activeReasons.push('snapshot_truncated');
    const activeDropped = { ...metadata.integrity.dropped_by_source };
    for (const removed of selection.removed) {
      if (String(removed?.run_id || '') !== this.runId) continue;
      const source = entrySource(removed);
      activeDropped[source] = Number(activeDropped[source] || 0) + 1;
    }
    const activeIntegrity = {
      ...metadata.integrity,
      complete: activeReasons.length === 0,
      partial_reasons: Array.from(new Set(activeReasons)).slice(0, 12),
      dropped_by_source: activeDropped,
    };
    const activeSources = sourceSummary(currentRetained, activeIntegrity);
    const activeRun = {
      run_id: this.runId,
      started_at: this.startedAt,
      sources: activeSources,
      integrity: activeIntegrity,
    };
    let priorRun = this.priorRun;
    if (priorRun) {
      const priorRetained = entries.filter((entry) => String(entry?.run_id || '') === priorRun.run_id);
      const priorReasons = historyReasons.slice();
      if (snapshotDropsByRun[priorRun.run_id] > 0) priorReasons.push('snapshot_truncated');
      const priorDropped = { ...this.priorDroppedBySource };
      for (const removed of selection.removed) {
        if (String(removed?.run_id || '') !== priorRun.run_id) continue;
        const source = entrySource(removed);
        priorDropped[source] = Number(priorDropped[source] || 0) + 1;
      }
      const priorIntegrity = {
        complete: priorReasons.length === 0,
        partial_reasons: Array.from(new Set(priorReasons)).slice(0, 12),
        dropped_by_source: priorDropped,
        capture_policy: metadata.integrity.capture_policy,
        history_malformed_count: Number(this.historyIntegrity?.malformed_count || 0),
      };
      const priorSources = sourceSummary(priorRetained, priorIntegrity);
      for (const source of Object.values(priorSources)) {
        source.capture_state = source.count > 0 ? 'historical' : 'not_observed';
      }
      priorRun = { ...priorRun, sources: priorSources, integrity: priorIntegrity };
    }
    const boundedPartialReasons = Array.from(new Set(globalPartialReasons)).slice(0, 12);
    let snapshot = {
      schema_version: DIAGNOSTIC_SNAPSHOT_SCHEMA_VERSION,
      generated_at: this.now().toISOString(),
      active_run: activeRun,
      prior_run: priorRun,
      entries,
      sources: activeSources,
      integrity: {
        ...metadata.integrity,
        complete: boundedPartialReasons.length === 0,
        partial_reasons: boundedPartialReasons,
        dropped_by_source: droppedBySource,
        history_malformed_count: Number(this.historyIntegrity?.malformed_count || 0),
      },
    };
    while (entries.length > 0 && serializedBytes(snapshot) > MAX_SNAPSHOT_BYTES) {
      const removed = entries.shift();
      const source = entrySource(removed);
      snapshot.integrity.complete = false;
      snapshot.integrity.partial_reasons = Array.from(new Set([
        ...snapshot.integrity.partial_reasons,
        'snapshot_truncated',
      ])).slice(0, 12);
      snapshot.integrity.dropped_by_source[source] = Number(
        snapshot.integrity.dropped_by_source[source] || 0,
      ) + 1;
      snapshot.entries = entries;
    }
    return snapshot;
  }
}

module.exports = {
  DiagnosticLogService,
  MAX_ENTRY_BYTES,
};
