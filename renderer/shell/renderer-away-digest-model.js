/* renderer/shell/renderer-away-digest-model.js -- "While you were away" model (UMD) */
/**
 * What finished while the person was not looking.
 *
 * The source is one page of the runtime snapshot: work summaries that reached
 * a terminal state, filtered against the device-local cursors the person set.
 * The model is where the digest's honesty rules live, so no view can break
 * them:
 *   - the outcome word comes from `status` and nothing else -- a summary row
 *     carries no failure reason, so none is invented;
 *   - "older than 30 days" is derived here from `updated_at` against an
 *     injected clock, never from a claim that compaction happened: the runtime
 *     compacts a settled terminal row's INPUT after that window
 *     (services/session-runtime/terminal-retention.js) and leaves the summary
 *     alone, so the view can only say Jenny MAY keep just the outcome;
 *   - a per-session cursor hides only work already seen in that chat, while
 *     the global cursor still applies to every row;
 *   - tokens are joined on demand through `tokensForStream`, re-projected out
 *     of the usage record so no dollar field can ride along;
 *   - a work id whose session is no longer listed says so instead of being
 *     titled by invention.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererAwayDigestModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  /* services/session-runtime/terminal-retention-contract.js RETENTION_MS. */
  var RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
  var TERMINAL_STATUSES = ['completed', 'failed', 'cancelled'];
  var IN_PROGRESS_STATUSES = ['pending', 'paused', 'running'];
  var TERMINAL = new Set(TERMINAL_STATUSES);
  var IN_PROGRESS = new Set(IN_PROGRESS_STATUSES);
  /* One screenful, not a history view: Home keeps its room. */
  var DEFAULT_ROW_LIMIT = 8;

  /* Chronological, never lexicographic: the store writes one ISO-8601 shape
   * today, but the projection accepts any parseable timestamp, and mixed
   * precision would sort wrong as strings. Unparseable input falls back to
   * the string order rather than throwing. */
  function isAfter(left, right) {
    var a = Date.parse(left);
    var b = Date.parse(right);
    if (Number.isNaN(a) || Number.isNaN(b)) return String(left) > String(right);
    return a > b;
  }

  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  function nonNegativeInt(value) {
    var parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  }

  function toMillis(value) {
    if (value instanceof Date) return value.valueOf();
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    var parsed = Date.parse(String(value == null ? '' : value));
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  function lookup(source, key) {
    if (!source || !key) return undefined;
    if (typeof source.get === 'function') return source.get(key);
    return Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined;
  }

  function buildSessionIndex(sessions) {
    var index = new Map();
    (Array.isArray(sessions) ? sessions : []).forEach(function addSession(summary) {
      if (!summary || typeof summary !== 'object') return;
      var id = text(summary.id);
      if (id && !index.has(id)) index.set(id, summary);
    });
    return index;
  }

  // Tokens are re-projected, never passed through: the usage record carries
  // `cost_usd` and `cost_source`, and this digest never shows money.
  function tokensForStream(usageByStream, streamId) {
    var record = lookup(usageByStream, streamId);
    if (!record || typeof record !== 'object') return null;
    var input = nonNegativeInt(record.input != null ? record.input : record.input_tokens);
    var output = nonNegativeInt(record.output != null ? record.output : record.output_tokens);
    return Object.freeze({ input: input, output: output });
  }

  /* Terminal rows only, newer than the cursor, first projection of a work id
   * wins. The snapshot already orders `updated_at` DESC then `work_id` ASC
   * (services/session-runtime/store.js), but a caller may hand over any page,
   * so the order is established here rather than assumed. */
  function collectRows(work, seenAt, seenBySession) {
    var rows = [];
    var seenIds = new Set();
    (Array.isArray(work) ? work : []).forEach(function addRow(summary) {
      if (!summary || typeof summary !== 'object') return;
      var workId = text(summary.work_id);
      var sessionId = text(summary.session_id);
      var updatedAt = text(summary.updated_at);
      if (!workId || !updatedAt || seenIds.has(workId) || !TERMINAL.has(summary.status)) return;
      // An equal instant is excluded: the cursor IS the newest row the person
      // already saw.
      if (seenAt && !isAfter(updatedAt, seenAt)) return;
      var sessionSeenAt = text(lookup(seenBySession, sessionId));
      if (sessionSeenAt && !isAfter(updatedAt, sessionSeenAt)) return;
      seenIds.add(workId);
      rows.push(summary);
    });
    return rows.sort(function newestFirst(left, right) {
      if (left.updated_at === right.updated_at) return left.work_id < right.work_id ? -1 : 1;
      return isAfter(left.updated_at, right.updated_at) ? -1 : 1;
    });
  }

  /**
   * Build the frozen "While you were away" view.
   *
   * @param {Object} [options]
   * @param {Array<Object>} [options.work] - One page of runtime work summaries
   * @param {string} [options.seenAt] - The "Mark all seen" cursor (ISO), or ''
   * @param {Map|Object} [options.seenBySession] - session_id -> seen cursor (ISO)
   * @param {number|Date|string} [options.now] - Injected clock for the 30-day derivation
   * @param {Array<Object>} [options.sessions] - Session summaries (state.sessions)
   * @param {number} [options.limit] - Positive row limit, or Infinity
   * @returns {Object} frozen Home widget model
   */
  function buildAwayDigest(options) {
    var input = options && typeof options === 'object' ? options : {};
    var sessionIndex = buildSessionIndex(input.sessions);
    var nowMs = toMillis(input.now);
    var page = Array.isArray(input.work) ? input.work : [];
    var matched = collectRows(page, text(input.seenAt), input.seenBySession);
    var limit = input.limit === Infinity
      ? Infinity
      : (typeof input.limit === 'number' && Number.isFinite(input.limit) && input.limit > 0
        ? input.limit
        : DEFAULT_ROW_LIMIT);
    var runningIds = new Set();
    var latestTerminalBySession = {};
    page.forEach(function inspect(summary) {
      if (!summary || typeof summary !== 'object') return;
      var workId = text(summary.work_id);
      if (workId && IN_PROGRESS.has(summary.status)) runningIds.add(workId);
      var sessionId = text(summary.session_id);
      var updatedAt = text(summary.updated_at);
      if (!sessionId || !updatedAt || !TERMINAL.has(summary.status)) return;
      if (!latestTerminalBySession[sessionId] || isAfter(updatedAt, latestTerminalBySession[sessionId])) {
        latestTerminalBySession[sessionId] = updatedAt;
      }
    });
    var outcomeBySession = {};
    matched.forEach(function indexOutcome(summary) {
      var sessionId = text(summary.session_id);
      if (sessionId && !Object.prototype.hasOwnProperty.call(outcomeBySession, sessionId)) {
        outcomeBySession[sessionId] = summary.status;
      }
    });
    var rows = matched.slice(0, limit).map(function project(summary) {
      var workId = text(summary.work_id);
      var sessionId = text(summary.session_id);
      var sessionSummary = sessionIndex.get(sessionId);
      var sessionGone = !sessionSummary;
      var finishedAt = text(summary.updated_at);
      return Object.freeze({
        key: 'work:' + workId,
        workId: workId,
        sessionId: sessionId,
        // A session id is not a name anyone recognizes: an untitled chat says
        // so, and a chat the summaries no longer list says THAT, because the
        // work outlived the conversation it ran in.
        sessionTitle: sessionGone
          ? jt('chat.awayDigest.deletedSession', 'Chat deleted')
          : (text(sessionSummary.title) || jt('chat.awayDigest.untitledSession', 'Untitled chat')),
        sessionGone: sessionGone,
        outcome: summary.status,
        startedAt: text(summary.created_at),
        finishedAt: finishedAt,
        olderThanRetention: nowMs - Date.parse(finishedAt) > RETENTION_MS,
      });
    });
    return Object.freeze({
      rows: Object.freeze(rows),
      // Everything the page carried that is newer than the cursor, not just
      // the rows on screen: the header says how much finished, and the list
      // says which of it fits.
      unseenCount: matched.length,
      // The cursor "Mark all seen" would write: the newest row displayed.
      newestAt: rows.length ? rows[0].finishedAt : '',
      hidden: rows.length === 0,
      truncated: matched.length > rows.length,
      runningCount: runningIds.size,
      outcomeBySession: Object.freeze(outcomeBySession),
      latestTerminalBySession: Object.freeze(latestTerminalBySession),
    });
  }

  return {
    buildAwayDigest: buildAwayDigest,
    tokensForStream: tokensForStream,
    RETENTION_MS: RETENTION_MS,
    TERMINAL_STATUSES: Object.freeze(TERMINAL_STATUSES.slice()),
    IN_PROGRESS_STATUSES: Object.freeze(IN_PROGRESS_STATUSES.slice()),
    DEFAULT_ROW_LIMIT: DEFAULT_ROW_LIMIT,
  };
});
