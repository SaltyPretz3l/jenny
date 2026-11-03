'use strict';

// Durable daily usage rollup (Home usage stats, row 98 D1).
//
// usage-history.json keeps 30 days / 500 turns of per-turn rows. This ledger keeps one
// small aggregate bucket per local calendar day so 6mo / 1yr / lifetime stats outlive
// that retention. It holds no chat ids and no content, and it is local only.

const path = require('path');
const { FileJsonStore } = require('./backend/file-json-store');
const { normalizeText } = require('./shared/normalize');

const USAGE_ROLLUP_FILE = 'usage-rollup.json';
const USAGE_ROLLUP_SCHEMA_VERSION = 1;
const MAX_ROLLUP_DAYS = 1830; // five years of daily buckets; older days merge into `archived`.
const MAX_MODELS_PER_DAY = 12;
const MAX_ID_CHARS = 160;
const OTHER_MODEL = '(other)';
const COUNTER_FIELDS = Object.freeze([
  'turns',
  'input_tokens',
  'output_tokens',
  'total_tokens',
  'generation_tokens',
  'generation_duration_ms',
  'estimated_turns',
]);
const DAY_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value, limit = MAX_ID_CHARS) {
  return normalizeText(value).slice(0, limit);
}

function counter(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0
    ? Math.min(Math.trunc(numeric), Number.MAX_SAFE_INTEGER)
    : 0;
}

function clampSum(current, delta) {
  return Math.min(Math.max(current + delta, 0), Number.MAX_SAFE_INTEGER);
}

function own(map, key) {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

// Model names are untrusted: define own properties so a '__proto__' key stays plain data.
function put(map, key, value) {
  Object.defineProperty(map, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function isoOrEmpty(value) {
  const ms = Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

function emptyRollup() {
  return {
    schema_version: USAGE_ROLLUP_SCHEMA_VERSION,
    updated_at: '',
    first_recorded_at: '',
    days: {},
    archived: null,
  };
}

function emptyBucket() {
  const bucket = {};
  for (const field of COUNTER_FIELDS) {
    bucket[field] = 0;
  }
  bucket.hours = new Array(24).fill(0);
  bucket.models = {};
  return bucket;
}

function cloneBucket(source) {
  const copy = { ...source, hours: source.hours.slice(), models: {} };
  for (const name of Object.keys(source.models)) {
    put(copy.models, name, { ...source.models[name] });
  }
  return copy;
}

function isEmptyBucket(bucket) {
  return COUNTER_FIELDS.every((field) => bucket[field] === 0);
}

/** Local calendar date 'YYYY-MM-DD' (process timezone), or '' for an unusable input. */
function localDateKey(dateOrIso) {
  let ms = NaN;
  if (dateOrIso instanceof Date) {
    ms = dateOrIso.getTime();
  } else if (typeof dateOrIso === 'string') {
    ms = Date.parse(dateOrIso);
  } else if (typeof dateOrIso === 'number') {
    ms = dateOrIso;
  }
  if (!Number.isFinite(ms)) {
    return '';
  }
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function validDayKey(key) {
  const match = DAY_KEY_PATTERN.exec(key);
  if (!match) {
    return false;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1970) {
    return false;
  }
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

// Keep the largest models by turns and sum the rest into '(other)'; totals stay exact.
function foldModels(models) {
  const names = Object.keys(models);
  if (names.length <= MAX_MODELS_PER_DAY) {
    return models;
  }
  const ranked = names
    .filter((name) => name !== OTHER_MODEL)
    .sort((left, right) => (
      models[right].turns - models[left].turns
      || models[right].total_tokens - models[left].total_tokens
      || (left < right ? -1 : 1)
    ));
  const other = own(models, OTHER_MODEL) || { provider: '', turns: 0, total_tokens: 0 };
  for (const name of ranked.slice(MAX_MODELS_PER_DAY - 1)) {
    other.turns = clampSum(other.turns, models[name].turns);
    other.total_tokens = clampSum(other.total_tokens, models[name].total_tokens);
    delete models[name];
  }
  put(models, OTHER_MODEL, other);
  return models;
}

function addModel(models, name, entry) {
  const existing = own(models, name);
  if (!existing) {
    put(models, name, { provider: entry.provider, turns: entry.turns, total_tokens: entry.total_tokens });
    return;
  }
  existing.turns = clampSum(existing.turns, entry.turns);
  existing.total_tokens = clampSum(existing.total_tokens, entry.total_tokens);
  if (entry.provider) {
    existing.provider = entry.provider;
  }
}

function normalizeModels(raw) {
  const models = {};
  if (!isObject(raw)) {
    return models;
  }
  for (const key of Object.keys(raw)) {
    const name = boundedText(key);
    const entry = raw[key];
    if (!name || !isObject(entry)) {
      continue;
    }
    const turns = counter(entry.turns);
    const totalTokens = counter(entry.total_tokens);
    if (turns === 0 && totalTokens === 0) {
      continue;
    }
    addModel(models, name, { provider: boundedText(entry.provider), turns, total_tokens: totalTokens });
  }
  return foldModels(models);
}

function normalizeBucket(raw) {
  const source = isObject(raw) ? raw : {};
  const bucket = emptyBucket();
  for (const field of COUNTER_FIELDS) {
    bucket[field] = counter(source[field]);
  }
  if (Array.isArray(source.hours)) {
    for (let hour = 0; hour < 24; hour += 1) {
      bucket.hours[hour] = counter(source.hours[hour]);
    }
  }
  bucket.models = normalizeModels(source.models);
  return bucket;
}

function mergeBucketInto(target, source) {
  for (const field of COUNTER_FIELDS) {
    target[field] = clampSum(target[field], source[field]);
  }
  for (let hour = 0; hour < 24; hour += 1) {
    target.hours[hour] = clampSum(target.hours[hour], source.hours[hour]);
  }
  for (const name of Object.keys(source.models)) {
    addModel(target.models, name, source.models[name]);
  }
  foldModels(target.models);
}

// Days past the cap merge (oldest first) into `archived`; lifetime sums stay exact.
function enforceDayCap(rollup) {
  const keys = Object.keys(rollup.days);
  if (keys.length <= MAX_ROLLUP_DAYS) {
    return;
  }
  keys.sort();
  for (const key of keys.slice(0, keys.length - MAX_ROLLUP_DAYS)) {
    if (!rollup.archived) {
      rollup.archived = { from: key, to: key, ...emptyBucket() };
    }
    mergeBucketInto(rollup.archived, rollup.days[key]);
    if (key < rollup.archived.from) {
      rollup.archived.from = key;
    }
    if (key > rollup.archived.to) {
      rollup.archived.to = key;
    }
    delete rollup.days[key];
  }
}

/** Validate and bound untrusted file content. Always returns a well-formed rollup. */
function normalizeRollup(raw) {
  const source = isObject(raw) ? raw : {};
  const rollup = emptyRollup();
  rollup.updated_at = isoOrEmpty(source.updated_at);
  rollup.first_recorded_at = isoOrEmpty(source.first_recorded_at);
  if (isObject(source.days)) {
    for (const key of Object.keys(source.days).sort()) {
      if (!validDayKey(key) || !isObject(source.days[key])) {
        continue;
      }
      const bucket = normalizeBucket(source.days[key]);
      if (!isEmptyBucket(bucket)) {
        rollup.days[key] = bucket;
      }
    }
  }
  if (isObject(source.archived)) {
    const from = String(source.archived.from ?? '');
    const to = String(source.archived.to ?? '');
    const bucket = normalizeBucket(source.archived);
    if (validDayKey(from) && validDayKey(to) && !isEmptyBucket(bucket)) {
      rollup.archived = { from: from <= to ? from : to, to: from <= to ? to : from, ...bucket };
    }
  }
  enforceDayCap(rollup);
  return rollup;
}

function contributionOf(row) {
  if (!isObject(row)) {
    return null;
  }
  const ms = Date.parse(String(row.recorded_at ?? ''));
  if (!Number.isFinite(ms)) {
    return null;
  }
  const date = new Date(ms);
  const inputTokens = counter(row.input_tokens);
  const outputTokens = counter(row.output_tokens);
  return {
    ms,
    key: localDateKey(date),
    hour: date.getHours(),
    model: boundedText(row.model) || 'unknown',
    provider: boundedText(row.provider),
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: Math.max(counter(row.total_tokens), inputTokens + outputTokens),
    generation_tokens: counter(row.generation_tokens),
    // Rounded so adding and later subtracting the same row is exactly symmetric.
    generation_duration_ms: counter(Math.round(Number(row.generation_duration_ms))),
    estimated: row.estimated === true,
  };
}

function bumpModel(bucket, c, sign) {
  let name = c.model;
  let entry = own(bucket.models, name);
  if (!entry && sign < 0) {
    // A model folded into '(other)' is subtracted from there.
    name = OTHER_MODEL;
    entry = own(bucket.models, name);
  }
  if (!entry) {
    if (sign < 0) {
      return;
    }
    entry = { provider: c.provider, turns: 0, total_tokens: 0 };
    put(bucket.models, name, entry);
  }
  entry.turns = clampSum(entry.turns, sign);
  entry.total_tokens = clampSum(entry.total_tokens, sign * c.total_tokens);
  if (sign > 0 && c.provider) {
    entry.provider = c.provider;
  }
  if (entry.turns === 0 && entry.total_tokens === 0) {
    delete bucket.models[name];
  }
}

function addToBucket(bucket, c, sign) {
  bucket.turns = clampSum(bucket.turns, sign);
  bucket.input_tokens = clampSum(bucket.input_tokens, sign * c.input_tokens);
  bucket.output_tokens = clampSum(bucket.output_tokens, sign * c.output_tokens);
  bucket.total_tokens = clampSum(bucket.total_tokens, sign * c.total_tokens);
  bucket.generation_tokens = clampSum(bucket.generation_tokens, sign * c.generation_tokens);
  bucket.generation_duration_ms = clampSum(bucket.generation_duration_ms, sign * c.generation_duration_ms);
  bucket.estimated_turns = clampSum(bucket.estimated_turns, c.estimated ? sign : 0);
  bucket.hours[c.hour] = clampSum(bucket.hours[c.hour], sign);
  bumpModel(bucket, c, sign);
  if (sign > 0) {
    foldModels(bucket.models);
  }
}

function subtractContribution(working, c) {
  const archived = working.archived;
  if (own(working.days, c.key)) {
    const bucket = cloneBucket(working.days[c.key]);
    addToBucket(bucket, c, -1);
    if (isEmptyBucket(bucket)) {
      delete working.days[c.key];
    } else {
      working.days[c.key] = bucket;
    }
  } else if (archived && c.key >= archived.from && c.key <= archived.to) {
    addToBucket(archived, c, -1);
    if (isEmptyBucket(archived)) {
      working.archived = null;
    }
  }
}

function addContribution(working, c) {
  const existing = own(working.days, c.key);
  const bucket = existing ? cloneBucket(existing) : emptyBucket();
  addToBucket(bucket, c, 1);
  working.days[c.key] = bucket;
  if (!working.first_recorded_at || c.ms < Date.parse(working.first_recorded_at)) {
    working.first_recorded_at = new Date(c.ms).toISOString();
  }
}

/**
 * Pure: returns a new rollup with `prevRow` subtracted and `nextRow` added. The input is
 * never mutated; untouched day buckets are shared. Counters clamp at zero and a model at
 * zero turns and tokens is removed.
 */
function applyRowDelta(rollup, prevRow, nextRow) {
  const base = isObject(rollup) && isObject(rollup.days) ? rollup : emptyRollup();
  const working = {
    ...base,
    days: { ...base.days },
    archived: base.archived ? cloneBucket(base.archived) : null,
  };
  if (working.archived) {
    working.archived.from = base.archived.from;
    working.archived.to = base.archived.to;
  }
  const prev = contributionOf(prevRow);
  const next = contributionOf(nextRow);
  if (prev) {
    subtractContribution(working, prev);
  }
  if (next) {
    addContribution(working, next);
    enforceDayCap(working);
  }
  return working;
}

/** Build a rollup from per-turn history rows (first run after the upgrade). */
function seedFromRows(rows) {
  let rollup = emptyRollup();
  if (!Array.isArray(rows)) {
    return rollup;
  }
  for (const row of rows) {
    rollup = applyRowDelta(rollup, null, row);
  }
  return rollup;
}

function createUsageRollupStore({ userDataPath = '', store = null, logger = null, now = () => Date.now() } = {}) {
  const log = (level, event, details = {}) => {
    try {
      if (typeof logger === 'function') {
        logger(level, event, details);
      }
    } catch (_error) {
      // Diagnostics must never interfere with chat settlement.
    }
  };
  const backing = store || (userDataPath
    ? new FileJsonStore(path.join(userDataPath, USAGE_ROLLUP_FILE), {
      logger: typeof logger === 'function' ? logger : null,
      compact: true,
    })
    : null);
  let rollup = emptyRollup();
  let readOnlyReason = '';

  const stamp = () => {
    const ms = typeof now === 'function' ? Number(now()) : Date.now();
    return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();
  };
  const persist = () => {
    if (backing && !readOnlyReason) {
      backing.writeImmediate(rollup);
    }
  };

  return {
    /**
     * Read the file; seed from `seedRows` only when it does not exist yet. Never throws.
     * A corrupt, wrong-shape, unreadable or future-schema file goes read-only (kept on
     * disk, never overwritten) like usage-history.json; Clear usage lifts it.
     */
    load(seedRows) {
      readOnlyReason = '';
      rollup = emptyRollup();
      try {
        const status = backing ? backing.readWithStatus(null) : { missing: true };
        if (status.unreadable) {
          readOnlyReason = 'unreadable';
          log('WARN', 'usage_rollup.load_failed', { reason: 'unreadable' });
        } else if (status.corrupted || (!status.missing && !isObject(status.value))) {
          readOnlyReason = 'corrupt_store';
          log('WARN', 'usage_rollup.load_failed', { reason: 'corrupt_store' });
        } else if (status.missing) {
          rollup = seedFromRows(seedRows);
          rollup.updated_at = stamp();
          try {
            persist();
          } catch (error) {
            log('WARN', 'usage_rollup.initialize_failed', { errorCode: boundedText(error?.code, 40) });
          }
        } else {
          if (Number(status.value?.schema_version) > USAGE_ROLLUP_SCHEMA_VERSION) {
            readOnlyReason = 'future_schema';
            log('WARN', 'usage_rollup.future_schema', { observedVersion: Number(status.value.schema_version) });
          }
          rollup = normalizeRollup(status.value);
        }
      } catch (error) {
        rollup = emptyRollup();
        log('WARN', 'usage_rollup.load_failed', { errorCode: boundedText(error?.code, 40) });
      }
    },

    /** Apply a row change (upsert delta). The in-memory count updates even if the write throws. */
    apply(prevRow, nextRow) {
      rollup = applyRowDelta(rollup, prevRow, nextRow);
      rollup.updated_at = stamp();
      persist();
    },

    /** Empty the ledger. Write-before-swap: a failed write throws and keeps the data. */
    clear() {
      const cleared = emptyRollup();
      cleared.updated_at = stamp();
      if (backing) {
        backing.writeImmediate(cleared);
      }
      rollup = cleared;
      readOnlyReason = '';
    },

    snapshot() {
      return JSON.parse(JSON.stringify(rollup));
    },
  };
}

module.exports = {
  MAX_MODELS_PER_DAY,
  MAX_ROLLUP_DAYS,
  USAGE_ROLLUP_FILE,
  USAGE_ROLLUP_SCHEMA_VERSION,
  applyRowDelta,
  createUsageRollupStore,
  emptyRollup,
  localDateKey,
  normalizeRollup,
  seedFromRows,
};
