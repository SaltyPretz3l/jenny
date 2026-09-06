'use strict';

// Single-record persisted store for the ChatGPT plan-usage meter
// (<userData>/chatgpt-plan-usage.json). Wraps FileJsonStore for the atomic
// write + corruption-tolerant read (see file-json-store.js) and layers on:
// account-key scoping (so a stale record from a different signed-in account
// can never render), a 7-day read-side TTL, a feature-flag gate, and a
// sign-out hook that clears the file. See docs/plans "ChatGPT plan-usage
// meter" W2 and the seam-failure-contract table there.

const crypto = require('node:crypto');

const { FileJsonStore } = require('./file-json-store');
const {
  PLAN_USAGE_MAX_AGE_MS,
  normalizePlanUsageSnapshot,
  buildPlanUsageRecord,
} = require('./chatgpt-plan-usage');

function hashAccountId(accountId) {
  return crypto.createHash('sha256').update(String(accountId || ''), 'utf8').digest('hex').slice(0, 16);
}

function isPlainRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// createChatGptPlanUsageStore({ filePath, getAccountId, getFeatureFlags, logger, now })
//  - filePath: absolute path to chatgpt-plan-usage.json.
//  - getAccountId(): () => string, the current signed-in ChatGPT account id
//    (raw, never persisted -- only its truncated sha256 is written to disk).
//  - getFeatureFlags(): () => object; `chatgpt_plan_meter === false` gates
//    both ingest and read (byte-identical rollback -- no file, no channel data).
//  - logger(level, event, fields): optional, matches _emitServiceLog.
//  - now(): () => number, defaults to Date.now.
function createChatGptPlanUsageStore({
  filePath,
  getAccountId = () => '',
  getFeatureFlags = () => ({}),
  logger = null,
  now = Date.now,
} = {}) {
  if (!filePath) {
    throw new TypeError('createChatGptPlanUsageStore requires filePath.');
  }
  const fileStore = new FileJsonStore(filePath, { logger });
  const changeListeners = new Set();
  let authUnsubscribe = null;
  let disposed = false;
  // Read cache: `undefined` = not read yet; null/record afterwards. Every
  // backend-status tick asks for a snapshot, so the file is read once and
  // then only re-read after a write/clear of our own.
  let cachedRecord;

  function resolveAccountId() {
    try {
      return String(getAccountId() || '');
    } catch (_error) {
      return '';
    }
  }

  function currentNow() {
    return typeof now === 'function' ? now() : Number(now);
  }

  function flagsEnabled() {
    let flags = null;
    try {
      flags = getFeatureFlags();
    } catch (_error) {
      // Treat a throwing flags getter the same as no flags: default-on.
    }
    return !(flags && flags.chatgpt_plan_meter === false);
  }

  function logEvent(level, event, fields) {
    if (typeof logger !== 'function') {
      return;
    }
    try {
      logger(level, event, fields);
    } catch (_error) {
      // Logging is best-effort and must never break the store.
    }
  }

  function emitChanged(record) {
    for (const listener of [...changeListeners]) {
      try {
        listener(record);
      } catch (_error) {
        // A subscriber failure must not affect store state.
      }
    }
  }

  function readRecord() {
    if (cachedRecord !== undefined) {
      return cachedRecord;
    }
    const { value } = fileStore.readWithStatus(null);
    cachedRecord = isPlainRecord(value) ? value : null;
    return cachedRecord;
  }

  // getSnapshot() -> the persisted record, or null when: the flag is off, no
  // record is on disk, the record belongs to a different account (stale
  // sign-in), or the record is older than PLAN_USAGE_MAX_AGE_MS. A stale/
  // mismatched record is never deleted here -- TTL and account-key checks are
  // read-side filters, not write-side mutations (clear() is the only deleter).
  function getSnapshot() {
    if (!flagsEnabled()) {
      return null;
    }
    const record = readRecord();
    if (!record) {
      return null;
    }
    const accountId = resolveAccountId();
    if (!accountId) {
      // No identity -> no scope. hashAccountId('') is a well-known constant
      // that would let any signed-out/unknown state read another's record.
      return null;
    }
    const expectedAccountKey = hashAccountId(accountId);
    if (record.account_key !== expectedAccountKey) {
      return null;
    }
    const capturedAtMs = Number(record.captured_at_ms);
    if (!Number.isFinite(capturedAtMs) || currentNow() - capturedAtMs > PLAN_USAGE_MAX_AGE_MS) {
      return null;
    }
    return record;
  }

  // ingest(raw, { source }) -- flag gate -> normalize -> build record ->
  // persist -> emit. A write failure is logged and swallowed: the in-memory
  // `changed` emission still fires so the live meter updates even when the
  // disk write did not land (rewritten on the next ingest).
  function ingest(raw, { source } = {}) {
    if (!flagsEnabled()) {
      return;
    }
    const normalized = normalizePlanUsageSnapshot(raw);
    if (!normalized) {
      return;
    }
    const accountId = resolveAccountId();
    if (!accountId) {
      return;
    }
    const accountKey = hashAccountId(accountId);
    const record = buildPlanUsageRecord(normalized, { accountKey, source, now: currentNow });
    cachedRecord = record;
    try {
      fileStore.writeImmediate(record);
    } catch (error) {
      logEvent('WARN', 'chatgpt_plan_usage.write_failed', {
        errorCode: error?.code || null,
        errorMessage: error?.message || String(error),
      });
    }
    emitChanged(record);
  }

  // clear() -- deletes the persisted record and emits `changed` with null.
  // Used on sign-out (via attachAuthService) and available directly for tests
  // / callers that need an explicit reset.
  function clear() {
    cachedRecord = null;
    try {
      fileStore.delete();
    } catch (error) {
      logEvent('WARN', 'chatgpt_plan_usage.clear_failed', {
        errorCode: error?.code || null,
        errorMessage: error?.message || String(error),
      });
    }
    emitChanged(null);
  }

  // attachAuthService(auth) -- subscribes to auth.onStatusChange(cb); any
  // state other than 'signed_in' clears the record. Replaces a previous
  // subscription if called again (idempotent re-attach, e.g. after the auth
  // service is recomposed). Returns the unsubscribe function.
  function attachAuthService(auth) {
    if (typeof authUnsubscribe === 'function') {
      try {
        authUnsubscribe();
      } catch (_error) {
        // Ignore: the old subscription is being replaced regardless.
      }
      authUnsubscribe = null;
    }
    if (!auth || typeof auth.onStatusChange !== 'function') {
      return () => {};
    }
    authUnsubscribe = auth.onStatusChange((status) => {
      if (status?.state !== 'signed_in') {
        clear();
      }
    });
    return authUnsubscribe;
  }

  // onChange(listener) -> unsubscribe. Fires on every ingest() and clear()
  // with the new record (or null).
  function onChange(listener) {
    if (typeof listener !== 'function') {
      return () => {};
    }
    changeListeners.add(listener);
    return () => changeListeners.delete(listener);
  }

  function dispose() {
    if (disposed) {
      return;
    }
    disposed = true;
    if (typeof authUnsubscribe === 'function') {
      try {
        authUnsubscribe();
      } catch (_error) {
        // Best-effort teardown.
      }
      authUnsubscribe = null;
    }
    changeListeners.clear();
  }

  return {
    getSnapshot,
    ingest,
    clear,
    attachAuthService,
    onChange,
    dispose,
  };
}

module.exports = {
  createChatGptPlanUsageStore,
  hashAccountId,
};
