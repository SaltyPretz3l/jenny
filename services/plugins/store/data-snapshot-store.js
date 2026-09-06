'use strict';

const crypto = require('node:crypto');
const { stableStringify } = require('../package/canonical-metadata');
const { isValidDigest, sha256Hex } = require('./content-store');
const { joinPath } = require('./fs-facade');
const { readJsonFile, writeJsonFileAtomic, writeTextFileAtomic } = require('./json-file-io');

const SNAPSHOTS_DIR = 'data-snapshots';
const INDEX_FILE = 'index.json';
const MAX_SNAPSHOTS_PER_PLUGIN = 2;
const MAX_BYTES_PER_PLUGIN = 256 * 1024 * 1024;
const MAX_BYTES_GLOBAL = 2 * 1024 * 1024 * 1024;
const MAX_INDEX_ENTRIES = 128;
const PUBLISHER_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const PLUGIN_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

function indexDigest(entries) {
  return crypto.createHash('sha256').update(stableStringify(entries), 'utf8').digest('hex');
}

function emptyIndex() {
  const entries = [];
  return { data_snapshot_index_schema_version: 1, entries, index_digest: indexDigest(entries) };
}

function snapshotPath(baseDir, publisherId, pluginId, digest) {
  return joinPath(baseDir, SNAPSHOTS_DIR, publisherId, pluginId, `${digest}.blob`);
}

function authorityKey(entry) {
  return `${entry.publisher_id}/${entry.plugin_id}`;
}

function snapshotKey(entry) {
  return `${authorityKey(entry)}/${entry.digest}`;
}

function validEntry(entry) {
  return entry && PUBLISHER_PATTERN.test(entry.publisher_id) && PLUGIN_PATTERN.test(entry.plugin_id)
    && isValidDigest(entry.digest) && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry.generation_id)
    && Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= MAX_BYTES_PER_PLUGIN
    && Number.isFinite(Date.parse(entry.created_at))
    && typeof entry.leased === 'boolean' && typeof entry.evidentiary === 'boolean';
}

function validateIndex(value) {
  if (!value || value.data_snapshot_index_schema_version !== 1 || !Array.isArray(value.entries)
    || value.entries.length > MAX_INDEX_ENTRIES || !isValidDigest(value.index_digest)
    || !value.entries.every(validEntry)) return false;
  const keys = new Set(value.entries.map(snapshotKey));
  const pluginTotals = new Map();
  let globalBytes = 0;
  for (const entry of value.entries) {
    const authority = authorityKey(entry);
    const totals = pluginTotals.get(authority) || { count: 0, bytes: 0 };
    totals.count += 1;
    totals.bytes += entry.size;
    pluginTotals.set(authority, totals);
    globalBytes += entry.size;
  }
  return keys.size === value.entries.length
    && [...pluginTotals.values()].every((totals) => totals.count <= MAX_SNAPSHOTS_PER_PLUGIN
      && totals.bytes <= MAX_BYTES_PER_PLUGIN)
    && globalBytes <= MAX_BYTES_GLOBAL
    && value.index_digest === indexDigest(value.entries);
}

function boundedLimits(limits) {
  const limit = (value, hardMaximum) => Number.isSafeInteger(value) && value > 0
    ? Math.min(value, hardMaximum) : hardMaximum;
  return {
    maxPerPlugin: limit(limits.maxPerPlugin, MAX_SNAPSHOTS_PER_PLUGIN),
    maxBytesPerPlugin: limit(limits.maxBytesPerPlugin, MAX_BYTES_PER_PLUGIN),
    maxBytesGlobal: limit(limits.maxBytesGlobal, MAX_BYTES_GLOBAL),
  };
}

function asBuffer(value) {
  if (!(typeof value === 'string' || Buffer.isBuffer(value) || value instanceof Uint8Array)) return null;
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

async function readDataSnapshotIndex(facade, baseDir) {
  const read = await readJsonFile(facade, joinPath(baseDir, SNAPSHOTS_DIR, INDEX_FILE));
  if (read.status === 'missing') return { ok: true, index: emptyIndex(), missing: true };
  if (read.status === 'corrupted') {
    return { ok: false, reason: 'data_snapshot_index_corrupted', detail: read.error };
  }
  if (!validateIndex(read.value)) return { ok: false, reason: 'data_snapshot_index_invalid' };
  return { ok: true, index: read.value, missing: false };
}

function selectEvictions(entries, incoming, limits, protectedDigests = new Set()) {
  const incomingAuthority = authorityKey(incoming);
  const sameArtifact = (entry) => entry.publisher_id === incoming.publisher_id
    && entry.plugin_id === incoming.plugin_id && entry.digest === incoming.digest;
  const retained = entries.filter((entry) => !sameArtifact(entry));
  const candidates = retained.filter((entry) => !entry.leased && !entry.evidentiary
      && !protectedDigests.has(entry.digest))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)
      || authorityKey(a).localeCompare(authorityKey(b)) || a.digest.localeCompare(b.digest));
  const evicted = new Set();
  let pluginCount = 1;
  let pluginBytes = incoming.size;
  let globalBytes = incoming.size;
  for (const entry of retained) {
    globalBytes += entry.size;
    if (authorityKey(entry) === incomingAuthority) {
      pluginCount += 1;
      pluginBytes += entry.size;
    }
  }
  for (const candidate of candidates) {
    if (pluginCount <= limits.maxPerPlugin && pluginBytes <= limits.maxBytesPerPlugin
      && globalBytes <= limits.maxBytesGlobal) return { ok: true, evicted: [...evicted] };
    const candidateAuthority = authorityKey(candidate);
    if (globalBytes <= limits.maxBytesGlobal && candidateAuthority !== incomingAuthority) continue;
    evicted.add(snapshotKey(candidate));
    globalBytes -= candidate.size;
    if (candidateAuthority === incomingAuthority) {
      pluginCount -= 1;
      pluginBytes -= candidate.size;
    }
  }
  if (pluginCount <= limits.maxPerPlugin && pluginBytes <= limits.maxBytesPerPlugin
    && globalBytes <= limits.maxBytesGlobal) return { ok: true, evicted: [...evicted] };
  return { ok: false, reason: 'data_snapshot_capacity_unavailable' };
}

async function putDataSnapshot(facade, baseDir, {
  publisherId, pluginId, generationId, bytes, createdAt, leased = false, evidentiary = true,
}, limits = {}) {
  const buffer = asBuffer(bytes);
  const effectiveLimits = boundedLimits(limits);
  if (!buffer || !PUBLISHER_PATTERN.test(publisherId) || !PLUGIN_PATTERN.test(pluginId)
    || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(generationId)
    || !Number.isFinite(Date.parse(createdAt)) || buffer.length > effectiveLimits.maxBytesPerPlugin) {
    return { ok: false, reason: 'data_snapshot_invalid' };
  }
  const digest = sha256Hex(buffer);
  const incoming = {
    publisher_id: publisherId, plugin_id: pluginId, generation_id: generationId,
    digest, size: buffer.length, created_at: createdAt, leased, evidentiary,
  };
  const current = await readDataSnapshotIndex(facade, baseDir);
  if (!current.ok) return current;
  const selected = selectEvictions(current.index.entries, incoming, effectiveLimits,
    limits.protectedDigests instanceof Set ? limits.protectedDigests : new Set());
  if (!selected.ok) return selected;
  const filePath = snapshotPath(baseDir, publisherId, pluginId, digest);
  if (!(await facade.stat(filePath)).exists) {
    await writeTextFileAtomic(
      facade,
      joinPath(baseDir, SNAPSHOTS_DIR, publisherId, pluginId),
      `${digest}.blob`,
      buffer
    );
  }
  const evicted = new Set(selected.evicted);
  const incomingKey = snapshotKey(incoming);
  const entries = current.index.entries.filter((entry) => {
    const key = snapshotKey(entry);
    return key !== incomingKey && !evicted.has(key);
  });
  entries.push(incoming);
  entries.sort((a, b) => authorityKey(a).localeCompare(authorityKey(b)) || a.digest.localeCompare(b.digest));
  const index = { data_snapshot_index_schema_version: 1, entries, index_digest: indexDigest(entries) };
  await writeJsonFileAtomic(facade, joinPath(baseDir, SNAPSHOTS_DIR), INDEX_FILE, index);
  for (const key of selected.evicted) {
    const [publisher, plugin, oldDigest] = key.split('/');
    await facade.remove(snapshotPath(baseDir, publisher, plugin, oldDigest));
  }
  return { ok: true, digest, entry: incoming, evicted: selected.evicted };
}

async function getDataSnapshot(facade, baseDir, { publisherId, pluginId, digest }) {
  if (!PUBLISHER_PATTERN.test(publisherId) || !PLUGIN_PATTERN.test(pluginId) || !isValidDigest(digest)) {
    return { ok: false, reason: 'data_snapshot_identity_invalid' };
  }
  const current = await readDataSnapshotIndex(facade, baseDir);
  if (!current.ok) return current;
  const entry = current.index.entries.find((item) => item.publisher_id === publisherId
    && item.plugin_id === pluginId && item.digest === digest);
  if (!entry) return { ok: false, reason: 'data_snapshot_not_found' };
  let bytes;
  try {
    bytes = await facade.readFile(snapshotPath(baseDir, publisherId, pluginId, digest), null);
  } catch (error) {
    return { ok: false, reason: error?.code === 'ENOENT' ? 'data_snapshot_blob_not_found' : 'data_snapshot_unreadable' };
  }
  if (sha256Hex(bytes) !== digest || bytes.length !== entry.size) {
    return { ok: false, reason: 'data_snapshot_digest_mismatch' };
  }
  return { ok: true, entry, bytes };
}

module.exports = {
  INDEX_FILE,
  MAX_SNAPSHOTS_PER_PLUGIN,
  MAX_BYTES_PER_PLUGIN,
  MAX_BYTES_GLOBAL,
  MAX_INDEX_ENTRIES,
  emptyIndex,
  validateIndex,
  readDataSnapshotIndex,
  boundedLimits,
  asBuffer,
  putDataSnapshot,
  getDataSnapshot,
};
