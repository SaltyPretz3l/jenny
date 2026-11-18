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
 *     titled by invention;
 *   - a Team turn (row 175 F10, from renderer-team-notify.js `attention()`) joins
 *     the same list by time, named `Team · <project>`, under the same cursors. It is
 *     a finished or a failed turn of this member's own, never a message's text; it
 *     has no work id, so no tokens and no "started" line.
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
  var USAGE_LIMIT = 200;

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

  /* The Team notifier's finished and failed turns, as rows: read at the call (`options.team`, else the notifier's accessor). */
  function teamNotices(option) {
    var source = option !== undefined ? option : (globalThis.rendererTeamNotify && typeof globalThis.rendererTeamNotify.attention === 'function'
      ? globalThis.rendererTeamNotify.attention() : null);
    return source && Array.isArray(source.notices) ? source.notices : [];
  }

  function teamRows(notices, seenAt, seenBySession) {
    var rows = [];
    notices.forEach(function addNotice(notice) {
      if (!notice || (notice.notice !== 'finished' && notice.notice !== 'failed') || !text(notice.sessionId) || !text(notice.id)) return;
      var at = Number(notice.at);
      if (!Number.isFinite(at)) return;
      var finishedAt = new Date(at).toISOString();
      var sessionSeenAt = text(lookup(seenBySession, text(notice.sessionId)));
      if ((seenAt && !isAfter(finishedAt, seenAt)) || (sessionSeenAt && !isAfter(finishedAt, sessionSeenAt))) return;
      var where = text(notice.where);
      rows.push(Object.freeze({
        key: 'team:' + text(notice.teamId) + ':' + text(notice.id),
        team: true,
        teamId: text(notice.teamId),
        projectId: text(notice.projectId),
        workId: '',
        sessionId: text(notice.sessionId),
        sessionTitle: text(notice.title) || jt('team.notify.projectUntitled', 'A project conversation'),
        marker: where ? jt('team.home.marker', 'Team · {project}', { project: where }) : jt('team.home.markerBare', 'Team'),
        sessionGone: false,
        outcome: notice.notice === 'failed' ? 'failed' : 'completed',
        startedAt: '',
        finishedAt: finishedAt,
        olderThanRetention: false,
      }));
    });
    return rows;
  }

  /* A Team turn opens its conversation in the Team tab, by the intent a toast's click runs. */
  function openTeamConversation(row) {
    var notify = globalThis.rendererTeamNotify;
    if (!row || !notify || typeof notify.request !== 'function') return false;
    return notify.request({ kind: 'conversation', teamId: row.teamId, projectId: row.projectId || '', sessionId: row.sessionId }) === true;
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

  // A session id is not a name anyone recognizes: an untitled chat says so,
  // and a chat the summaries no longer list says THAT, because the work
  // outlived the conversation it ran in. Exported so the Jenny chat's away
  // facts (services/primary-away-facts.js) use the same wording.
  function sessionTitleFor(sessionSummary) {
    if (!sessionSummary) return jt('chat.awayDigest.deletedSession', 'Chat deleted');
    return text(sessionSummary.title) || jt('chat.awayDigest.untitledSession', 'Untitled chat');
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

  /* The tokens of a finished row, joined on demand: the work's stream id, then the usage record of that stream. One page of
   * usage is read once and kept; a failed read is dropped by `retry()` (the next arrival read) so it can be tried again. A
   * failure is logged once per work id and never throws: a row without tokens simply shows none. */
  function createTokenReader(deps) {
    var runtimeBridge = deps.runtimeBridge;
    var usageBridge = deps.usageBridge;
    var log = deps.log;
    var usagePromise = null;
    var workStreamPromises = new Map();
    var tokenValues = new Map();
    var tokenWarnings = new Set();
    var usageFailed = false;
    var disposed = false;

    function warnTokens(workId, error) {
      if (tokenWarnings.has(workId)) return;
      tokenWarnings.add(workId);
      log('WARN', 'chat.away_digest_tokens_failed', {
        workId: workId,
        message: String(error && error.message || error || ''),
      });
    }

    function readWorkStream(workId) {
      if (workStreamPromises.has(workId)) return workStreamPromises.get(workId);
      var runtime = runtimeBridge();
      if (!runtime || typeof runtime.getWork !== 'function') {
        warnTokens(workId, new Error('runtime_work_unavailable'));
        var missing = Promise.resolve(null);
        workStreamPromises.set(workId, missing);
        return missing;
      }
      var promise = Promise.resolve().then(function readWork() {
        return runtime.getWork({ work_id: workId });
      }).then(function workResult(result) {
        var streamId = result && result.ok === true && result.work && result.work.attempt
          ? String(result.work.attempt.stream_id || '') : '';
        if (!streamId) throw new Error(String(result && result.error || 'runtime_work_refused'));
        return streamId;
      }).catch(function workError(error) {
        warnTokens(workId, error);
        return null;
      });
      workStreamPromises.set(workId, promise);
      return promise;
    }

    function readUsage() {
      if (usagePromise) return usagePromise;
      var usage = usageBridge();
      if (!usage || typeof usage.getSnapshot !== 'function') return Promise.reject(new Error('usage_bridge_unavailable'));
      usagePromise = Promise.resolve().then(function readUsagePage() {
        return usage.getSnapshot({ limit: USAGE_LIMIT });
      }).then(function usageResult(result) {
        if (!result || !Array.isArray(result.recent_turns)) throw new Error('usage_snapshot_refused');
        var byStream = new Map();
        result.recent_turns.forEach(function index(record) {
          var streamId = String(record && record.stream_id || '');
          if (streamId && !byStream.has(streamId)) byStream.set(streamId, record);
        });
        return byStream;
      }).catch(function usageError(error) {
        usageFailed = true; // retained until the next arrival read
        throw error;
      });
      return usagePromise;
    }

    function readTokens(row) {
      if (disposed || !row || !row.workId) return Promise.resolve(null);
      var workId = String(row.workId);
      if (tokenValues.has(workId)) return Promise.resolve(tokenValues.get(workId));
      return readWorkStream(workId).then(function withStream(streamId) {
        if (!streamId) return null;
        return readUsage().then(function withUsage(usageByStream) {
          var tokens = usageByStream ? tokensForStream(usageByStream, streamId) : null;
          tokenValues.set(workId, tokens);
          return tokens;
        }).catch(function tokensError(error) {
          warnTokens(workId, error);
          return null;
        });
      });
    }

    function retry() {
      if (usageFailed) { usagePromise = null; usageFailed = false; }
    }

    function dispose() {
      disposed = true;
      usagePromise = null;
      workStreamPromises.clear();
      tokenValues.clear();
      tokenWarnings.clear();
    }

    return { readTokens: readTokens, retry: retry, dispose: dispose };
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
   * @param {Object|null} [options.team] - The Team notifier's `attention()` (default: read from it when loaded)
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
    var localRows = matched.map(function project(summary) {
      var workId = text(summary.work_id);
      var sessionId = text(summary.session_id);
      var sessionSummary = sessionIndex.get(sessionId);
      var sessionGone = !sessionSummary;
      var finishedAt = text(summary.updated_at);
      return Object.freeze({
        key: 'work:' + workId,
        workId: workId,
        sessionId: sessionId,
        sessionTitle: sessionTitleFor(sessionSummary),
        sessionGone: sessionGone,
        outcome: summary.status,
        startedAt: text(summary.created_at),
        finishedAt: finishedAt,
        olderThanRetention: nowMs - Date.parse(finishedAt) > RETENTION_MS,
      });
    });
    // Team turns interleave by time, newest first; at one instant the local row leads (the sort is stable).
    var all = localRows.concat(teamRows(teamNotices(input.team), text(input.seenAt), input.seenBySession))
      .sort(function newestFirstAll(left, right) {
        if (isAfter(left.finishedAt, right.finishedAt)) return -1;
        return isAfter(right.finishedAt, left.finishedAt) ? 1 : 0;
      });
    var rows = all.slice(0, limit);
    return Object.freeze({
      rows: Object.freeze(rows),
      // Everything the page carried that is newer than the cursor, not just
      // the rows on screen: the header says how much finished, and the list
      // says which of it fits.
      unseenCount: all.length,
      // The cursor "Mark all seen" would write: the newest row displayed.
      newestAt: rows.length ? rows[0].finishedAt : '',
      hidden: rows.length === 0,
      truncated: all.length > rows.length,
      runningCount: runningIds.size,
      outcomeBySession: Object.freeze(outcomeBySession),
      latestTerminalBySession: Object.freeze(latestTerminalBySession),
    });
  }

  /* Settle re-reads. A run that settles while Home or the Chats panel is on
   * screen re-reads the digest page: no chrome pass marks that moment, so the
   * digest would keep the snapshot taken on arrival.
   *   - A burst of settles is one read. A read already in flight was requested
   *     before the settle, so `read` waits it out instead of joining it.
   *   - The renderer hears a run end before the runtime row turns terminal
   *     (services/session-runtime/scheduler.js settles after the producer
   *     resolves), so a bounded backoff re-reads until each settled session
   *     shows a newer terminal row, then stops.
   *   - Off screen nothing is read: the next arrival reads.
   * Seen cursors are not touched here; the reader's own read path owns them. */
  var SETTLE_READ_DELAYS_MS = [250, 1000, 3000];

  /**
   * @param {{windowRef: object, documentRef: ?object, onScreen: Function,
   *   digest: Function, read: Function}} deps
   *   `digest` returns the published digest; `read` re-reads its page.
   *   `onScreen` says whether Home or the Chats panel is up; a hidden
   *   document is off screen whatever it says.
   * @returns {{note: Function, dispose: Function}}
   */
  function createSettleReads(deps) {
    var windowRef = deps.windowRef;
    var timer = null;
    var attempt = 0;
    var settling = {}; // session id -> its latest terminal instant when its run settled
    var disposed = false;

    function onScreen() {
      var documentRef = deps.documentRef;
      return !(documentRef && documentRef.visibilityState === 'hidden') && Boolean(deps.onScreen());
    }

    function latestTerminal(sessionId) {
      return deps.digest().latestTerminalBySession[sessionId] || '';
    }

    function check() {
      if (disposed) return;
      Object.keys(settling).forEach(function landed(sessionId) {
        var latest = latestTerminal(sessionId);
        if (latest && (!settling[sessionId] || isAfter(latest, settling[sessionId]))) delete settling[sessionId];
      });
      if (timer !== null) return; // a newer settle already armed the next read
      attempt += 1;
      if (Object.keys(settling).length && attempt < SETTLE_READ_DELAYS_MS.length && onScreen()) arm();
      else { settling = {}; attempt = 0; }
    }

    function arm() {
      if (timer !== null) return;
      timer = windowRef.setTimeout(function readSettled() {
        timer = null;
        Promise.resolve().then(deps.read).then(check, check);
      }, SETTLE_READ_DELAYS_MS[attempt]);
    }

    function note(event) {
      if (disposed || !onScreen()) return;
      var sessionId = String(event && event.payload && event.payload.sessionId || '').trim();
      if (sessionId && !Object.prototype.hasOwnProperty.call(settling, sessionId)) settling[sessionId] = latestTerminal(sessionId);
      attempt = 0;
      arm();
    }

    function dispose() {
      disposed = true;
      if (timer !== null) windowRef.clearTimeout(timer);
      timer = null;
      settling = {};
    }

    return { note: note, dispose: dispose };
  }

  return {
    buildAwayDigest: buildAwayDigest,
    tokensForStream: tokensForStream,
    createTokenReader: createTokenReader,
    openTeamConversation: openTeamConversation,
    sessionTitleFor: sessionTitleFor,
    isAfter: isAfter,
    createSettleReads: createSettleReads,
    RETENTION_MS: RETENTION_MS,
    TERMINAL_STATUSES: Object.freeze(TERMINAL_STATUSES.slice()),
    IN_PROGRESS_STATUSES: Object.freeze(IN_PROGRESS_STATUSES.slice()),
    DEFAULT_ROW_LIMIT: DEFAULT_ROW_LIMIT,
  };
});
