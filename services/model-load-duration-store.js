'use strict';

// Remembers how long each model's last load took (status loader, area 5 of the
// shell-chrome program, owner-approved 2026-09-29) so the health popover can
// set an expectation ("Last time: 48 s") while the next load is in flight.
//
// Backed by FileJsonStore at <userData>/model-load-durations.json, bounded to
// MAX_ENTRIES (engine, model) pairs, least-recently-observed evicted first.
// Never throws: a corrupt or unreadable file degrades to an empty store, the
// same posture as every other FileJsonStore-backed cache in this codebase. The
// file is read once per process; later reads are served from memory.
const { FileJsonStore } = require('./backend/file-json-store');

// Mirrors the renderer's canonicalOllamaTag (renderer-model-library-format-utils):
// lower-cased, and a bare name reads as `:latest`. Kept local so a main-process
// service never requires a renderer shell module.
function canonicalOllamaTag(value) {
  const tag = String(value || '').trim().toLowerCase();
  if (!tag) return '';
  const lastSegment = tag.slice(tag.lastIndexOf('/') + 1);
  return lastSegment.indexOf(':') === -1 ? tag + ':latest' : tag;
}

const STORE_VERSION = 1;
const MAX_ENTRIES = 20;
// A load that took longer than this is a stalled process, not an expectation.
const MAX_DURATION_MS = 60 * 60 * 1000;
// A sub-second load is a warm reload of a resident model (owner, 2026-09-29):
// not recorded, so the cold-load figure the popover exists for survives.
const MIN_RECORDED_MS = 1000;

function _str(value, maxLen = 240) {
  return String(value == null ? '' : value).trim().slice(0, maxLen);
}

function _durationMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= MAX_DURATION_MS ? Math.round(n) : 0;
}

// Ollama reads a bare name as `:latest` and tags case-insensitively, so
// `qwen3` and `qwen3:latest` are one entry; other engines' ids stay verbatim.
function buildDurationKey({ engine, modelId } = {}) {
  const engineKey = _str(engine, 40).toLowerCase() || 'unknown';
  const rawModel = _str(modelId, 240);
  const modelKey = engineKey === 'ollama' ? canonicalOllamaTag(rawModel) : rawModel;
  return modelKey ? `${engineKey}|${modelKey}` : '';
}

function normalizeEntry(raw = {}) {
  const observedAt = Number(raw.observedAt);
  return {
    engine: _str(raw.engine, 40).toLowerCase(),
    modelId: _str(raw.modelId, 240),
    lastMs: _durationMs(raw.lastMs),
    observedAt: Number.isFinite(observedAt) && observedAt > 0 ? observedAt : 0,
  };
}

function emptyState() {
  return { version: STORE_VERSION, durations: {} };
}

class ModelLoadDurationStore {
  constructor({ filePath, logger, now = () => Date.now(), store = null } = {}) {
    this._now = typeof now === 'function' ? now : () => Date.now();
    this._store = store || new FileJsonStore(filePath, { logger });
    this._logger = typeof logger === 'function' ? logger : null;
    this._state = null;
  }

  _readState() {
    if (!this._state) this._state = this._loadState();
    return this._state;
  }

  _loadState() {
    try {
      const { value } = this._store.readWithStatus(emptyState());
      if (!value || typeof value !== 'object' || value.version !== STORE_VERSION
        || !value.durations || typeof value.durations !== 'object') {
        return emptyState();
      }
      return { version: STORE_VERSION, durations: { ...value.durations } };
    } catch (_) {
      return emptyState();
    }
  }

  _writeState(state) {
    this._state = state;
    try {
      this._store.write(state);
    } catch (error) {
      this._log('model_load_duration_store.write_failed', error);
    }
  }

  _log(event, error) {
    try {
      this._logger?.('WARN', event, { message: String(error?.message || error) });
    } catch (_) {
      // logging must never throw
    }
  }

  /** The last recorded load of (engine, model), or null when none is known. */
  get({ engine, modelId } = {}) {
    try {
      const key = buildDurationKey({ engine, modelId });
      if (!key) return null;
      const raw = this._readState().durations[key];
      if (!raw) return null;
      const entry = normalizeEntry(raw);
      return entry.lastMs > 0 ? entry : null;
    } catch (_) {
      return null;
    }
  }

  /** Records a load; an out-of-range duration or an unnamed model is ignored. */
  record({ engine, modelId, durationMs } = {}) {
    try {
      const entry = normalizeEntry({ engine, modelId, lastMs: durationMs, observedAt: this._now() });
      const key = buildDurationKey(entry);
      if (!key || entry.lastMs < MIN_RECORDED_MS) return null;
      const durations = { ...this._readState().durations, [key]: entry };
      let entries = Object.entries(durations);
      if (entries.length > MAX_ENTRIES) {
        entries = entries
          .sort((a, b) => Number(b[1]?.observedAt || 0) - Number(a[1]?.observedAt || 0))
          .slice(0, MAX_ENTRIES);
      }
      this._writeState({ version: STORE_VERSION, durations: Object.fromEntries(entries) });
      return entry;
    } catch (error) {
      this._log('model_load_duration_store.record_failed', error);
      return null;
    }
  }

  list() {
    try {
      return Object.values(this._readState().durations).map(normalizeEntry).filter((entry) => entry.lastMs > 0);
    } catch (_) {
      return [];
    }
  }
}

module.exports = {
  ModelLoadDurationStore,
  buildDurationKey,
  normalizeEntry,
  MAX_ENTRIES,
  MAX_DURATION_MS,
  MIN_RECORDED_MS,
  STORE_VERSION,
};
