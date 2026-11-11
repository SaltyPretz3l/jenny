'use strict';

/* services/chat-messaging-mail-turns.js - the turns that took queued mail from another chat (row 87),
 * newest 256, in memory only. Each turn also keeps whether every row it took is a terminal report
 * from a chat its own chat started (row 76, owner 2026-11-10: such a turn may spend the Jenny chat's
 * standing launch permission). That flag is sticky false: once other mail joins a turn, later reports
 * do not clear it. An unreadable summary counts as foreign mail. Never throws.
 */

const MAX_TRACKED_TURNS = 256;

function createMailTurns({ getSessionSummary = () => null, limit = MAX_TRACKED_TURNS } = {}) {
  const turns = new Map(); // turn id -> true when every row so far is an own child's report

  function isOwnChildReport(envelope) {
    if (envelope?.kind !== 'terminal_report' || typeof envelope.source_session_id !== 'string') return false;
    let parent;
    try {
      parent = getSessionSummary(envelope.source_session_id)?.spawned_from?.parent_session_id;
    } catch {
      return false;
    }
    return typeof parent === 'string' && parent !== '' && parent === envelope.destination_session_id;
  }

  function note(turnId, rows = []) {
    if (typeof turnId !== 'string' || !turnId) return;
    const own = turns.get(turnId) !== false && Array.isArray(rows) && rows.length > 0
      && rows.every((row) => isOwnChildReport(row?.session_message));
    turns.delete(turnId);
    turns.set(turnId, own);
    while (turns.size > limit) turns.delete(turns.keys().next().value);
  }

  return {
    note,
    has: (turnId) => typeof turnId === 'string' && turns.has(turnId),
    ownChildReports: (turnId) => typeof turnId === 'string' && turns.get(turnId) === true,
    get size() { return turns.size; },
  };
}

module.exports = { MAX_TRACKED_TURNS, createMailTurns };
