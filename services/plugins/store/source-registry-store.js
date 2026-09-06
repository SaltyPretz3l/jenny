'use strict';

const path = require('node:path');
const { joinPath } = require('./fs-facade');
const { readJsonFile, writeJsonFileAtomic } = require('./json-file-io');
const DIR = 'distribution';
const FILE = 'sources.json';
const MAX_SOURCES = 64;
const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const registryMutations = new Map();

function emptyRegistry() { return { source_registry_schema_version: 1, revision: 0, sources: [] }; }
function validLocator(value) {
  if (typeof value !== 'string' || value.length > 4096) return false;
  try {
    const url = new URL(value); const loopback = ['127.0.0.1', '[::1]', '::1'].includes(url.hostname.toLowerCase());
    return !url.username && !url.password && !url.search && !url.hash
      && (url.protocol === 'https:' || (url.protocol === 'http:' && loopback));
  } catch (_error) { return false; }
}
function validSource(row) {
  if (!row || !ID_RE.test(row.source_id || '') || !['https_url', 'git', 'offline_mirror'].includes(row.kind)) return false;
  if (!Number.isFinite(Date.parse(row.updated_at))) return false;
  return row.kind === 'offline_mirror'
    ? Object.keys(row).length === 4 && typeof row.real_root === 'string' && row.real_root.length <= 4096 && path.isAbsolute(row.real_root)
    : Object.keys(row).length === 4 && validLocator(row.locator);
}
function validateRegistry(value) {
  return value && value.source_registry_schema_version === 1 && Number.isSafeInteger(value.revision)
    && value.revision >= 0 && Array.isArray(value.sources) && value.sources.length <= MAX_SOURCES
    && value.sources.every(validSource) && new Set(value.sources.map((row) => row.source_id)).size === value.sources.length;
}
async function readSourceRegistry(facade, baseDir) {
  const read = await readJsonFile(facade, joinPath(baseDir, DIR, FILE));
  if (read.status === 'missing') return { ok: true, registry: emptyRegistry(), missing: true };
  if (read.status !== 'ok' || !validateRegistry(read.value)) return { ok: false, reason: 'source_registry_invalid' };
  return { ok: true, registry: read.value, missing: false };
}
async function putSource(facade, baseDir, row, { expectedRevision = null } = {}) {
  if (!validSource(row)) return { ok: false, reason: 'source_record_invalid' };
  return withRegistryMutation(facade, baseDir, async () => {
    const current = await readSourceRegistry(facade, baseDir);
    if (!current.ok) return current;
    if (expectedRevision !== null && current.registry.revision !== expectedRevision) return { ok: false, reason: 'source_registry_revision_conflict' };
    const sources = current.registry.sources.filter((item) => item.source_id !== row.source_id);
    sources.push({ ...row }); sources.sort((a, b) => a.source_id.localeCompare(b.source_id));
    if (sources.length > MAX_SOURCES) return { ok: false, reason: 'source_registry_capacity_exceeded' };
    const registry = { source_registry_schema_version: 1, revision: current.registry.revision + 1, sources };
    await writeJsonFileAtomic(facade, joinPath(baseDir, DIR), FILE, registry);
    return { ok: true, source_id: row.source_id, revision: registry.revision };
  });
}
function withRegistryMutation(facade, baseDir, operation) {
  let facadeMutations = registryMutations.get(facade);
  if (!facadeMutations) {
    facadeMutations = new Map();
    registryMutations.set(facade, facadeMutations);
  }
  const prior = facadeMutations.get(baseDir) || Promise.resolve();
  const current = prior.catch(() => {}).then(operation);
  facadeMutations.set(baseDir, current);
  return current.finally(() => {
    if (facadeMutations.get(baseDir) === current) facadeMutations.delete(baseDir);
    if (facadeMutations.size === 0) registryMutations.delete(facade);
  });
}
async function getSource(facade, baseDir, sourceId) {
  if (!ID_RE.test(sourceId || '')) return { ok: false, reason: 'source_id_invalid' };
  const current = await readSourceRegistry(facade, baseDir); if (!current.ok) return current;
  const source = current.registry.sources.find((row) => row.source_id === sourceId);
  return source ? { ok: true, source: { ...source } } : { ok: false, reason: 'source_not_found' };
}
module.exports = { DIR, FILE, MAX_SOURCES, emptyRegistry, validLocator, validSource, validateRegistry, readSourceRegistry, putSource, getSource };
