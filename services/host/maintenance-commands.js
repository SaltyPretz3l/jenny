'use strict';

const { HOST_ERROR_CODES } = require('../backend/error-codes');

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const { hostFailure } = require('../../server/api-contract');
const { extractArchive, readManifest } = require('../data-lifecycle/archive-service');
const { importSession, validateSessionImportPayload } = require('../backend/session-export-import');
const { readJson, writeJson } = require('./durable-json');

const RECEIPT_SCHEMA_VERSION = 1;
const RECEIPT_FILE = 'host-import.json';
const MAX_ARCHIVE_ENTRIES = 1000;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_SESSION_BYTES = 16 * 1024 * 1024;
const MAX_SESSION_IDS = 128;
const SESSION_ID_PATTERN = /^sess_[A-Za-z0-9_-]{1,123}$/u;
const STAGING_PREFIX = '.host-import-';
const STAGING_NAME_PATTERN = /^\.host-import-[A-Za-z0-9_-]{1,128}$/u;
const MAX_STAGING_CLEANUP_ENTRIES = 64;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

const ARCHIVE_REASONS = new Set([
  'archive_authentication_failed',
  'archive_checksum_failed',
  'archive_corrupt',
  'archive_entry_limit',
  'archive_size_limit',
  'invalid_passphrase',
  'unsupported_archive_version',
  'unsupported_kdf_profile',
]);

class MaintenanceFailure extends Error {
  constructor(kind, reason) {
    super(String(reason || 'maintenance_failed'));
    this.name = 'MaintenanceFailure';
    this.kind = kind;
    this.reason = reason;
  }
}

function fail(kind, reason) {
  throw new MaintenanceFailure(kind, reason);
}

function resultFromFailure(error, phase = 'import') {
  if (error instanceof MaintenanceFailure) return hostFailure(error.kind, error.reason);
  const reason = String(error?.reason || '');
  if (ARCHIVE_REASONS.has(reason)) {
    return hostFailure(reason === 'archive_entry_limit' || reason === 'archive_size_limit' ? 'limit' : 'invalid', reason);
  }
  if (phase === 'receipt' || phase === 'durability' || phase === 'import') {
    return hostFailure('persistence', phase === 'durability' ? 'import_durability_failed' : 'import_incomplete');
  }
  return hostFailure('invalid', 'archive_invalid');
}

function receiptPath(userDataPath) {
  return path.join(userDataPath, RECEIPT_FILE);
}

function validUserDataPath(value) {
  const text = String(value || '').trim();
  return text ? path.resolve(text) : '';
}

function isStrictSessionId(value) {
  return SESSION_ID_PATTERN.test(String(value || ''));
}

function manifestDigest(manifest) {
  return crypto.createHash('sha256').update(JSON.stringify(manifest), 'utf8').digest('hex');
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSkipped(value) {
  if (!isRecord(value) || !Number.isSafeInteger(value.count) || value.count < 0 || value.count > MAX_ARCHIVE_ENTRIES) return null;
  if (!Array.isArray(value.categories) || value.categories.length > 128) return null;
  const categories = [];
  const seen = new Set();
  for (const item of value.categories) {
    if (!isRecord(item) || !/^[a-z][a-z0-9_]{0,63}$/.test(String(item.name || ''))
      || !Number.isSafeInteger(item.count) || item.count < 1 || item.count > MAX_ARCHIVE_ENTRIES || seen.has(item.name)) return null;
    seen.add(item.name);
    categories.push({ name: item.name, count: item.count });
  }
  if (categories.reduce((sum, item) => sum + item.count, 0) !== value.count) return null;
  return { count: value.count, categories };
}

function normalizeReceipt(value) {
  if (!isRecord(value)) return null;
  if (value.schema_version !== RECEIPT_SCHEMA_VERSION) return null;
  if (!['pending', 'completed'].includes(value.state)
    || !/^[a-f0-9]{64}$/.test(String(value.source_manifest_digest || ''))
    || !Array.isArray(value.session_ids) || value.session_ids.length > MAX_SESSION_IDS
    || !Number.isSafeInteger(value.imported_count) || value.imported_count < 0
    || value.imported_count !== value.session_ids.length
    || !normalizeSkipped(value.skipped)
    || typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at))) return null;
  const ids = new Set();
  for (const id of value.session_ids) {
    if (!isStrictSessionId(id) || ids.has(id)) return null;
    ids.add(id);
  }
  if (value.state === 'completed'
    && (typeof value.completed_at !== 'string' || !Number.isFinite(Date.parse(value.completed_at)))) return null;
  if (value.state === 'pending' && Object.prototype.hasOwnProperty.call(value, 'completed_at')) return null;
  const allowed = new Set(['schema_version', 'state', 'source_manifest_digest', 'session_ids', 'imported_count', 'skipped', 'created_at', 'completed_at']);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  return {
    schema_version: RECEIPT_SCHEMA_VERSION,
    state: value.state,
    source_manifest_digest: value.source_manifest_digest,
    session_ids: [...value.session_ids],
    imported_count: value.imported_count,
    skipped: normalizeSkipped(value.skipped),
    created_at: value.created_at,
    ...(value.state === 'completed' ? { completed_at: value.completed_at } : {}),
  };
}

function readReceipt(userDataPath) {
  let value;
  try {
    value = readJson(receiptPath(userDataPath), { maxBytes: 64 * 1024 });
  } catch (_error) {
    fail('persistence', 'import_receipt_invalid');
  }
  if (value === null) return null;
  if (value.schema_version > RECEIPT_SCHEMA_VERSION) fail('invalid', 'import_receipt_future');
  const normalized = normalizeReceipt(value);
  if (!normalized) fail('invalid', 'import_receipt_invalid');
  return normalized;
}

function createSkippedSummary(manifest, selected) {
  const selectedEntries = new Set(selected.map((item) => item.entry));
  const counts = new Map();
  for (const entry of manifest.entries) {
    if (selectedEntries.has(entry)) continue;
    counts.set(entry.category, (counts.get(entry.category) || 0) + 1);
  }
  if (counts.size > 128) fail('limit', 'archive_category_limit');
  const categories = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => ({ name, count }));
  return { count: manifest.entries.length - selected.length, categories };
}

function inspectManifest(manifest) {
  if (!isRecord(manifest) || !Array.isArray(manifest.entries)) fail('invalid', 'archive_invalid');
  if (manifest.entries.length > MAX_ARCHIVE_ENTRIES || Number(manifest.total_bytes) > MAX_ARCHIVE_BYTES) {
    fail('limit', 'archive_limit');
  }
  const selected = [];
  const ids = new Set();
  for (const entry of manifest.entries) {
    if (!String(entry?.logical_path || '').startsWith('sessions/')) continue;
    const sessionId = String(entry?.restore_metadata?.session_id || '');
    if (!isStrictSessionId(sessionId) || entry.category !== 'chats'
      || entry.logical_path !== `sessions/${sessionId}.json`) fail('invalid', 'session_identity_invalid');
    if (ids.has(sessionId)) fail('invalid', 'session_identity_duplicate');
    if (!Number.isSafeInteger(entry.size) || entry.size > MAX_SESSION_BYTES) fail('limit', 'session_size_limit');
    ids.add(sessionId);
    selected.push({ entry, sessionId });
  }
  if (selected.length > MAX_SESSION_IDS) fail('limit', 'session_count_limit');
  return { selected, skipped: createSkippedSummary(manifest, selected) };
}

function canonicalSessionIds(backend) {
  const store = backend?.sessionStore;
  if (!store || typeof store.getSessionIds !== 'function') fail('unavailable', 'backend_unavailable');
  if (store.hasNewerSchema?.() || backend.shadowStore?.hasNewerSchema?.()) fail('invalid', 'canonical_schema_future');
  let ids;
  try {
    ids = store.getSessionIds();
  } catch (_error) {
    fail('persistence', 'canonical_store_unavailable');
  }
  if (!Array.isArray(ids)) fail('persistence', 'canonical_store_unavailable');
  if (backend.shadowStore) {
    let shadow;
    try {
      shadow = backend.shadowStore.summarize?.();
    } catch (_error) {
      fail('persistence', 'canonical_store_unavailable');
    }
    if (!isRecord(shadow)) fail('persistence', 'canonical_store_unavailable');
    if (Object.keys(shadow).length > 0) fail('conflict', 'profile_not_empty');
  }
  return ids;
}

function makePendingReceipt(digest, sessionIds, skipped) {
  return {
    schema_version: RECEIPT_SCHEMA_VERSION,
    state: 'pending',
    source_manifest_digest: digest,
    session_ids: [...sessionIds],
    imported_count: sessionIds.length,
    skipped,
    created_at: new Date().toISOString(),
  };
}

function makeCompletedReceipt(pending) {
  return {
    ...pending,
    state: 'completed',
    completed_at: new Date().toISOString(),
  };
}

function completedResult(receipt) {
  return {
    ok: true,
    state: 'completed',
    imported_count: receipt.imported_count,
    skipped: receipt.skipped,
  };
}

function throwGuardFailure(error) {
  const failure = resultFromFailure(error, 'receipt');
  const thrown = Object.assign(new Error(failure.error.reason), failure.error, { result: failure });
  thrown.error = failure.error;
  throw thrown;
}

function stageFilePath(stagePath, logicalPath) {
  const target = path.resolve(stagePath, ...String(logicalPath).split('/'));
  const relative = path.relative(stagePath, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) fail('invalid', 'archive_staging_failed');
  return target;
}

function readStagedSession(stagePath, entry) {
  const sourcePath = stageFilePath(stagePath, entry.logical_path);
  let fd;
  try {
    fd = fs.openSync(sourcePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size !== entry.size || before.size > MAX_SESSION_BYTES) {
      fail('invalid', 'archive_staging_failed');
    }
    const payload = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (!after.isFile() || after.nlink !== 1 || after.size !== before.size || payload.length !== entry.size) {
      fail('invalid', 'archive_staging_failed');
    }
    try {
      return UTF8_DECODER.decode(payload);
    } catch (_error) {
      fail('invalid', 'session_payload_invalid');
    }
  } catch (error) {
    if (error instanceof MaintenanceFailure) throw error;
    fail('invalid', 'archive_staging_failed');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function hasExportedAttachment(payload) {
  try {
    const parsed = JSON.parse(payload);
    return (Array.isArray(parsed?.session?.messages) ? parsed.session.messages : [])
      .some((message) => (Array.isArray(message?.attachments) ? message.attachments : [])
        .some((attachment) => typeof attachment?._exportedData === 'string' && attachment._exportedData.length > 0));
  } catch (_error) {
    return false;
  }
}

async function flushAndVerify(backend, sessionIds) {
  const stores = [backend?.sessionStore, backend?.shadowStore].filter(Boolean);
  if (!stores.length) fail('unavailable', 'backend_unavailable');
  for (const store of stores) {
    if (typeof store.flushAsync === 'function') await store.flushAsync();
    else if (typeof store.flush === 'function') store.flush();
    else fail('persistence', 'canonical_store_unavailable');
    if (typeof store.hasPendingWrites === 'function' && store.hasPendingWrites()) {
      fail('persistence', 'import_durability_failed');
    }
  }
  for (const sessionId of sessionIds) {
    if (!backend.sessionStore.getSession?.(sessionId)) fail('persistence', 'import_durability_failed');
    if (backend.shadowStore && !backend.shadowStore.getSession?.(sessionId)) fail('persistence', 'import_durability_failed');
  }
}

async function createStage(userDataPath) {
  await fs.promises.mkdir(userDataPath, { recursive: true, mode: 0o700 });
  return fs.promises.mkdtemp(path.join(userDataPath, STAGING_PREFIX));
}

function logCleanupFailure(backend, phase, reason) {
  try {
    backend?._emitServiceLog?.('WARN', 'host.import_staging_cleanup_failed', { phase, reason });
  } catch (_error) {
    // Diagnostics are non-authoritative and must not change import settlement.
  }
}

function validatedStagePath(userDataPath, stagePath) {
  if (!stagePath) return '';
  const root = path.resolve(userDataPath);
  const candidate = path.resolve(stagePath);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
    || !STAGING_NAME_PATTERN.test(path.basename(candidate))) return '';
  return candidate;
}

async function cleanupStage(userDataPath, stagePath, backend, phase) {
  const candidate = validatedStagePath(userDataPath, stagePath);
  if (!candidate) return false;
  try {
    const stat = await fs.promises.lstat(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      logCleanupFailure(backend, phase, 'invalid_stage');
      return false;
    }
    await fs.promises.rm(candidate, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    logCleanupFailure(backend, phase, 'remove_failed');
    return false;
  }
}

async function retryStaleStageCleanup(userDataPath, backend) {
  let entries;
  try {
    entries = await fs.promises.readdir(userDataPath, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') logCleanupFailure(backend, 'retry', 'scan_failed');
    return;
  }
  const candidates = entries
    .filter((entry) => STAGING_NAME_PATTERN.test(entry.name))
    .slice(0, MAX_STAGING_CLEANUP_ENTRIES);
  for (const entry of candidates) {
    await cleanupStage(userDataPath, path.join(userDataPath, entry.name), backend, 'retry');
  }
}

/**
 * Import conversation entries from a v1 Jenny archive into a fresh, stopped
 * hosted profile. The caller owns profile locking and lifecycle quiescence;
 * this function never starts a sidecar or an external engine.
 */
async function importConversations({ backend, userDataPath, archivePath, passphrase = '', statfs = fs.statfsSync } = {}) {
  const userRoot = validUserDataPath(userDataPath);
  if (!userRoot || !String(archivePath || '').trim() || !backend) return hostFailure('invalid', 'invalid_request');
  let stagePath = '';
  try {
    await retryStaleStageCleanup(userRoot, backend);
    const receipt = readReceipt(userRoot);
    if (receipt?.state === 'pending') return hostFailure('conflict', 'import_pending');

    let state;
    try {
      state = await readManifest(archivePath, { passphrase });
    } catch (error) {
      return resultFromFailure(error, 'archive');
    }
    const digest = manifestDigest(state.manifest);
    if (receipt?.state === 'completed') {
      return receipt.source_manifest_digest === digest
        ? completedResult(receipt)
        : hostFailure('conflict', 'import_source_changed');
    }

    const existingIds = canonicalSessionIds(backend);
    if (existingIds.length > 0) return hostFailure('conflict', 'profile_not_empty');
    const inspected = inspectManifest(state.manifest);
    const requireSpace = () => {
      const stats = statfs(userRoot);
      const requiredBytes = 256 * 1024 * 1024 + state.manifest.total_bytes * 6;
      if (Number(stats.bavail) * Number(stats.bsize) < requiredBytes) fail('limit', 'import_disk_reserve');
    };
    requireSpace();
    stagePath = await createStage(userRoot);
    let extracted;
    try {
      extracted = await extractArchive(archivePath, stagePath, { passphrase });
    } catch (error) {
      return resultFromFailure(error, 'archive');
    }
    if (manifestDigest(extracted.manifest) !== digest) return hostFailure('conflict', 'import_source_changed');

    const payloads = inspected.selected.map(({ entry }) => ({
      entry,
      payload: readStagedSession(stagePath, entry),
    }));
    try { for (const { payload } of payloads) validateSessionImportPayload(payload); }
    catch { return hostFailure('invalid', 'session_payload_invalid'); }
    requireSpace();
    if (payloads.some(({ payload }) => hasExportedAttachment(payload) && !backend.attachmentAssetStore)) {
      return hostFailure('unavailable', 'attachment_store_unavailable');
    }
    const pending = makePendingReceipt(digest, inspected.selected.map(({ sessionId }) => sessionId), inspected.skipped);
    try {
      writeJson(receiptPath(userRoot), pending);
    } catch (_error) {
      return hostFailure('persistence', 'import_receipt_write_failed');
    }

    try {
      for (const { entry, sessionId, payload } of inspected.selected.map((item, index) => ({
        ...item,
        payload: payloads[index].payload,
      }))) {
        importSession(backend.sessionStore, payload, backend.attachmentAssetStore, {
          shadowStore: backend.shadowStore,
          trustedArchive: true,
          restoredSessionId: sessionId,
        });
        if (entry.size > MAX_SESSION_BYTES) fail('limit', 'session_size_limit');
      }
      await flushAndVerify(backend, pending.session_ids);
      writeJson(receiptPath(userRoot), makeCompletedReceipt(pending));
    } catch (_error) {
      return hostFailure('persistence', 'import_incomplete');
    }
    return completedResult(makeCompletedReceipt(pending));
  } catch (error) {
    return resultFromFailure(error);
  } finally {
    await cleanupStage(userRoot, stagePath, backend, 'current');
  }
}

/**
 * Startup guard for hosted profiles. Missing and completed receipts are safe;
 * malformed, future, and pending receipts are rejected before service start.
 */
function assertImportComplete(userDataPath) {
  const userRoot = validUserDataPath(userDataPath);
  if (!userRoot) throw Object.assign(new Error('invalid_request'), { code: HOST_ERROR_CODES.INVALID, reason: 'invalid_request' });
  try {
    const receipt = readReceipt(userRoot);
    if (!receipt) return { ok: true, state: 'missing' };
    if (receipt.state === 'pending') fail('conflict', 'import_pending');
    return { ok: true, state: 'completed', imported_count: receipt.imported_count };
  } catch (error) {
    throwGuardFailure(error);
  }
}

module.exports = { assertImportComplete, importConversations };
