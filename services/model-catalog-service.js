'use strict';

/**
 * services/model-catalog-service.js
 *
 * Owns the hardware -> recommended-model catalog in the MAIN process.
 *
 * Resolution order for getCatalog(): userData cache (freshest) -> bundled default.
 * refresh() fetches a remote catalog (throttled), validates it strictly, accepts
 * it only when catalogVersion is monotonically >= the current one, then writes the
 * userData cache. Any failure (offline, malformed, stale) keeps the prior catalog,
 * so the app degrades gracefully and works fully offline.
 *
 * The catalog is consumed by the sidecar recommendation engine (passed inline as
 * the `model_catalog` RPC param via offline.getDiagnostics) — see
 * sidecar/runtime/hardware_profile.py. Network stays entirely in the main process.
 */

const fs = require('fs');
const path = require('path');
const { requestWithTimeout } = require('./http-fetch-util');

const DEFAULT_THROTTLE_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_CATALOG_BYTES = 256 * 1024;
const MAX_CATALOG_MODELS = 128;
const MAX_CATALOG_STRING_LENGTH = 256;
const MAX_MODEL_SIZE_MB = 2_147_483_647;
// Public, unauthenticated URL — must point at the PUBLIC distribution repo so a
// friend's clone can refresh the catalog. Overridable via JENNY_MODEL_CATALOG_URL.
const DEFAULT_REMOTE_URL =
  'https://raw.githubusercontent.com/SaltyPretz3l/jenny/main/config/model-recommendation-catalog.json';

function clampInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0
    ? Math.min(Math.floor(n), MAX_MODEL_SIZE_MB)
    : 0;
}

function boundedString(value) {
  return String(value || '').trim().slice(0, MAX_CATALOG_STRING_LENGTH);
}

function hasUnsafeTagChars(value) {
  return /\s/u.test(value)
    || Array.from(value).some((char) => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127);
}

/**
 * Bound + sanitize an etag from either boundary (persisted `.meta.json` or a
 * live response header) so a poisoned/oversized value can never reach an
 * outgoing request header (undici throws on CRLF/NUL, which would otherwise
 * leave the poisoned etag stuck forever) or bloat the on-disk meta file.
 * Unlike hasUnsafeTagChars, spaces are legal inside a quoted etag, so this
 * only rejects actual control characters.
 */
function sanitizeEtag(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().slice(0, MAX_CATALOG_STRING_LENGTH);
  if (!trimmed) {
    return null;
  }
  for (const char of trimmed) {
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) {
      return null;
    }
  }
  return trimmed;
}

async function readBoundedResponseText(response) {
  const declaredLength = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CATALOG_BYTES) {
    throw new Error('model catalog response exceeds size limit');
  }

  const reader = response?.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_CATALOG_BYTES) {
      throw new Error('model catalog response exceeds size limit');
    }
    return text;
  }

  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value?.byteLength || 0;
      if (totalBytes > MAX_CATALOG_BYTES) {
        throw new Error('model catalog response exceeds size limit');
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    await reader.cancel?.().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock?.();
  }
}

class ModelCatalogService {
  constructor({
    bundledPath,
    cachePath,
    remoteUrl = DEFAULT_REMOTE_URL,
    fetchImpl = globalThis.fetch,
    fsImpl = fs,
    nowProvider = () => Date.now(),
    throttleMs = DEFAULT_THROTTLE_MS,
    logger = () => {},
  } = {}) {
    this.bundledPath = bundledPath || path.join(__dirname, '..', 'config', 'model-recommendation-catalog.json');
    this.cachePath = cachePath || null;
    this.metaPath = this.cachePath ? `${this.cachePath}.meta.json` : null;
    this.remoteUrl = String(remoteUrl || '').trim();
    this.fetchImpl = typeof fetchImpl === 'function' ? fetchImpl : null;
    this.fsImpl = fsImpl || fs;
    this.nowProvider = typeof nowProvider === 'function' ? nowProvider : () => Date.now();
    this.throttleMs = Number.isFinite(throttleMs) && throttleMs >= 0 ? throttleMs : DEFAULT_THROTTLE_MS;
    this.logger = typeof logger === 'function' ? logger : () => {};
    this._catalog = null;
    const refreshMeta = this._readJsonFile(this.metaPath);
    const hasValidRefreshMeta = refreshMeta
      && typeof refreshMeta === 'object'
      && !Array.isArray(refreshMeta)
      && Number.isFinite(refreshMeta.last_fetched_at)
      && refreshMeta.last_fetched_at >= 0
      && refreshMeta.last_fetched_at <= this.nowProvider()
      && (refreshMeta.etag === null || typeof refreshMeta.etag === 'string');
    this._lastFetchedAt = hasValidRefreshMeta
      ? refreshMeta.last_fetched_at
      : Number.NEGATIVE_INFINITY;
    // Only trust a persisted etag when the cache it validates still loads and
    // parses. Otherwise a 304 would hand back the (silently fallen-back-to)
    // bundled catalog while logging as if the cache were fresh. last_fetched_at
    // stays seeded from meta either way -- it is the independent anti-hammer
    // stamp and does not depend on cache validity.
    const cacheUsable = this.cachePath ? this.validate(this._readJsonFile(this.cachePath)) !== null : false;
    this._etag = hasValidRefreshMeta && cacheUsable
      ? sanitizeEtag(refreshMeta.etag)
      : null;
  }

  _log(level, event, data) {
    try {
      this.logger(level, event, data || {});
    } catch (_error) {
      // logging must never throw
    }
  }

  _readJsonFile(filePath) {
    if (!filePath) {
      return null;
    }
    try {
      const text = this.fsImpl.readFileSync(filePath, 'utf8');
      return JSON.parse(text);
    } catch (_error) {
      return null;
    }
  }

  /** Validate + sanitize a raw catalog object; returns null when unusable. */
  validate(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      return null;
    }
    const version = Math.floor(Number(obj.catalogVersion));
    if (!Number.isSafeInteger(version) || version < 1) {
      return null;
    }
    const rawModels = Array.isArray(obj.models) ? obj.models : [];
    const models = [];
    for (const entry of rawModels.slice(0, MAX_CATALOG_MODELS)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        continue;
      }
      const pullTag = boundedString(entry.pullTag || entry.modelId);
      if (!pullTag || hasUnsafeTagChars(pullTag)) {
        continue;
      }
      models.push({
        tier: boundedString(entry.tier),
        modelId: boundedString(entry.modelId || pullTag),
        displayName: boundedString(entry.displayName || entry.modelId || pullTag),
        params: boundedString(entry.params),
        quant: boundedString(entry.quant),
        vramRequiredMb: clampInt(entry.vramRequiredMb),
        ramRequiredMb: clampInt(entry.ramRequiredMb),
        contextLength: clampInt(entry.contextLength),
        downloadSizeMb: clampInt(entry.downloadSizeMb),
        pullTag,
        preferred: entry.preferred === true,
      });
    }
    if (!models.length) {
      return null;
    }
    return {
      catalogVersion: version,
      updatedAt: boundedString(obj.updatedAt),
      source: boundedString(obj.source),
      models,
    };
  }

  _loadBundled() {
    const bundled = this.validate(this._readJsonFile(this.bundledPath));
    if (bundled) {
      return bundled;
    }
    // Bundled file should always be present + valid; this is a last-ditch guard.
    // The sidecar has its own _FALLBACK_CATALOG, so an empty list is still safe.
    this._log('WARN', 'model_catalog.bundled_missing', { path: this.bundledPath });
    return { catalogVersion: 0, updatedAt: '', source: 'empty', models: [] };
  }

  /** Synchronous, memoized: cache (if valid) else bundled default. Never throws. */
  getCatalog() {
    if (this._catalog) {
      return this._catalog;
    }
    const cached = this.validate(this._readJsonFile(this.cachePath));
    this._catalog = cached || this._loadBundled();
    return this._catalog;
  }

  getMeta() {
    const catalog = this.getCatalog();
    return {
      version: catalog.catalogVersion,
      updatedAt: catalog.updatedAt,
      source: catalog.source,
    };
  }

  /** Returns true/false for an attempted write, or null when there is no cachePath configured (nothing to write -- not a failure). */
  _writeCache(catalog) {
    if (!this.cachePath) {
      return null;
    }
    try {
      this.fsImpl.writeFileSync(this.cachePath, JSON.stringify(catalog, null, 2), 'utf8');
      return true;
    } catch (error) {
      this._log('DEBUG', 'model_catalog.cache_write_failed', {
        message: String((error && error.message) || error),
      });
      return false;
    }
  }

  _writeRefreshMetadata(lastFetchedAt, etag) {
    this._lastFetchedAt = lastFetchedAt;
    this._etag = sanitizeEtag(etag);
    if (!this.metaPath) {
      return;
    }
    try {
      this.fsImpl.writeFileSync(this.metaPath, JSON.stringify({
        last_fetched_at: this._lastFetchedAt,
        etag: this._etag,
      }, null, 2), 'utf8');
    } catch (error) {
      this._log('DEBUG', 'model_catalog.meta_write_failed', {
        message: String((error && error.message) || error).slice(0, 256),
      });
    }
  }

  /**
   * Throttled remote refresh. Fire-and-forget safe (never rejects). Returns the
   * resulting current catalog. Accepts the remote only when valid AND its
   * catalogVersion is >= the current one; otherwise keeps the prior catalog.
   */
  async refresh({ force = false } = {}) {
    const now = this.nowProvider();
    if (!force && now - this._lastFetchedAt < this.throttleMs) {
      return this.getCatalog();
    }
    // Stamp before fetching so concurrent / failing fetches don't hammer the endpoint.
    this._lastFetchedAt = now;
    if (!this.remoteUrl || !this.fetchImpl) {
      return this.getCatalog();
    }
    try {
      const headers = this._etag ? { 'If-None-Match': this._etag } : undefined;
      const response = await requestWithTimeout(this.remoteUrl, {
        method: 'GET',
        headers,
        fetchImpl: this.fetchImpl,
      });
      const responseEtag = response?.headers?.get?.('etag');
      if (Number(response?.status) === 304) {
        this._writeRefreshMetadata(now, responseEtag || this._etag);
        this._log('INFO', 'model_catalog.not_modified', {
          version: this.getCatalog().catalogVersion,
        });
        return this.getCatalog();
      }
      if (!response || response.ok !== true) {
        this._log('DEBUG', 'model_catalog.refresh_http_error', {
          status: Number((response && response.status) || 0),
        });
        return this.getCatalog();
      }
      const text = await readBoundedResponseText(response);
      const validated = this.validate(JSON.parse(text));
      if (!validated) {
        this._log('WARN', 'model_catalog.refresh_invalid');
        return this.getCatalog();
      }
      const current = this.getCatalog();
      if (validated.catalogVersion < (current.catalogVersion || 0)) {
        this._log('DEBUG', 'model_catalog.refresh_stale', {
          remote: validated.catalogVersion,
          current: current.catalogVersion,
        });
        this._writeRefreshMetadata(now, responseEtag);
        return current;
      }
      const cacheWritten = this._writeCache(validated);
      this._catalog = validated;
      if (cacheWritten !== false) {
        this._writeRefreshMetadata(now, responseEtag);
      }
      this._log('INFO', 'model_catalog.refreshed', {
        version: validated.catalogVersion,
        models: validated.models.length,
      });
      return validated;
    } catch (error) {
      this._log('DEBUG', 'model_catalog.refresh_failed', {
        message: String((error && error.message) || error),
      });
      return this.getCatalog();
    }
  }
}

module.exports = {
  ModelCatalogService,
  DEFAULT_REMOTE_URL,
  DEFAULT_THROTTLE_MS,
  MAX_CATALOG_BYTES,
  MAX_CATALOG_MODELS,
};
