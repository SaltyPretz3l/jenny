'use strict';

const crypto = require('node:crypto');
const { stableStringify } = require('../package/canonical-metadata');
const { isValidDigest, sha256Hex } = require('./content-store');
const { joinPath } = require('./fs-facade');
const { readJsonFile, writeJsonFileAtomic, writeTextFileAtomic } = require('./json-file-io');

const CACHE_DIR = 'distribution/cache';
const BLOBS_DIR = 'distribution/cache/blobs';
const PARTIALS_DIR = 'distribution/cache/partials';
const INDEX_FILE = 'index.json';
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_PARTIAL_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 10000;

function boundedMaxBytes(value) {
  return Number.isSafeInteger(value) && value > 0
    ? Math.min(value, DEFAULT_MAX_BYTES) : DEFAULT_MAX_BYTES;
}

function asBuffer(value) {
  if (!(typeof value === 'string' || Buffer.isBuffer(value) || value instanceof Uint8Array)) return null;
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function digestIndex(entries) {
  return crypto.createHash('sha256').update(stableStringify(entries), 'utf8').digest('hex');
}

function emptyIndex() {
  const entries = [];
  return { cache_index_schema_version: 1, entries, index_digest: digestIndex(entries) };
}

function cacheBlobPath(baseDir, digest) {
  return joinPath(baseDir, BLOBS_DIR, `${digest}.blob`);
}

function partialPath(baseDir, operationId) {
  return joinPath(baseDir, PARTIALS_DIR, `${operationId}.partial`);
}

function validEntry(entry) {
  return entry && typeof entry === 'object' && !Array.isArray(entry)
    && isValidDigest(entry.digest) && isValidDigest(entry.source_identity_digest)
    && Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= DEFAULT_MAX_BYTES
    && Number.isFinite(Date.parse(entry.verified_at))
    && Number.isFinite(Date.parse(entry.last_accessed_at))
    && typeof entry.leased === 'boolean' && typeof entry.evidentiary === 'boolean';
}

function validateIndex(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.cache_index_schema_version !== 1 || !Array.isArray(value.entries)
    || value.entries.length > MAX_ENTRIES || !isValidDigest(value.index_digest)) return false;
  if (!value.entries.every(validEntry)) return false;
  const digests = new Set(value.entries.map((entry) => entry.digest));
  const totalBytes = value.entries.reduce((sum, entry) => sum + entry.size, 0);
  return digests.size === value.entries.length && totalBytes <= DEFAULT_MAX_BYTES
    && value.index_digest === digestIndex(value.entries);
}

async function readCacheIndex(facade, baseDir) {
  const read = await readJsonFile(facade, joinPath(baseDir, CACHE_DIR, INDEX_FILE));
  if (read.status === 'missing') return { ok: true, index: emptyIndex(), missing: true };
  if (read.status === 'corrupted') return { ok: false, reason: 'cache_index_corrupted', detail: read.error };
  if (!validateIndex(read.value)) return { ok: false, reason: 'cache_index_invalid' };
  return { ok: true, index: read.value, missing: false };
}

function planEviction(entries, incomingSize, {
  maxBytes, protectedDigests = new Set(), incomingDigest,
}) {
  const retained = entries.filter((entry) => entry.digest !== incomingDigest);
  let total = retained.reduce((sum, entry) => sum + entry.size, 0) + incomingSize;
  const candidates = retained
    .filter((entry) => !entry.leased && !entry.evidentiary && !protectedDigests.has(entry.digest))
    .sort((a, b) => Date.parse(a.last_accessed_at) - Date.parse(b.last_accessed_at)
      || a.digest.localeCompare(b.digest));
  const evicted = [];
  for (const entry of candidates) {
    if (total <= maxBytes) break;
    total -= entry.size;
    evicted.push(entry.digest);
  }
  if (total > maxBytes) return { ok: false, reason: 'cache_capacity_unavailable' };
  return { ok: true, evicted, total };
}

async function putVerifiedCacheEntry(facade, baseDir, {
  bytes, sourceIdentityDigest, verifiedAt, lastAccessedAt = verifiedAt,
  leased = false, evidentiary = false,
}, { maxBytes = DEFAULT_MAX_BYTES, protectedDigests = new Set() } = {}) {
  const buffer = asBuffer(bytes);
  const effectiveMaxBytes = boundedMaxBytes(maxBytes);
  if (!buffer || buffer.length > effectiveMaxBytes || !isValidDigest(sourceIdentityDigest)
    || !Number.isFinite(Date.parse(verifiedAt)) || !Number.isFinite(Date.parse(lastAccessedAt))) {
    return { ok: false, reason: 'cache_entry_invalid' };
  }
  const digest = sha256Hex(buffer);
  const current = await readCacheIndex(facade, baseDir);
  if (!current.ok) return current;
  const plan = planEviction(current.index.entries, buffer.length, {
    maxBytes: effectiveMaxBytes, protectedDigests, incomingDigest: digest,
  });
  if (!plan.ok) return plan;
  const blobStat = await facade.stat(cacheBlobPath(baseDir, digest));
  if (!blobStat.exists) await writeTextFileAtomic(facade, joinPath(baseDir, BLOBS_DIR), `${digest}.blob`, buffer);
  const entry = {
    digest, source_identity_digest: sourceIdentityDigest, size: buffer.length,
    verified_at: verifiedAt, last_accessed_at: lastAccessedAt, leased, evidentiary,
  };
  const evicted = new Set(plan.evicted);
  const entries = current.index.entries.filter((item) => item.digest !== digest && !evicted.has(item.digest));
  entries.push(entry);
  entries.sort((a, b) => a.digest.localeCompare(b.digest));
  const index = { cache_index_schema_version: 1, entries, index_digest: digestIndex(entries) };
  await writeJsonFileAtomic(facade, joinPath(baseDir, CACHE_DIR), INDEX_FILE, index);
  for (const evictedDigest of plan.evicted) await facade.remove(cacheBlobPath(baseDir, evictedDigest));
  return { ok: true, digest, entry, evicted: plan.evicted, cache_bytes: plan.total };
}

async function putPartialCacheEntry(facade, baseDir, {
  operationId, bytes, createdAt, etag = null, sourceIdentityDigest = null,
}) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(operationId)
    || !Number.isFinite(Date.parse(createdAt))) return { ok: false, reason: 'cache_partial_invalid' };
  const buffer = asBuffer(bytes);
  if (!buffer) return { ok: false, reason: 'cache_partial_invalid' };
  if (buffer.length > DEFAULT_MAX_BYTES) return { ok: false, reason: 'cache_partial_too_large' };
  if ((etag !== null && (typeof etag !== 'string' || !/^"[\x21\x23-\x7e]+"$/.test(etag)))
    || (sourceIdentityDigest !== null && !isValidDigest(sourceIdentityDigest))) {
    return { ok: false, reason: 'cache_partial_invalid' };
  }
  const partialDigest = sha256Hex(buffer);
  await writeTextFileAtomic(facade, joinPath(baseDir, PARTIALS_DIR), `${operationId}.partial`, buffer);
  try {
    await writeJsonFileAtomic(facade, joinPath(baseDir, PARTIALS_DIR), `${operationId}.json`, {
      partial_schema_version: 1, operation_id: operationId, created_at: createdAt, size: buffer.length,
      partial_digest: partialDigest,
      ...(etag === null ? {} : { etag }),
      ...(sourceIdentityDigest === null ? {} : { source_identity_digest: sourceIdentityDigest }),
    });
  } catch (error) {
    try {
      await facade.remove(partialPath(baseDir, operationId));
    } catch (cleanupError) {
      void cleanupError;
    }
    throw error;
  }
  return { ok: true, size: buffer.length };
}

async function getPartialCacheEntry(facade, baseDir, operationId) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(operationId || '')) return { ok: false, reason: 'cache_partial_invalid' };
  const metadata = await readJsonFile(facade, joinPath(baseDir, PARTIALS_DIR, `${operationId}.json`));
  if (metadata.status === 'missing') return { ok: true, partial: null };
  if (metadata.status !== 'ok') return { ok: false, reason: 'cache_partial_corrupted' };
  const value = metadata.value;
  if (value?.partial_schema_version !== 1 || value.operation_id !== operationId
    || !Number.isSafeInteger(value.size) || value.size < 0 || !isValidDigest(value.partial_digest)
    || (value.etag !== undefined && !/^"[\x21\x23-\x7e]+"$/.test(value.etag))
    || (value.source_identity_digest !== undefined && !isValidDigest(value.source_identity_digest))) {
    return { ok: false, reason: 'cache_partial_invalid' };
  }
  try {
    const bytes = await facade.readFile(partialPath(baseDir, operationId), null);
    if (bytes.length !== value.size || sha256Hex(bytes) !== value.partial_digest) return { ok: false, reason: 'cache_partial_digest_mismatch' };
    return { ok: true, partial: { ...value, bytes } };
  } catch (_error) { return { ok: false, reason: 'cache_partial_unreadable' }; }
}

async function discardPartialCacheEntry(facade, baseDir, operationId) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(operationId || '')) return { ok: false, reason: 'cache_partial_invalid' };
  await facade.remove(partialPath(baseDir, operationId));
  await facade.remove(joinPath(baseDir, PARTIALS_DIR, `${operationId}.json`));
  return { ok: true };
}

async function pruneExpiredPartials(facade, baseDir, now, { ttlMs = DEFAULT_PARTIAL_TTL_MS } = {}) {
  const effectiveTtlMs = Number.isSafeInteger(ttlMs) && ttlMs > 0
    ? Math.min(ttlMs, DEFAULT_PARTIAL_TTL_MS) : DEFAULT_PARTIAL_TTL_MS;
  const nowMs = Date.parse(now);
  const names = await facade.list(joinPath(baseDir, PARTIALS_DIR));
  const removed = [];
  for (const name of names.filter((item) => item.endsWith('.json'))) {
    const read = await readJsonFile(facade, joinPath(baseDir, PARTIALS_DIR, name));
    const operationId = name.slice(0, -5);
    const createdAtMs = Date.parse(read.value?.created_at);
    if (read.status !== 'ok' || !Number.isFinite(createdAtMs)
      || nowMs - createdAtMs > effectiveTtlMs) {
      await facade.remove(joinPath(baseDir, PARTIALS_DIR, name));
      await facade.remove(partialPath(baseDir, operationId));
      removed.push(operationId);
    }
  }
  return { ok: true, removed };
}

module.exports = {
  INDEX_FILE,
  DEFAULT_MAX_BYTES,
  boundedMaxBytes,
  asBuffer,
  emptyIndex,
  partialPath,
  readCacheIndex,
  validateIndex,
  putVerifiedCacheEntry,
  putPartialCacheEntry,
  getPartialCacheEntry,
  discardPartialCacheEntry,
  pruneExpiredPartials,
};
