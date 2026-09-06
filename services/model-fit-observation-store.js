'use strict';

// Persists measured model-footprint observations (Wave 4: "record on first
// load, then self-catalog") so a model's real Ollama /api/ps size/VRAM
// footprint survives restarts and feeds services/model-fit-diagnostics.js
// with source:'observed' entries instead of a pure estimate.
//
// Backed by FileJsonStore at <userData>/model-fit-observations.json. Never
// throws — a corrupt/unreadable file degrades to an empty store (same
// posture as every other FileJsonStore-backed cache in this codebase).
const { FileJsonStore } = require('./backend/file-json-store');

const STORE_VERSION = 1;
const MAX_ENTRIES = 64;
const TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

function _str(value, maxLen = 240) {
  return String(value == null ? '' : value).trim().slice(0, maxLen);
}

function _nonNegInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Identity key for an observation, WITHOUT context length: an observation is
 * only valid for the exact (engine, model-identity, GPU, GPU-VRAM) tuple it
 * was measured under — the same model on a different GPU has a different
 * real footprint. Context length is deliberately excluded here so get() can
 * scan every contextLength recorded for one (model, GPU) and pick the
 * largest — a fit measured at a bigger context is the conservative one.
 */
function buildObservationIdentityKey({ engine, digest, modelId, gpuName, gpuVramMb } = {}) {
  const engineKey = _str(engine || 'ollama', 32).toLowerCase() || 'ollama';
  const modelKey = _str(digest, 128) || _str(modelId, 240).toLowerCase();
  const gpuKey = _str(gpuName, 120).toLowerCase() || 'unknown-gpu';
  const vramKey = String(_nonNegInt(gpuVramMb));
  return `${engineKey}|${modelKey}|${gpuKey}|${vramKey}`;
}

/**
 * Deterministic storage key for an observation: the identity key plus the
 * context length it was measured under, so an 8k and a 128k measurement of
 * the same (model, GPU) are stored as two distinct entries instead of one
 * overwriting the other.
 */
function buildObservationKey({ engine, digest, modelId, gpuName, gpuVramMb, contextLength } = {}) {
  const identityKey = buildObservationIdentityKey({ engine, digest, modelId, gpuName, gpuVramMb });
  const ctxKey = String(_nonNegInt(contextLength));
  return `${identityKey}|${ctxKey}`;
}

function normalizeObservation(raw = {}) {
  const observedAt = Number(raw.observedAt);
  return {
    modelId: _str(raw.modelId, 240),
    digest: _str(raw.digest, 128),
    engine: _str(raw.engine || 'ollama', 32).toLowerCase() || 'ollama',
    gpuName: _str(raw.gpuName, 120),
    gpuVramMb: _nonNegInt(raw.gpuVramMb),
    contextLength: _nonNegInt(raw.contextLength),
    sizeMb: _nonNegInt(raw.sizeMb),
    vramMb: _nonNegInt(raw.vramMb),
    offloadedMb: _nonNegInt(raw.offloadedMb),
    residentModelCount: _nonNegInt(raw.residentModelCount),
    observedAt: Number.isFinite(observedAt) && observedAt > 0 ? observedAt : Date.now(),
  };
}

class ModelFitObservationStore {
  constructor({ filePath, logger, now = () => Date.now(), store = null } = {}) {
    this._now = typeof now === 'function' ? now : () => Date.now();
    this._store = store || new FileJsonStore(filePath, { logger });
    this._logger = typeof logger === 'function' ? logger : null;
  }

  _readState() {
    try {
      const { value } = this._store.readWithStatus({ version: STORE_VERSION, observations: {} });
      if (!value || typeof value !== 'object' || !value.observations || typeof value.observations !== 'object') {
        return { version: STORE_VERSION, observations: {} };
      }
      return value;
    } catch (_) {
      return { version: STORE_VERSION, observations: {} };
    }
  }

  _writeState(state) {
    try {
      this._store.write(state);
    } catch (error) {
      try {
        this._logger?.('WARN', 'model_fit_observation_store.write_failed', {
          message: String(error?.message || error),
        });
      } catch (_) {
        // logging must never throw
      }
    }
  }

  /**
   * Drop entries older than the TTL and, if still over MAX_ENTRIES, evict the
   * least-recently-observed ones (LRU by observedAt). Called on load and on
   * every record(). Never throws.
   */
  prune() {
    try {
      const state = this._readState();
      const nowMs = this._now();
      const entries = Object.entries(state.observations || {});
      let kept = entries.filter(([, obs]) => nowMs - Number(obs?.observedAt || 0) <= TTL_MS);
      if (kept.length > MAX_ENTRIES) {
        kept = kept
          .sort((a, b) => Number(b[1]?.observedAt || 0) - Number(a[1]?.observedAt || 0))
          .slice(0, MAX_ENTRIES);
      }
      if (kept.length !== entries.length) {
        const nextState = { version: STORE_VERSION, observations: Object.fromEntries(kept) };
        this._writeState(nextState);
        return nextState;
      }
      return state;
    } catch (_) {
      return { version: STORE_VERSION, observations: {} };
    }
  }

  /**
   * Looks up by (engine, model-identity, GPU) only — ignoring context length —
   * and, when multiple context-length measurements exist for that tuple,
   * returns the one recorded at the largest context length (the conservative
   * fit: it was measured under the heaviest KV-cache load).
   */
  get({ modelId, digest, gpuName, gpuVramMb, engine = 'ollama' } = {}) {
    try {
      const identityKey = buildObservationIdentityKey({ engine, digest, modelId, gpuName, gpuVramMb });
      const state = this._readState();
      const prefix = `${identityKey}|`;
      let best = null;
      for (const [key, raw] of Object.entries(state.observations || {})) {
        if (!key.startsWith(prefix)) continue;
        const normalized = normalizeObservation(raw);
        if (!best || normalized.contextLength > best.contextLength) best = normalized;
      }
      return best;
    } catch (_) {
      return null;
    }
  }

  record(observation) {
    try {
      const normalized = normalizeObservation({ ...observation, observedAt: this._now() });
      const key = buildObservationKey(normalized);
      const state = this.prune();
      const observations = { ...(state.observations || {}), [key]: normalized };
      let entries = Object.entries(observations);
      if (entries.length > MAX_ENTRIES) {
        entries = entries
          .sort((a, b) => Number(b[1]?.observedAt || 0) - Number(a[1]?.observedAt || 0))
          .slice(0, MAX_ENTRIES);
      }
      const nextState = { version: STORE_VERSION, observations: Object.fromEntries(entries) };
      this._writeState(nextState);
      return normalized;
    } catch (error) {
      try {
        this._logger?.('WARN', 'model_fit_observation_store.record_failed', {
          message: String(error?.message || error),
        });
      } catch (_) {
        // logging must never throw
      }
      return null;
    }
  }

  list() {
    try {
      const state = this._readState();
      return Object.values(state.observations || {}).map(normalizeObservation);
    } catch (_) {
      return [];
    }
  }
}

module.exports = {
  ModelFitObservationStore,
  buildObservationKey,
  normalizeObservation,
  MAX_ENTRIES,
  TTL_MS,
};
