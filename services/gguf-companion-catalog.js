'use strict';

// The pinned catalog of GGUF companion files (MTP drafters and vision
// projectors): which local model gets which file, and where the file comes
// from. The catalog is provenance, not a download list: every URL is derived
// from validated fields (repo, a 40-hex revision, a repo path), so a tampered
// file cannot send a download to another host or path, and size and sha256
// are pinned for the download step to verify. A catalog that fails
// validation yields no entries at all (fail closed). Header strings of a
// local GGUF are untrusted: they are compared with catalog values and never
// used to build a path or a URL. No network access and no Electron imports
// here, so it runs under plain Node.

const fs = require('node:fs');
const path = require('node:path');

const { loadAccelerationCatalog } = require('./backend/llama-server-acceleration');
const { modelFamily, pairProjector, splitGgufFiles } = require('./llama-server-gguf-files');

const DEFAULT_CATALOG_PATH = path.join(__dirname, '..', 'config', 'gguf-companions.json');
const SCHEMA_VERSION = 1;
const MAX_ENTRIES = 64;
const MAX_MATCH_VALUES = 16;
const MAX_BASE_MODELS = 8;
const GIB = 1024 * 1024 * 1024;
const MAX_BYTES = Object.freeze({ drafter: 8 * GIB, projector: 4 * GIB });
const HF_PREFIX = 'https://huggingface.co/';

const ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const REVISION = /^[0-9a-f]{40}$/;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAVE_AS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.gguf$/;

// A family whose MTP drafts with a separate mtp-*.gguf file (not a built-in head).
const isSeparateMtpFamily = (family) => Boolean(family && family.mtp === 'yes' && family.mtpShape === 'separate');
const SHA256 = /^[0-9a-f]{64}$/;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isPositiveSafeInteger = (value) => Number.isSafeInteger(value) && value > 0;

function validateRepoPath(repoPath) {
  if (typeof repoPath !== 'string' || repoPath.includes('\\')) return false;
  const segments = repoPath.split('/');
  return (segments.length === 1 || segments.length === 2)
    && segments.every((segment) => SEGMENT.test(segment) && !segment.includes('..'))
    && segments[segments.length - 1].endsWith('.gguf');
}

// A drafter or projector object. `kind` is 'drafter' or 'projector'.
function validateFile(file, kind, basenames, where, errors) {
  const fail = (field, rule) => errors.push(`${where}.${field}: ${rule}`);
  if (!isPlainObject(file)) {
    errors.push(`${where}: must be an object`);
    return;
  }
  if (typeof file.repo !== 'string' || !REPO.test(file.repo)) fail('repo', 'must be <owner>/<name>');
  if (typeof file.revision !== 'string' || !REVISION.test(file.revision)) {
    fail('revision', 'must be a 40-character lowercase commit sha');
  }
  if (!validateRepoPath(file.repoPath)) {
    fail('repoPath', 'must be one or two plain path segments ending in .gguf');
  }
  const saveAsOk = typeof file.saveAs === 'string' && SAVE_AS.test(file.saveAs);
  if (!saveAsOk) fail('saveAs', 'must be a plain .gguf file name');
  if (!isPositiveSafeInteger(file.bytes) || file.bytes > MAX_BYTES[kind]) {
    fail('bytes', `must be a positive integer of at most ${MAX_BYTES[kind]}`);
  }
  if (typeof file.sha256 !== 'string' || !SHA256.test(file.sha256)) {
    fail('sha256', 'must be 64 lowercase hex characters');
  }
  if (!isPositiveSafeInteger(file.vramMb)) fail('vramMb', 'must be a positive integer');
  if (file.gainOverBuiltInPct !== undefined
      && !(typeof file.gainOverBuiltInPct === 'number' && Number.isFinite(file.gainOverBuiltInPct)
        && file.gainOverBuiltInPct >= 0 && file.gainOverBuiltInPct <= 1000)) {
    fail('gainOverBuiltInPct', 'must be a finite number from 0 to 1000');
  }
  if (file.vramOverBuiltInMb !== undefined
      && !(Number.isSafeInteger(file.vramOverBuiltInMb) && file.vramOverBuiltInMb >= 0)) {
    fail('vramOverBuiltInMb', 'must be a non-negative integer');
  }
  if (!saveAsOk) return;

  // The saved name must be classified and paired by the same rules the launch
  // uses, or the download would land a file the app then ignores.
  const split = splitGgufFiles([file.saveAs]);
  if (kind === 'drafter' && !split.drafters.includes(file.saveAs)) {
    fail('saveAs', 'is not classified as an MTP drafter (must start with mtp-)');
  }
  if (kind === 'projector') {
    if (!split.projectors.includes(file.saveAs)) {
      fail('saveAs', 'is not classified as a vision projector (must contain mmproj)');
      return;
    }
    for (const basename of basenames) {
      if (typeof basename !== 'string') continue;
      const model = `${basename}-Q4_K_M.gguf`;
      const mixed = splitGgufFiles([model, 'other-model-7B-Q4_K_M.gguf', file.saveAs]);
      if (pairProjector('/d', model, mixed) !== path.join('/d', file.saveAs)) {
        fail('saveAs', `does not pair with ${basename} in a folder with another model`);
      }
    }
  }
}

function validateMatch(match, where, errors) {
  if (!isPlainObject(match)) {
    errors.push(`${where}: must be an object`);
    return [];
  }
  if (typeof match.architecture !== 'string' || match.architecture.length === 0) {
    errors.push(`${where}.architecture: must be a non-empty string`);
  }
  let populated = 0;
  for (const field of ['baseModelRepos', 'basenames', 'fileFamilies']) {
    const values = match[field];
    if (values === undefined) continue;
    const ok = Array.isArray(values) && values.length <= MAX_MATCH_VALUES
      && values.every((value) => typeof value === 'string' && value.length > 0 && value.length <= 128);
    if (!ok) {
      errors.push(`${where}.${field}: must be an array of up to ${MAX_MATCH_VALUES} non-empty strings`);
    } else if (field === 'baseModelRepos' && !values.every((value) => REPO.test(value))) {
      errors.push(`${where}.${field}: every item must be <owner>/<name>`);
    } else if (values.length > 0) {
      populated += 1;
    }
  }
  if (populated === 0) {
    errors.push(`${where}: needs at least one of baseModelRepos, basenames or fileFamilies`);
  }
  return Array.isArray(match.basenames) ? match.basenames : [];
}

function validateEntry(entry, index, seenIds, families, errors) {
  const where = `entries[${index}]`;
  if (!isPlainObject(entry)) {
    errors.push(`${where}: must be an object`);
    return;
  }
  if (typeof entry.id !== 'string' || !ID.test(entry.id)) {
    errors.push(`${where}.id: must match ${ID}`);
  } else if (seenIds.has(entry.id)) {
    errors.push(`${where}.id: duplicate id ${entry.id}`);
  } else {
    seenIds.add(entry.id);
  }
  const family = families.find((item) => item && item.family === entry.family);
  if (typeof entry.family !== 'string' || !family) {
    errors.push(`${where}.family: must name a family in the acceleration catalog`);
  }
  const basenames = validateMatch(entry.match, `${where}.match`, errors);
  if (entry.drafter !== undefined) {
    if (family && !isSeparateMtpFamily(family)) {
      errors.push(`${where}.drafter: family ${entry.family} has no verified separate MTP drafter`);
    }
    validateFile(entry.drafter, 'drafter', basenames, `${where}.drafter`, errors);
  }
  if (entry.projector !== undefined) {
    validateFile(entry.projector, 'projector', basenames, `${where}.projector`, errors);
  }
  if (entry.drafter === undefined && entry.projector === undefined) {
    errors.push(`${where}: needs a drafter or a projector`);
  }
}

// Never throws. `accelerationCatalog` is the loaded catalog object
// (loadAccelerationCatalog().catalog) that decides which families may carry a
// drafter.
function validateCompanionCatalog(json, { accelerationCatalog } = {}) {
  const errors = [];
  try {
    if (!isPlainObject(json)) return { ok: false, errors: ['catalog: must be an object'] };
    if (json.schema_version !== SCHEMA_VERSION) errors.push('schema_version: must be 1');
    const families = Array.isArray(accelerationCatalog && accelerationCatalog.families)
      ? accelerationCatalog.families
      : [];
    if (families.length === 0) errors.push('acceleration catalog: no families to check against');
    if (!Array.isArray(json.entries)) {
      errors.push('entries: must be an array');
    } else if (json.entries.length > MAX_ENTRIES) {
      errors.push(`entries: at most ${MAX_ENTRIES} allowed`);
    } else {
      const seenIds = new Set();
      json.entries.forEach((entry, index) => validateEntry(entry, index, seenIds, families, errors));
    }
  } catch (_error) {
    errors.push('catalog: validation failed');
  }
  return { ok: errors.length === 0, errors };
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function failedCatalog(error) {
  return deepFreeze({ schemaVersion: SCHEMA_VERSION, entries: [], error });
}

// Never throws: any read, parse or validation failure is an empty catalog with
// the first error, so a damaged file turns the feature off rather than on.
function loadCompanionCatalog({
  filePath = DEFAULT_CATALOG_PATH,
  accelerationCatalog,
  readFile = fs.readFileSync,
} = {}) {
  try {
    let accel = accelerationCatalog;
    if (!accel) {
      accel = loadAccelerationCatalog({ repoRoot: path.join(__dirname, '..') }).catalog;
    }
    let json;
    try {
      json = JSON.parse(readFile(filePath, 'utf8'));
    } catch (_error) {
      return failedCatalog('catalog_unreadable');
    }
    const verdict = validateCompanionCatalog(json, { accelerationCatalog: accel });
    if (!verdict.ok) return failedCatalog(verdict.errors[0]);
    return deepFreeze({ schemaVersion: json.schema_version, entries: json.entries });
  } catch (_error) {
    return failedCatalog('catalog_load_failed');
  }
}

const lower = (value) => String(value).toLowerCase();
const includesFold = (list, value) => Array.isArray(list)
  && typeof value === 'string' && list.some((item) => lower(item) === lower(value));

// The Hugging Face repo path a header's base-model URL names, or ''.
function repoOfUrl(url) {
  if (typeof url !== 'string' || !url.startsWith(HF_PREFIX)) return '';
  return url.slice(HF_PREFIX.length).replace(/\/+$/, '');
}

function headerBaseModelRepos(kv) {
  const count = Number.isInteger(kv['general.base_model.count']) ? kv['general.base_model.count'] : 0;
  const repos = [];
  for (let n = 0; n < Math.min(count, MAX_BASE_MODELS); n += 1) {
    const repo = repoOfUrl(kv[`general.base_model.${n}.repo_url`]);
    if (repo) repos.push(repo);
  }
  return repos;
}

// The file name (without .gguf) carries one of `basenames` whole, bounded by
// separators. For example "Swift-1.5-Qwen3.8-27B-Q6_K_S" names "Qwen3.8-27B";
// "Qwen3.8-27Bx-Q4" and "MyQwen3.8-27B" do not.
function namesBaseInFileName(fileName, basenames) {
  if (typeof fileName !== 'string' || !Array.isArray(basenames)) return false;
  const stem = lower(fileName.replace(/\.gguf$/i, ''));
  return basenames.some((name) => {
    const token = lower(name);
    if (!token) return false;
    for (let at = stem.indexOf(token); at >= 0; at = stem.indexOf(token, at + 1)) {
      const before = at === 0 || /[-_.\s]/.test(stem[at - 1]);
      const after = at + token.length === stem.length || /[-_.\s]/.test(stem[at + token.length]);
      if (before && after) return true;
    }
    return false;
  });
}

// Which entry (if any) a local model belongs to. `header` is the model's
// { architecture, kv } or null when it could not be read; `fileName` is the
// main GGUF's file name. Returns null or
// { entry, matchedBy: 'base_model' | 'basename' | 'file_name' | 'file_family', fineTune, baseName }.
function matchCompanionEntry({ header, fileName } = {}, catalog) {
  const entries = Array.isArray(catalog && catalog.entries) ? catalog.entries : [];
  const result = (entry, matchedBy, fineTune = false) => ({
    entry, matchedBy, fineTune, baseName: (entry.match.basenames || [])[0] || '',
  });
  if (header) {
    const kv = header.kv && typeof header.kv === 'object' ? header.kv : {};
    const sameArch = entries.filter((entry) => entry.match.architecture === header.architecture);
    const repos = headerBaseModelRepos(kv);
    const basename = typeof kv['general.basename'] === 'string' ? kv['general.basename'] : '';
    for (const entry of sameArch) {
      if (repos.some((repo) => includesFold(entry.match.baseModelRepos, repo))) {
        const fineTune = basename.length > 0 && !includesFold(entry.match.basenames, basename);
        return result(entry, 'base_model', fineTune);
      }
    }
    const byBasename = sameArch.find((entry) => includesFold(entry.match.basenames, basename));
    if (byBasename) return result(byBasename, 'basename');
    // A fine-tune whose header names neither its base nor the base's name (Swift 1.5
    // says only "Miroslav") still carries the base's name in its file name. Same
    // architecture plus that whole token: offered as a fine-tune, "Made for <base>".
    const byFileName = sameArch.find((entry) => namesBaseInFileName(fileName, entry.match.basenames));
    return byFileName ? result(byFileName, 'file_name', true) : null;
  }
  if (typeof fileName !== 'string' || fileName.length === 0) return null;
  const family = modelFamily(fileName);
  const byFamily = entries.find((entry) => includesFold(entry.match.fileFamilies, family));
  return byFamily ? result(byFamily, 'file_family') : null;
}

// The only place a download URL is made: from validated fields, each path
// segment encoded.
function companionDownloadUrl(file) {
  const segments = String(file.repoPath).split('/').map(encodeURIComponent).join('/');
  return `https://huggingface.co/${file.repo}/resolve/${file.revision}/${segments}`;
}

module.exports = {
  DEFAULT_CATALOG_PATH,
  SAVE_AS,
  companionDownloadUrl,
  isSeparateMtpFamily,
  loadCompanionCatalog,
  matchCompanionEntry,
  validateCompanionCatalog,
};
