'use strict';

const fs = require('fs');
const path = require('path');

const {
  LLAMA_SERVER_PROFILE_MANAGED_ARGS,
  validateExtraArgs,
} = require('./backend-config');

const FALLBACK_DEFAULTS = Object.freeze({
  draftNMax: 4,
  draftNMaxMin: 1,
  draftNMaxMax: 6,
  vramHeadroomMb: 2048,
});
const MTP_STATES = new Set(['yes', 'unverified', 'no']);
const MTP_SHAPES = new Set(['native', 'separate']);

function canonicalizeModelToken(modelTag) {
  const key = String(modelTag).trim().toLowerCase();
  const base = key.slice(key.lastIndexOf('/') + 1).split(':', 1)[0];
  return base.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sanitizePositiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function sanitizeNonNegativeNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function sanitizeDefaults(defaults) {
  return {
    draftNMax: sanitizePositiveInteger(defaults.draftNMax, FALLBACK_DEFAULTS.draftNMax),
    draftNMaxMin: sanitizePositiveInteger(
      defaults.draftNMaxMin,
      FALLBACK_DEFAULTS.draftNMaxMin
    ),
    draftNMaxMax: sanitizePositiveInteger(
      defaults.draftNMaxMax,
      FALLBACK_DEFAULTS.draftNMaxMax
    ),
    vramHeadroomMb: sanitizeNonNegativeNumber(
      defaults.vramHeadroomMb,
      FALLBACK_DEFAULTS.vramHeadroomMb
    ),
  };
}

function isValidFamily(entry) {
  return isPlainObject(entry)
    && typeof entry.family === 'string'
    && entry.family.length > 0
    && Array.isArray(entry.matchPrefixes)
    && entry.matchPrefixes.length > 0
    && entry.matchPrefixes.every((prefix) => typeof prefix === 'string' && prefix.length > 0)
    && MTP_STATES.has(entry.mtp)
    && MTP_SHAPES.has(entry.mtpShape);
}

function loadAccelerationCatalog({ repoRoot, fsImpl = fs } = {}) {
  let raw;
  try {
    raw = fsImpl.readFileSync(
      path.join(repoRoot, 'config', 'model-acceleration-catalog.json'),
      'utf8'
    );
  } catch (_error) {
    return { catalog: null, error: 'catalog_not_found' };
  }

  let catalog;
  try {
    catalog = JSON.parse(raw);
  } catch (_error) {
    return { catalog: null, error: 'catalog_json_invalid' };
  }

  if (!isPlainObject(catalog) || catalog.schema_version !== 1) {
    return { catalog: null, error: 'catalog_schema_unsupported' };
  }
  if (!isPlainObject(catalog.defaults)
      || !Array.isArray(catalog.families)
      || !catalog.families.every(isValidFamily)) {
    return { catalog: null, error: 'catalog_invalid' };
  }

  catalog.defaults = sanitizeDefaults(catalog.defaults);
  return { catalog, error: '' };
}

function globLiteRegex(pattern) {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function findDrafterFile({ modelDir, drafterPattern, fsImpl = fs } = {}) {
  try {
    if (typeof drafterPattern !== 'string'
        || drafterPattern.length === 0
        || drafterPattern.includes('..')
        || /[\\/]/.test(drafterPattern)) {
      return '';
    }

    const resolvedDir = path.resolve(modelDir);
    const directoryPrefix = `${resolvedDir}${path.sep}`;
    const matcher = globLiteRegex(drafterPattern);
    const names = fsImpl.readdirSync(modelDir)
      .filter((name) => typeof name === 'string')
      .sort();

    for (const name of names) {
      if (!matcher.test(name)) {
        continue;
      }
      const candidate = path.join(resolvedDir, name);
      if (path.resolve(candidate).startsWith(directoryPrefix)) {
        return candidate;
      }
    }
  } catch (_error) {
    return '';
  }
  return '';
}

function offResult(reason) {
  return {
    mode: 'off',
    extraArgs: [],
    vramHeadroomMb: 0,
    reason,
    drafter: '',
  };
}

function finalizeResult(result) {
  if (result.extraArgs.length === 0) {
    return result;
  }
  try {
    const containsManagedArg = result.extraArgs.some((arg) => (
      LLAMA_SERVER_PROFILE_MANAGED_ARGS.has(arg.split('=', 1)[0])
    ));
    const validation = validateExtraArgs(result.extraArgs);
    if (containsManagedArg || validation.error) {
      return offResult('args_rejected');
    }
    return { ...result, extraArgs: validation.args };
  } catch (_error) {
    return offResult('args_rejected');
  }
}

function findFamily(modelTag, catalog) {
  const token = canonicalizeModelToken(modelTag);
  const families = Array.isArray(catalog && catalog.families) ? catalog.families : [];
  return families.find((entry) => (
    Array.isArray(entry && entry.matchPrefixes)
    && entry.matchPrefixes.some((prefix) => (
      typeof prefix === 'string' && token.startsWith(prefix)
    ))
  )) || null;
}

function supportsNgram(capabilities) {
  return Array.isArray(capabilities.specTypes)
    && capabilities.specTypes.includes('ngram-cache');
}

function ngramResult(capabilities, reason) {
  if (!supportsNgram(capabilities)) {
    return offResult(reason === 'ngram' ? 'no_supported_mode' : reason);
  }
  return finalizeResult({
    mode: 'ngram',
    extraArgs: ['--spec-type', 'ngram-cache'],
    vramHeadroomMb: 0,
    reason,
    drafter: '',
  });
}

function profileOwnsSpecType(profileExtraArgs) {
  return Array.isArray(profileExtraArgs) && profileExtraArgs.some((arg) => {
    if (typeof arg !== 'string') {
      return false;
    }
    const flagName = arg.split('=', 1)[0];
    return flagName === '--spec-type' || flagName === '--model-draft';
  });
}

function profileDisablesFit(profileExtraArgs) {
  if (!Array.isArray(profileExtraArgs)) {
    return false;
  }
  return profileExtraArgs.some((arg, index) => (
    arg === '--fit=off' || (arg === '--fit' && profileExtraArgs[index + 1] === 'off')
  ));
}

function resolveAccelerationArgs({
  modelTag,
  mode,
  draftNMax,
  allowUnverified,
  catalog,
  capabilities,
  profileExtraArgs,
  modelDir,
  fsImpl = fs,
} = {}) {
  if (!mode || mode === 'off') {
    return offResult('disabled');
  }
  if (!capabilities || capabilities.ok !== true) {
    return offResult('capabilities_unknown');
  }
  if (profileOwnsSpecType(profileExtraArgs)) {
    return offResult('profile_owns_spec_type');
  }
  if (profileDisablesFit(profileExtraArgs)) {
    return offResult('profile_fit_off');
  }
  if (mode === 'ngram') {
    return ngramResult(capabilities, 'ngram');
  }
  if (mode !== 'mtp') {
    return offResult('no_supported_mode');
  }

  const family = findFamily(modelTag, catalog);
  let fallbackReason = '';
  if (capabilities.supportsMtp !== true) {
    fallbackReason = 'mtp_ineligible:binary';
  } else if (!family) {
    fallbackReason = 'mtp_ineligible:unknown_family';
  } else if (family.mtp === 'no'
      || (family.mtp === 'unverified' && allowUnverified !== true)) {
    fallbackReason = 'mtp_ineligible:family';
  }

  if (fallbackReason) {
    if (!family || family.ngram === true) {
      return ngramResult(capabilities, fallbackReason);
    }
    return offResult(fallbackReason);
  }

  let drafterPath = '';
  if (family.mtpShape === 'separate') {
    drafterPath = findDrafterFile({
      modelDir,
      drafterPattern: family.drafterPattern,
      fsImpl,
    });
    if (!drafterPath) {
      return family.ngram === true
        ? ngramResult(capabilities, 'drafter_missing')
        : offResult('drafter_missing');
    }
  }

  const defaults = sanitizeDefaults(isPlainObject(catalog && catalog.defaults)
    ? catalog.defaults
    : FALLBACK_DEFAULTS);
  const n = Number.isInteger(draftNMax)
      && draftNMax >= defaults.draftNMaxMin
      && draftNMax <= defaults.draftNMaxMax
    ? draftNMax
    : defaults.draftNMax;
  const extraArgs = [
    '--spec-type',
    'draft-mtp',
    '--spec-draft-n-max',
    String(n),
  ];
  if (drafterPath) {
    extraArgs.push('--model-draft', drafterPath);
  }

  return finalizeResult({
    mode: 'mtp',
    extraArgs,
    vramHeadroomMb: sanitizeNonNegativeNumber(
      family.vramHeadroomMb,
      defaults.vramHeadroomMb
    ),
    reason: 'mtp',
    drafter: drafterPath ? path.basename(drafterPath) : '',
  });
}

module.exports = {
  canonicalizeModelToken,
  loadAccelerationCatalog,
  findDrafterFile,
  resolveAccelerationArgs,
};
