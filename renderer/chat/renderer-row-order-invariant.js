/* renderer/chat/renderer-row-order-invariant.js
 * Row-order invariant: the rows a turn shows must keep the canonical event order.
 *
 * The projector sorts a turn's rows by their events (event_seq), so every row
 * list it builds is in canonical order. The DOM is a different matter: the
 * render lanes morph and reconcile rows in place, and a reused node is never
 * re-sorted. On 2026-10-25 a settled turn (after an error-card Retry) showed
 * its answer above its reasoning and tool rows for minutes, and no replay of
 * the persisted data reproduced it. This check reads the painted DOM after a
 * full render or a settle and names any row list whose order disagrees with
 * the session's canonical turn events, so the next occurrence records itself.
 *
 * Read-only telemetry: it never changes the DOM, and a failure inside it is
 * swallowed so a paint can never break on it.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererRowOrderInvariant = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ROW_SELECTOR = '.chat-row[data-row-kind]';
  const ROW_LIST_SELECTOR = '[data-turn-row-list]';
  const TURN_SELECTOR = '[data-turn-id]';
  const MAX_ORDER_ENTRIES = 24;
  const MAX_VIOLATIONS_PER_CHECK = 4;

  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  // Keyed by the stored turnEvents array: the session store replaces that array
  // whenever the events change, so a cached index is never stale.
  const indexCache = new WeakMap();

  // event_id -> event_seq. event_seq is session-wide and monotonic, so one index
  // serves every turn, and rows of another session (a second pane) stay unranked.
  function buildCanonicalRankIndex(turnEvents) {
    const events = Array.isArray(turnEvents) ? turnEvents : [];
    const cached = indexCache.get(events);
    if (cached) return cached;
    const seqByEventId = new Map();
    for (const event of events) {
      const seq = Number(event && event.event_seq);
      const eventId = text(event && event.event_id);
      if (eventId && Number.isFinite(seq)) seqByEventId.set(eventId, seq);
    }
    indexCache.set(events, seqByEventId);
    return seqByEventId;
  }

  // A row's rank is the seq of the event the projector sorted it by (its first
  // source event, painted as data-source-event-id). A row whose event is not
  // canonical yet (a live row before its turn persists) is skipped.
  function rankRow(rowEl, index) {
    const eventId = text(rowEl.getAttribute('data-source-event-id'));
    return eventId && index.has(eventId) ? index.get(eventId) : null;
  }

  function idTail(value) {
    const id = text(value);
    return id.length > 24 ? id.slice(-24) : id;
  }

  function describeRow(row) {
    return { kind: row.kind, rank: row.rank, rowId: idTail(row.rowId) };
  }

  // A turn's rows can sit in several row lists, each in its own message article
  // carrying the turn's data-turn-id, so rows are grouped by that id. A group is
  // one contiguous run in document order: the same session open in two panes
  // paints the turn twice, and each copy is checked on its own. A row outside
  // any turn article is grouped by its own row list.
  function groupRankedRowsByTurn(rootEl, index) {
    const groups = [];
    let current = null;
    for (const rowEl of rootEl.querySelectorAll(ROW_SELECTOR)) {
      const turnEl = rowEl.closest(TURN_SELECTOR);
      const owner = turnEl ? text(turnEl.getAttribute('data-turn-id')) : rowEl.closest(ROW_LIST_SELECTOR);
      if (!owner) continue;
      const rank = rankRow(rowEl, index);
      if (rank === null) continue;
      if (!current || current.owner !== owner) {
        current = { owner, turnId: turnEl ? owner : '', rows: [] };
        groups.push(current);
      }
      current.rows.push({ kind: text(rowEl.getAttribute('data-row-kind')), rank, rowId: rowEl.getAttribute('data-row-id') });
    }
    return groups;
  }

  function checkTurnRows(turnId, rows) {
    let maxRow = null;
    let inversion = null;
    for (const row of rows) {
      if (maxRow && row.rank < maxRow.rank) {
        inversion = { before: describeRow(maxRow), after: describeRow(row) };
        break;
      }
      if (!maxRow || row.rank > maxRow.rank) maxRow = row;
    }
    if (!inversion) return null;
    const order = rows.slice(0, MAX_ORDER_ENTRIES).map((row) => `${row.kind}:${row.rank}`).join(' ');
    return {
      turnId: turnId.slice(0, 40),
      rowCount: rows.length,
      order: rows.length > MAX_ORDER_ENTRIES ? `${order} …` : order,
      inversion,
    };
  }

  // Pure core: every turn under `rootEl` checked against `turnEvents`.
  function findRowOrderViolations(rootEl, turnEvents) {
    if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return [];
    const index = buildCanonicalRankIndex(turnEvents);
    if (index.size === 0) return [];
    const violations = [];
    for (const group of groupRankedRowsByTurn(rootEl, index)) {
      const violation = checkTurnRows(group.turnId, group.rows);
      if (violation) violations.push(violation);
      if (violations.length >= MAX_VIOLATIONS_PER_CHECK) break;
    }
    return violations;
  }

  // Scheduler: one check per session per paint, after the paint, however many
  // writes asked for it. `reason` keeps the first trigger of the batch.
  function createRowOrderInvariant(deps = {}) {
    const {
      getRoot = () => (typeof document !== 'undefined' ? document : null),
      getTurnEvents = () => [],
      recordSignal = () => {},
      appendClientLog = () => {},
      requestFrame = (typeof requestAnimationFrame === 'function'
        ? (fn) => requestAnimationFrame(fn)
        : (fn) => setTimeout(fn, 16)),
    } = deps;
    const pending = new Map();

    function runCheck(sessionId, reason) {
      try {
        const violations = findRowOrderViolations(getRoot(), getTurnEvents(sessionId));
        for (const violation of violations) {
          recordSignal(sessionId, 'row_order_violation', { reason, ...violation });
        }
        return violations;
      } catch (error) {
        try {
          appendClientLog('WARN', 'chat_timeline.row_order_check_failed', {
            sessionId,
            message: String(error?.message || error).slice(0, 200),
          });
        } catch {
          // Telemetry about telemetry: nothing more to do.
        }
        return [];
      }
    }

    function schedule(sessionId, reason) {
      const normalizedSessionId = text(sessionId);
      if (!normalizedSessionId || pending.has(normalizedSessionId)) return;
      pending.set(normalizedSessionId, text(reason) || 'unknown');
      // A frame lets the write paint; the timeout runs after the frame's other
      // post-paint work (virtualizer restore, reveal) so the check sees its result.
      requestFrame(() => setTimeout(() => {
        const queuedReason = pending.get(normalizedSessionId);
        pending.delete(normalizedSessionId);
        runCheck(normalizedSessionId, queuedReason);
      }, 0));
    }

    return { schedule, runCheck };
  }

  return {
    buildCanonicalRankIndex,
    findRowOrderViolations,
    createRowOrderInvariant,
  };
});
