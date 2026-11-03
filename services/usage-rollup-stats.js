'use strict';

// Pure aggregation behind the Home "Usage" widget (row 98, slice S2). Turns the
// durable daily rollup (services/usage-rollup.js, `getRollupSnapshot()`) into
// every display range in one pass so the renderer switches ranges without IPC.
// No IO, no clock reads beyond the injected `now`, no throws on bad input.
//
// Dates are LOCAL calendar dates ('YYYY-MM-DD'). Calendar arithmetic goes
// through new Date(y, m, d + n) on date parts, never by subtracting 86400000 ms,
// so a 23h or 25h DST day cannot shift or duplicate a bucket.

const RANGE_KEYS = Object.freeze(['1d', '7d', '30d', '6mo', '1y', 'all']);
// Inclusive day counts ending today. 'all' has no window.
const RANGE_DAYS = Object.freeze({ '1d': 1, '7d': 7, '30d': 30, '6mo': 182, '1y': 365 });
// 53 week columns x 7 rows in the widget heatmap.
const HEATMAP_DAYS = 371;
const TOP_MODEL_LIMIT = 5;
// Overflow bucket the rollup writes when a day exceeds its model cap.
const OTHER_MODEL = '(other)';
const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Providers that run on this PC, from the values usage rows actually carry:
// the same set services/usage-history-service.js:27-34 (LOCAL_ZERO_PROVIDERS)
// treats as free local inference, mirrored by sidecar/runtime/chat_helpers.py:38.
// The recorded `provider` is the sidecar's engine_type; the cloud ones are
// 'chatgpt', 'codex-cli' and 'api-provider' (managed-sidecar-chat-helpers.js:34).
// The Electron IPC module passes the shared isLocalEngine() predicate instead
// (services/backend/session-lockdown-gate.js:154); this default keeps the pure
// module usable without that import.
const DEFAULT_LOCAL_PROVIDERS = new Set([
  'ollama',
  'vllm',
  'openai-compatible',
  'openai-compatible-local',
  'replay',
  'mock',
]);

function defaultIsLocalProvider(provider) {
  return DEFAULT_LOCAL_PROVIDERS.has(String(provider || '').trim().toLowerCase());
}

function pad2(value) {
  return value < 10 ? `0${value}` : String(value);
}

// Local-date key for a Date. (services/usage-rollup.js has its own; this tiny
// duplicate keeps the two slices independent.)
function localDateKey(date) {
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

// 'YYYY-MM-DD' -> local midnight Date, or null for non-dates (including
// calendar-impossible ones like 2026-13-45).
function parseDateKey(key) {
  const match = DATE_KEY_RE.exec(String(key || ''));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const dayOfMonth = Number(match[3]);
  const date = new Date(year, month - 1, dayOfMonth);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== dayOfMonth
  ) {
    return null;
  }
  return date;
}

function addDays(date, count) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + count);
}

function shiftKey(key, count) {
  const parsed = parseDateKey(key);
  return parsed ? localDateKey(addDays(parsed, count)) : '';
}

// Finite, non-negative number, else 0.
function num(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function count(value) {
  return Math.trunc(num(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function ratio(part, whole) {
  return whole > 0 ? round(part / whole, 4) : null;
}

function newAccumulator() {
  return {
    turns: 0,
    input: 0,
    output: 0,
    total: 0,
    generationTokens: 0,
    generationMs: 0,
    estimatedTurns: 0,
    localTurns: 0,
    activeDays: 0,
    hours: new Array(24).fill(0),
    models: new Map(),
    busiest: null,
  };
}

function addModels(acc, models, isLocalProvider) {
  if (!isPlainObject(models)) return;
  for (const [name, entry] of Object.entries(models)) {
    if (!isPlainObject(entry)) continue;
    const turns = count(entry.turns);
    if (turns === 0) continue;
    const provider = typeof entry.provider === 'string' ? entry.provider : '';
    if (isLocalProvider(provider)) acc.localTurns += turns;
    if (name === OTHER_MODEL) continue;
    const tokens = count(entry.total_tokens);
    const existing = acc.models.get(name);
    if (!existing) {
      acc.models.set(name, { provider, turns, total_tokens: tokens, topTurns: turns });
      continue;
    }
    existing.turns += turns;
    existing.total_tokens += tokens;
    // A model name normally has one provider; if it ever has two, show the
    // provider that carried the most turns in a single bucket.
    if (turns > existing.topTurns) {
      existing.topTurns = turns;
      existing.provider = provider;
    }
  }
}

function addBucket(acc, bucket, isLocalProvider) {
  acc.turns += count(bucket.turns);
  acc.input += count(bucket.input_tokens);
  acc.output += count(bucket.output_tokens);
  acc.total += count(bucket.total_tokens);
  acc.generationTokens += count(bucket.generation_tokens);
  acc.generationMs += num(bucket.generation_duration_ms);
  acc.estimatedTurns += count(bucket.estimated_turns);
  if (Array.isArray(bucket.hours)) {
    for (let hour = 0; hour < 24; hour += 1) acc.hours[hour] += count(bucket.hours[hour]);
  }
  addModels(acc, bucket.models, isLocalProvider);
}

function addDay(acc, key, day, isLocalProvider) {
  addBucket(acc, day, isLocalProvider);
  if (count(day.turns) > 0) acc.activeDays += 1;
  const total = count(day.total_tokens);
  if (
    total > 0
    && (!acc.busiest || total > acc.busiest.total_tokens
      || (total === acc.busiest.total_tokens && key > acc.busiest.date))
  ) {
    acc.busiest = { date: key, total_tokens: total, turns: count(day.turns) };
  }
}

function compareModels(left, right) {
  if (right.turns !== left.turns) return right.turns - left.turns;
  if (right.total_tokens !== left.total_tokens) return right.total_tokens - left.total_tokens;
  if (left.model < right.model) return -1;
  return left.model > right.model ? 1 : 0;
}

function peakHour(hours) {
  let best = -1;
  let bestCount = 0;
  for (let hour = 0; hour < 24; hour += 1) {
    if (hours[hour] > bestCount) {
      best = hour;
      bestCount = hours[hour];
    }
  }
  return best >= 0 ? best : null;
}

function finishRange(acc, from, to) {
  const ranked = [...acc.models.entries()]
    .map(([model, entry]) => ({
      model,
      provider: entry.provider,
      turns: entry.turns,
      total_tokens: entry.total_tokens,
    }))
    .sort(compareModels);
  const topModels = ranked.slice(0, TOP_MODEL_LIMIT).map((entry) => ({
    ...entry,
    share: ratio(entry.turns, acc.turns) ?? 0,
  }));
  const favorite = topModels[0];
  return {
    from,
    to,
    turns: acc.turns,
    input_tokens: acc.input,
    output_tokens: acc.output,
    total_tokens: acc.total,
    favorite_model: favorite
      ? {
        model: favorite.model,
        provider: favorite.provider,
        turns: favorite.turns,
        share: favorite.share,
      }
      : null,
    top_models: topModels,
    local_share: ratio(acc.localTurns, acc.turns),
    active_days: acc.activeDays,
    busiest_day: acc.busiest,
    peak_hour: acc.turns > 0 ? peakHour(acc.hours) : null,
    avg_tokens_per_second: acc.generationMs > 0
      ? round(acc.generationTokens / (acc.generationMs / 1000), 1)
      : null,
    estimated_share: ratio(acc.estimatedTurns, acc.turns),
  };
}

// 'YYYY-MM-DD' or any ISO timestamp -> local date key, '' when unparseable.
function toLocalDateKey(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (parseDateKey(text)) return text;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? '' : localDateKey(parsed);
}

function computeStreaks(activeKeys, todayKey) {
  const active = new Set(activeKeys);
  let cursor = active.has(todayKey) ? todayKey : shiftKey(todayKey, -1);
  let current = 0;
  while (cursor && active.has(cursor)) {
    current += 1;
    cursor = shiftKey(cursor, -1);
  }
  let longest = 0;
  let run = 0;
  let previous = '';
  for (const key of [...active].sort()) {
    run = previous && shiftKey(previous, 1) === key ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = key;
  }
  return { current, longest };
}

function buildHeatmap(days, today) {
  const cells = [];
  const start = addDays(today, -(HEATMAP_DAYS - 1));
  for (let offset = 0; offset < HEATMAP_DAYS; offset += 1) {
    const key = localDateKey(addDays(start, offset));
    const day = days.get(key);
    cells.push({
      date: key,
      total_tokens: day ? count(day.total_tokens) : 0,
      turns: day ? count(day.turns) : 0,
    });
  }
  return cells;
}

// computeUsageStats(rollup, { now, isLocalProvider }) -> the usage.getStats
// result (see docs/plans/HOME_USAGE_STATS_2026-11-01.md D2).
function computeUsageStats(rollup, { now = new Date(), isLocalProvider } = {}) {
  const clock = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const isLocal = typeof isLocalProvider === 'function'
    ? (provider) => {
      try { return isLocalProvider(provider) === true; } catch (_error) { return false; }
    }
    : defaultIsLocalProvider;
  const source = isPlainObject(rollup) ? rollup : {};
  const archived = isPlainObject(source.archived) ? source.archived : null;
  const today = new Date(clock.getFullYear(), clock.getMonth(), clock.getDate());
  const todayKey = localDateKey(today);

  const days = new Map();
  if (isPlainObject(source.days)) {
    for (const [key, day] of Object.entries(source.days)) {
      if (isPlainObject(day) && parseDateKey(key)) days.set(key, day);
    }
  }
  const dayKeys = [...days.keys()].sort();

  const archivedFrom = archived ? toLocalDateKey(archived.from) : '';
  const earliestKnown = [dayKeys[0], archivedFrom].filter(Boolean).sort()[0] || '';
  const since = toLocalDateKey(source.first_recorded_at) || earliestKnown || null;

  const ranges = {};
  for (const rangeKey of RANGE_KEYS) {
    const isAll = rangeKey === 'all';
    const from = isAll
      ? (since || todayKey)
      : localDateKey(addDays(today, -(RANGE_DAYS[rangeKey] - 1)));
    const acc = newAccumulator();
    for (const key of dayKeys) {
      if (isAll || (key >= from && key <= todayKey)) addDay(acc, key, days.get(key), isLocal);
    }
    if (isAll && archived) addBucket(acc, archived, isLocal);
    ranges[rangeKey] = finishRange(acc, from, todayKey);
  }

  const activeKeys = dayKeys.filter((key) => count(days.get(key).turns) > 0);
  return {
    since,
    ranges,
    streak: computeStreaks(activeKeys, todayKey),
    heatmap: buildHeatmap(days, today),
  };
}

module.exports = {
  HEATMAP_DAYS,
  RANGE_KEYS,
  computeUsageStats,
  defaultIsLocalProvider,
};
