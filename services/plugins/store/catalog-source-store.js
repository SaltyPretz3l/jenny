'use strict';

const { joinPath } = require('./fs-facade');
const { readJsonFile, writeJsonFileAtomic } = require('./json-file-io');
const { validateCatalogSource } = require('../catalog/catalog-contracts');

const CATALOG_SOURCE_SCHEMA_VERSION = 1;
const DIR = 'distribution';
const FILE = 'catalog-sources.json';
const MAX_SOURCES = 64;

function emptyDocument() {
  return { plugin_catalog_sources_schema_version: CATALOG_SOURCE_SCHEMA_VERSION, revision: 0, sources: [] };
}

function validateDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'catalog_sources_invalid' };
  if (value.plugin_catalog_sources_schema_version > CATALOG_SOURCE_SCHEMA_VERSION) {
    return { ok: false, reason: 'future_schema', read_only: true };
  }
  if (value.plugin_catalog_sources_schema_version !== CATALOG_SOURCE_SCHEMA_VERSION
    || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !Array.isArray(value.sources) || value.sources.length > MAX_SOURCES
    || Object.keys(value).some((key) => !['plugin_catalog_sources_schema_version', 'revision', 'sources'].includes(key))) {
    return { ok: false, reason: 'catalog_sources_invalid' };
  }
  const checked = value.sources.map(validateCatalogSource);
  if (checked.some((item) => !item.ok)
    || new Set(checked.map((item) => item.value.source_id)).size !== checked.length) {
    return { ok: false, reason: 'catalog_sources_invalid' };
  }
  return { ok: true, value: { ...value, sources: checked.map((item) => item.value) } };
}

async function readCatalogSources(facade, baseDir) {
  const read = await readJsonFile(facade, joinPath(baseDir, DIR, FILE));
  if (read.status === 'missing') return { ok: true, document: emptyDocument(), missing: true };
  if (read.status !== 'ok') return { ok: false, reason: 'catalog_sources_corrupted', read_only: true };
  const checked = validateDocument(read.value);
  return checked.ok
    ? { ok: true, document: checked.value, missing: false }
    : checked;
}

async function putCatalogSource(facade, baseDir, source, { expectedRevision = null } = {}) {
  const checked = validateCatalogSource(source);
  if (!checked.ok) return checked;
  const current = await readCatalogSources(facade, baseDir);
  if (!current.ok) return current;
  if (expectedRevision !== null && current.document.revision !== expectedRevision) {
    return { ok: false, reason: 'catalog_sources_revision_conflict' };
  }
  const sources = current.document.sources.filter((row) => row.source_id !== source.source_id);
  sources.push(checked.value);
  sources.sort((left, right) => left.source_id.localeCompare(right.source_id));
  if (sources.length > MAX_SOURCES) return { ok: false, reason: 'catalog_sources_capacity_exceeded' };
  const document = { ...current.document, revision: current.document.revision + 1, sources };
  await writeJsonFileAtomic(facade, joinPath(baseDir, DIR), FILE, document);
  const verified = await readCatalogSources(facade, baseDir);
  if (!verified.ok || verified.document.revision !== document.revision) {
    return { ok: false, reason: 'catalog_sources_post_write_verification_failed' };
  }
  return { ok: true, revision: document.revision };
}

module.exports = {
  DIR, FILE, putCatalogSource,
  readCatalogSources, validateDocument,
};
