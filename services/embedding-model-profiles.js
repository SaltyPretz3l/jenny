'use strict';

// Bring-your-own embedding models for the semantic catalog: which GGUF counts
// as an embedding model, and which prompt profile (query/document templates
// plus allowed Matryoshka dimensions) it gets. Profiles ship in
// config/embedding-prompt-profiles.json; a missing or corrupt file degrades to
// the built-in `none` profile rather than refusing the catalog.

const fs = require('node:fs');
const path = require('node:path');

const { GgufHeaderError, readGgufHeader } = require('./gguf-header');
const { isLocalAbsolutePath } = require('./shell-config-engines');

const DEFAULT_PROFILES_PATH = path.join(__dirname, '..', 'config', 'embedding-prompt-profiles.json');
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_TEMPLATE_LENGTH = 512;
const MAX_DIMS = 4096;
const MAX_LABEL_LENGTH = 64;
const MAX_MATCH_ENTRIES = 16;
const MAX_NAME_PATTERN_LENGTH = 128;
const MAX_NAME_LENGTH = 128;
const MAX_MODEL_PATH_LENGTH = 1024;
// Embedding vocabularies are large (EmbeddingGemma's tokenizer alone is about
// 6 MiB of header), and the reader cannot return a partial header, so the
// bound covers the whole metadata section of the known families.
const HEADER_MAX_BYTES = 16 * 1024 * 1024;
const HEADER_MAX_KV = 4096;
const HEADER_MAX_STRING = 65536;
// Architectures llama.cpp only ever builds as embedding models, for files
// that predate the `<arch>.pooling_type` key.
const EMBEDDING_ARCHITECTURES = new Set([
  'bert',
  'nomic-bert',
  'nomic-bert-moe',
  'jina-bert-v2',
  'gemma-embedding',
]);

const BUILTIN_NONE_PROFILE = Object.freeze({
  id: 'none',
  label: 'No prompt',
  match: Object.freeze({ architectures: Object.freeze([]), namePatterns: Object.freeze([]) }),
  query: '{text}',
  document: '{text}',
  dims: Object.freeze([]),
  defaultDims: 0,
});

const profileCache = new Map();

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// A template must place the input, may place a title, and carries no other
// brace: an unknown placeholder would reach the model verbatim.
function isValidTemplate(value) {
  if (typeof value !== 'string' || value.length > MAX_TEMPLATE_LENGTH || !value.includes('{text}')) {
    return false;
  }
  return !/[{}]/.test(value.replace(/\{(?:text|title)\}/g, ''));
}

function normalizeMatch(value) {
  const source = isPlainObject(value) ? value : {};
  const architectures = Array.isArray(source.architectures) ? source.architectures : [];
  const namePatterns = Array.isArray(source.namePatterns) ? source.namePatterns : [];
  if (architectures.length > MAX_MATCH_ENTRIES || namePatterns.length > MAX_MATCH_ENTRIES) return null;
  if (!architectures.every((entry) => typeof entry === 'string' && /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(entry))) {
    return null;
  }
  for (const pattern of namePatterns) {
    if (typeof pattern !== 'string' || !pattern || pattern.length > MAX_NAME_PATTERN_LENGTH) return null;
    try {
      new RegExp(pattern, 'i'); // Compile check only.
    } catch (_error) {
      return null;
    }
  }
  return Object.freeze({
    architectures: Object.freeze([...architectures]),
    namePatterns: Object.freeze([...namePatterns]),
  });
}

function normalizeProfile(entry) {
  if (!isPlainObject(entry) || typeof entry.id !== 'string' || !PROFILE_ID_PATTERN.test(entry.id)) return null;
  if (!isValidTemplate(entry.query) || !isValidTemplate(entry.document)) return null;
  const match = normalizeMatch(entry.match);
  if (!match) return null;
  const dimsRaw = entry.dims === undefined ? [] : entry.dims;
  if (!Array.isArray(dimsRaw)
      || !dimsRaw.every((dim) => Number.isInteger(dim) && dim > 0 && dim <= MAX_DIMS)) {
    return null;
  }
  const dims = [...new Set(dimsRaw)];
  let defaultDims = 0;
  if (entry.defaultDims !== undefined) {
    if (!dims.includes(entry.defaultDims)) return null;
    defaultDims = entry.defaultDims;
  }
  const label = typeof entry.label === 'string' && entry.label.trim()
    ? entry.label.trim().slice(0, MAX_LABEL_LENGTH)
    : entry.id;
  return Object.freeze({
    id: entry.id,
    label,
    match,
    query: entry.query,
    document: entry.document,
    dims: Object.freeze(dims),
    defaultDims,
  });
}

// Reads and validates the profile file once per path. Invalid profiles and
// duplicate ids are dropped; `none` is always present so resolution has a
// floor.
function loadEmbeddingProfiles({ fsImpl = fs, filePath = DEFAULT_PROFILES_PATH } = {}) {
  const cached = profileCache.get(filePath);
  if (cached) return cached;
  let parsed;
  try {
    parsed = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    parsed = null;
  }
  const profiles = [];
  const seen = new Set();
  if (isPlainObject(parsed) && parsed.version === 1 && Array.isArray(parsed.profiles)) {
    for (const entry of parsed.profiles) {
      const profile = normalizeProfile(entry);
      if (!profile || seen.has(profile.id)) continue;
      seen.add(profile.id);
      profiles.push(profile);
    }
  }
  if (!seen.has('none')) profiles.push(BUILTIN_NONE_PROFILE);
  const result = Object.freeze(profiles);
  profileCache.set(filePath, result);
  return result;
}

function profileMatches(profile, { architecture, candidates }) {
  const match = profile && profile.match;
  if (!match) return false;
  if (architecture && Array.isArray(match.architectures) && match.architectures.includes(architecture)) {
    return true;
  }
  for (const source of Array.isArray(match.namePatterns) ? match.namePatterns : []) {
    let pattern;
    try {
      pattern = new RegExp(source, 'i');
    } catch (_error) {
      continue;
    }
    if (candidates.some((candidate) => pattern.test(candidate))) return true;
  }
  return false;
}

// An override that names a known profile wins; otherwise the first profile
// whose architecture or name pattern matches the GGUF name or file name;
// otherwise `none`.
function resolveEmbeddingProfile({
  architecture = '',
  name = '',
  fileName = '',
  overrideId = '',
  profiles = loadEmbeddingProfiles(),
} = {}) {
  const list = Array.isArray(profiles) ? profiles : [];
  if (overrideId) {
    const override = list.find((profile) => profile && profile.id === overrideId);
    if (override) return override;
  }
  const arch = typeof architecture === 'string' ? architecture.toLowerCase() : '';
  const candidates = [name, fileName].filter((value) => typeof value === 'string' && value);
  const matched = list.find((profile) => profile && profile.id !== 'none'
    && profileMatches(profile, { architecture: arch, candidates }));
  if (matched) return matched;
  return list.find((profile) => profile && profile.id === 'none') || BUILTIN_NONE_PROFILE;
}

// 0 means the model's native width (no Matryoshka truncation).
function resolveEmbeddingDims(profile, requestedDims) {
  const dims = profile && Array.isArray(profile.dims) ? profile.dims : [];
  if (Number.isInteger(requestedDims) && dims.includes(requestedDims)) return requestedDims;
  const fallback = profile && profile.defaultDims;
  return Number.isInteger(fallback) && fallback > 0 ? fallback : 0;
}

function headerFailureReason(error) {
  if (error instanceof GgufHeaderError && error.reason === 'unreadable') return 'unreadable';
  return 'not_gguf';
}

// Classifies a picked file. The result never carries the path: a refusal is a
// reason code, and an accepted model reports only header facts.
function validateEmbeddingModel(filePath, { fsImpl = fs, platform = process.platform } = {}) {
  if (typeof filePath !== 'string'
      || filePath.length > MAX_MODEL_PATH_LENGTH
      || !isLocalAbsolutePath(filePath, { platform })
      || !/\.gguf$/i.test(filePath)) {
    return { ok: false, reason: 'path_invalid' };
  }
  let header;
  try {
    header = readGgufHeader(filePath, {
      maxBytes: HEADER_MAX_BYTES,
      maxKv: HEADER_MAX_KV,
      maxString: HEADER_MAX_STRING,
      fsImpl,
    });
  } catch (error) {
    return { ok: false, reason: headerFailureReason(error) };
  }
  const architecture = typeof header.architecture === 'string' ? header.architecture : '';
  const kv = header.kv || {};
  const poolingRaw = architecture ? kv[`${architecture}.pooling_type`] : undefined;
  const hasPooling = Number.isInteger(poolingRaw);
  if (!architecture || (!hasPooling && !EMBEDDING_ARCHITECTURES.has(architecture))) {
    return { ok: false, reason: 'not_embedding_model' };
  }
  const embeddingRaw = kv[`${architecture}.embedding_length`];
  const name = typeof kv['general.name'] === 'string' ? kv['general.name'].slice(0, MAX_NAME_LENGTH) : '';
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const profile = resolveEmbeddingProfile({
    architecture,
    name,
    fileName: pathApi.basename(filePath),
  });
  return {
    ok: true,
    architecture,
    name,
    poolingType: hasPooling ? poolingRaw : null,
    embeddingLength: Number.isInteger(embeddingRaw) && embeddingRaw > 0 ? embeddingRaw : 0,
    profileId: profile.id,
  };
}

module.exports = {
  BUILTIN_NONE_PROFILE,
  DEFAULT_PROFILES_PATH,
  loadEmbeddingProfiles,
  resolveEmbeddingDims,
  resolveEmbeddingProfile,
  validateEmbeddingModel,
};
