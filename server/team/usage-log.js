'use strict';

// The team engine usage log (row 123, slice 4b; node protocol spec "Team engine
// (N10)"): team-pool-usage.json, schema 1, read with a 4 MiB cap and written
// through `services/host/durable-json.js`. The strict load, the bounds and
// `floor_seq` are the shared mechanics in `bounded-log.js`.
//
// One row per team engine request that held a lease: the member, the time, the
// leased model id, the serving node, prompt and completion tokens (null when the
// stream carried no usage), the duration and a closed outcome with a reason code.
// No field can hold a prompt, a reply, a tool call, a header value or free text:
// every value is an id, a count, a model id from the pool, or a lower-case code.
//
// The host promised to record usage: a store that cannot be loaded answers
// `pool_usage_store_failed` (unreadable, over the cap, a bad row) or
// `pool_schema_unsupported` (another schema version) from status(), and the
// engine route refuses. A broken file is never rewritten. A passing read failure
// (a busy or locked file) answers `pool_usage_store_failed` for that call only.
// A failed write answers `pool_usage_store_failed`, drops the held document (the
// write may have landed) and degrades the log: status() then answers
// `pool_usage_store_failed` too, re-reading the file and re-attempting its durable
// write at most once a second, so a disk that comes back heals without a restart. The row
// whose write failed is lost unless the write landed (the caller counts it).

const { hostFailure } = require('../api-contract');
const {
  BoundedLogFile, boundLogDocument, emptyLogDocument, validLogDocument,
} = require('./bounded-log');
const { isId } = require('./ids');
const { hasExactKeys, isCount, isPlainObject } = require('./member-schema');
const { isNodeId, isPrintable } = require('./scheduler/state');

const USAGE_LOG_FILE = 'team-pool-usage.json';
// While degraded, status() tries to heal at most once in this many ms.
const HEAL_INTERVAL_MS = 1000;
const USAGE_LOG_SCHEMA_VERSION = 1;
const USAGE_LOG_LIMITS = Object.freeze({
  MAX_ENTRIES: 10_000,
  MAX_BYTES: 4 * 1024 * 1024,
  MAX_MODEL_ID_CHARS: 128, // the scheduler's maxModelIdLength
  // R16-F03: the most one count may be (8 digits). The engine route clamps a node's counts to the request
  // and reply bytes (at most 8 MiB and 32 MiB); a count above this is stored and read as no count, so a
  // row written before that clamp cannot push a total past what the owner's page reads.
  MAX_ROW_TOKENS: 64 * 1024 * 1024,
  MAX_TOTALS: 64, // members in one read's totals, the busiest first (the member side's own bound)
});
const OUTCOMES = Object.freeze(['completed', 'cancelled', 'failed']);
const ENTRY_KEYS = Object.freeze(['seq', 'at', 'member_id', 'model', 'node_id', 'prompt_tokens',
  'completion_tokens', 'duration_ms', 'outcome', 'reason']);
const INPUT_KEYS = Object.freeze(ENTRY_KEYS.filter((key) => key !== 'seq' && key !== 'at'));
// A reason code: the one pattern for a reason in a row, a log line or an engine error body.
const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

const countOrNull = (value) => value === null || isCount(value);
// A count within the row bound, else null (no count).
const boundedCount = (value) => (isCount(value) && value <= USAGE_LOG_LIMITS.MAX_ROW_TOKENS ? value : null);

function validEntry(entry) {
  if (!isPlainObject(entry) || !hasExactKeys(entry, ENTRY_KEYS)) return false;
  if (!Number.isSafeInteger(entry.seq) || entry.seq < 1 || !isCount(entry.at)) return false;
  if (!isId('member', entry.member_id) || !isPrintable(entry.model, USAGE_LOG_LIMITS.MAX_MODEL_ID_CHARS)) return false;
  if (!(entry.node_id === null || isNodeId(entry.node_id))) return false;
  if (!countOrNull(entry.prompt_tokens) || !countOrNull(entry.completion_tokens) || !isCount(entry.duration_ms)) return false;
  if (!OUTCOMES.includes(entry.outcome)) return false;
  // A completed request has no reason; any other outcome names one.
  return entry.outcome === 'completed'
    ? entry.reason === null : typeof entry.reason === 'string' && REASON_PATTERN.test(entry.reason);
}

function failure(reason) {
  return hostFailure('persistence', reason);
}

class UsageLog {
  constructor({
    filePath, clock = Date.now, logger = null, assertSafePath = null, readJson, writeJson,
  } = {}) {
    if (typeof filePath !== 'string' || filePath.length === 0) throw new TypeError('UsageLog requires a filePath.');
    this._clock = clock;
    this._degraded = false; // the last write failed
    this._healAttemptAt = null; // when a degraded status() last tried to heal
    // Why the load failed: set by parse for a schema the store does not know.
    this._brokenReason = 'pool_usage_store_failed';
    this._file = new BoundedLogFile({
      filePath,
      readCapBytes: USAGE_LOG_LIMITS.MAX_BYTES,
      parse: (stored) => this._parse(stored),
      emptyDocument: () => emptyLogDocument(USAGE_LOG_SCHEMA_VERSION),
      events: { rejected: 'team_pool_usage.rejected', writeFailed: 'team_pool_usage.write_failed' },
      logger,
      assertSafePath,
      readJson,
      writeJson,
    });
  }

  _parse(stored) {
    if (isPlainObject(stored) && stored.schema_version !== USAGE_LOG_SCHEMA_VERSION) {
      this._brokenReason = 'pool_schema_unsupported';
      return null;
    }
    return validLogDocument(stored, {
      schemaVersion: USAGE_LOG_SCHEMA_VERSION, maxEntries: USAGE_LOG_LIMITS.MAX_ENTRIES, validEntry,
    }) ? stored : null;
  }

  // At host start (E46's rule for this log, slice 3-4b): a file refused for its content is renamed
  // aside with the shared stamp and a fresh log starts; a newer schema, an unsafe path, an OS refusal
  // and a busy file stay as they are. Answers { setAside, keptName }; never throws.
  openAtStart() {
    this._file.load();
    if (this._file.refusal() !== 'content') return { setAside: false, keptName: null };
    const moved = this._file.setAside({ now: this._clock() });
    if (!moved.ok) return { setAside: false, keptName: null };
    this._brokenReason = 'pool_usage_store_failed';
    return { setAside: true, keptName: moved.keptName };
  }

  // { ok: true } when the store is loaded and its last write landed, else its
  // persistence failure. While degraded it re-reads and re-writes the file at
  // most once a second by the clock (on every call when the clock gives no time
  // or has gone back past the last try) and otherwise answers the failure with
  // no file IO.
  status() {
    if (this._degraded) {
      const now = this._clock();
      const since = isCount(now) && this._healAttemptAt !== null ? now - this._healAttemptAt : null;
      if (since !== null && since >= 0 && since < HEAL_INTERVAL_MS) {
        return failure('pool_usage_store_failed');
      }
      this._healAttemptAt = isCount(now) ? now : null;
    }
    const doc = this._file.load();
    if (!doc) return failure(this._brokenReason);
    if (this._degraded) {
      if (!this._file.persist(doc)) return failure('pool_usage_store_failed');
      this._degraded = false;
    }
    return { ok: true };
  }

  // The owner's read (slice 4e), which never writes. One window for everything it answers: the rows
  // at or after `since`, or within the last `windowMs` of the log's own clock. Totals per member
  // (requests, and tokens where the node sent a count), and a page of those rows newest first, older
  // than `cursor` (a row's seq; null or 0 for the newest), at most `limit`. `next_cursor` is the last
  // row's seq while older rows of the window remain, so rows appended meanwhile never shift a page. A
  // degraded or refused log answers its persistence failure, never an empty list.
  // R16-F03: a count past MAX_ROW_TOKENS reads as no count, at most MAX_TOTALS members are totalled (the
  // busiest), and every row says its count was reported by the serving hardware (`reported_by: 'node'`).
  read({ cursor = null, limit = 20, since = 0, windowMs = null } = {}) {
    if (this._degraded) return failure('pool_usage_store_failed');
    const doc = this._file.load();
    if (!doc) return failure(this._brokenReason);
    if (windowMs !== null) {
      const now = this._clock();
      if (!isCount(now) || !isCount(windowMs)) return failure('pool_usage_store_failed');
      since = now - windowMs;
    }
    const tokensOf = (entry) => {
      const prompt = boundedCount(entry.prompt_tokens);
      const completion = boundedCount(entry.completion_tokens);
      return prompt === null && completion === null ? null : (prompt ?? 0) + (completion ?? 0);
    };
    const totals = new Map();
    for (const entry of doc.entries) {
      if (entry.at < since) continue;
      const seen = totals.get(entry.member_id) || { member_id: entry.member_id, requests: 0, tokens: 0 };
      seen.requests += 1;
      seen.tokens += tokensOf(entry) ?? 0;
      totals.set(entry.member_id, seen);
    }
    const max = Number.isSafeInteger(limit) && limit >= 1 ? Math.min(limit, 50) : 20;
    const before = Number.isSafeInteger(cursor) && cursor > 0 ? cursor : Infinity;
    const older = doc.entries.filter((entry) => entry.seq < before && entry.at >= since).reverse();
    const rows = older.slice(0, max).map((entry) => ({ seq: entry.seq, at: entry.at, member_id: entry.member_id,
      model: entry.model, node_id: entry.node_id, tokens: tokensOf(entry), duration_ms: entry.duration_ms,
      reported_by: 'node' }));
    const ranked = [...totals.values()].sort((a, b) => b.requests - a.requests || (a.member_id < b.member_id ? -1 : 1));
    return { ok: true, totals: ranked.slice(0, USAGE_LOG_LIMITS.MAX_TOTALS),
      rows, next_cursor: older.length > max ? rows[rows.length - 1].seq : null };
  }

  // Appends one row in one durable write. Throws a TypeError for a row outside the
  // closed shape (a caller bug); answers a persistence failure when the store is
  // broken, the clock gives no time or the write fails.
  append(input) {
    if (!isPlainObject(input) || !Object.keys(input).every((key) => INPUT_KEYS.includes(key))) {
      throw new TypeError('Invalid usage row.');
    }
    const doc = this._file.load();
    if (!doc) return failure(this._brokenReason);
    const at = this._clock();
    if (!isCount(at)) return failure('pool_usage_store_failed');
    const entry = { seq: doc.next_seq, at };
    for (const key of INPUT_KEYS) entry[key] = input[key] ?? null;
    if (!validEntry(entry)) throw new TypeError('Invalid usage row.');
    // R16-F03: a count past the row bound is stored as no count.
    entry.prompt_tokens = boundedCount(entry.prompt_tokens);
    entry.completion_tokens = boundedCount(entry.completion_tokens);
    const candidate = boundLogDocument({
      schema_version: USAGE_LOG_SCHEMA_VERSION,
      floor_seq: doc.floor_seq,
      next_seq: entry.seq + 1,
      entries: [...doc.entries, entry],
    }, { maxEntries: USAGE_LOG_LIMITS.MAX_ENTRIES, maxBytes: USAGE_LOG_LIMITS.MAX_BYTES });
    this._degraded = !this._file.persist(candidate);
    if (this._degraded) {
      this._healAttemptAt = null;
      return failure('pool_usage_store_failed');
    }
    return { ok: true, seq: entry.seq };
  }
}

module.exports = { REASON_PATTERN, USAGE_LOG_FILE, USAGE_LOG_LIMITS, USAGE_LOG_SCHEMA_VERSION, UsageLog };
