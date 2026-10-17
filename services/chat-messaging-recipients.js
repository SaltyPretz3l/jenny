'use strict';

/* services/chat-messaging-recipients.js - the `chatMessages.listRecipients`
 * projection and the shared "current chat reference" projection (row 59
 * checkpoint 4). Pure over injected session summaries: profile-wide, self and
 * plugin chats excluded, archived / non-continuable chats listed but ineligible,
 * deleted chats never listed. Titles and project names are untrusted and bounded
 * to 512 UTF-8 bytes; no path or transcript content is ever projected.
 */

const { sha256Hex } = require('./backend/chat-proposal-records');
const { boundText, decodeCursor, encodeCursor } = require('./chat-messaging-contract');

const PLUGIN_SESSION_TYPE = 'plugin';

function projectLabel(summary, getProjectName) {
  const projectId = typeof summary?.project_id === 'string' && summary.project_id ? summary.project_id : null;
  let name = null;
  if (projectId) {
    try { name = getProjectName(projectId); } catch { name = null; }
  }
  return { project_id: projectId, project_name: typeof name === 'string' && name ? boundText(name) : null };
}

// The current title / project of a chat, or `{available:false}` for a deleted one.
// Navigation projects live metadata; envelopes never snapshot a title.
function projectSessionRef(sessionId, summary, getProjectName) {
  if (!summary) {
    return { session_id: sessionId, available: false, title: null, project_id: null, project_name: null };
  }
  return {
    session_id: sessionId,
    available: true,
    title: boundText(summary.title),
    ...projectLabel(summary, getProjectName),
  };
}

function ineligibleReason(summary, isContinuable) {
  if (summary.archived_at) return 'archived';
  try {
    return isContinuable(summary) === false ? 'not_continuable' : null;
  } catch {
    return 'not_continuable';
  }
}

// -> {ok:true, items, next_cursor, revision} | {ok:false, reason}
// `grantFor(summary)` -> null | {grant_id, purpose, expires_at, remaining_sends}: the calling source's live
// directional grant to that chat (the send modal shows and revokes it).
function listRecipients({
  summaries, sourceSessionId, query = '', cursor = null, limit, getProjectName = () => null,
  isContinuable = () => true, grantFor = () => null,
}) {
  const needle = String(query || '').toLowerCase();
  const rows = [];
  for (const summary of summaries || []) {
    const id = String(summary?.id || '');
    if (!id || id === sourceSessionId || String(summary.session_type || '').toLowerCase() === PLUGIN_SESSION_TYPE) continue;
    const project = projectLabel(summary, getProjectName);
    const title = boundText(summary.title);
    if (needle && !title.toLowerCase().includes(needle)
      && !String(project.project_name || '').toLowerCase().includes(needle)) continue;
    const reason = ineligibleReason(summary, isContinuable);
    rows.push({
      sort: [String(summary.updated_at || ''), id],
      item: {
        session_id: id, title, ...project, eligible: reason === null, ineligible_reason: reason, grant: grantFor(summary) || null,
      },
    });
  }
  // Most recently updated first; the id breaks ties so paging is deterministic.
  rows.sort((a, b) => (a.sort[0] === b.sort[0] ? (a.sort[1] < b.sort[1] ? -1 : 1) : (a.sort[0] < b.sort[0] ? 1 : -1)));
  const scope = `recipients:${sourceSessionId}:${sha256Hex(needle).slice(0, 16)}`;
  let start = 0;
  if (cursor !== null) {
    const decoded = decodeCursor(cursor, { scope });
    if (!decoded.ok) return decoded;
    const [updatedAt, id] = decoded.key;
    start = rows.findIndex((row) => row.sort[0] < updatedAt || (row.sort[0] === updatedAt && row.sort[1] > id));
    if (start < 0) start = rows.length;
  }
  const page = rows.slice(start, start + limit);
  const last = page[page.length - 1];
  const more = start + limit < rows.length && last;
  const fingerprint = sha256Hex(JSON.stringify(rows.map((row) => [row.item.session_id, row.item.title, row.item.eligible, row.item.grant?.grant_id ?? null])));
  return {
    ok: true,
    items: page.map((row) => row.item),
    next_cursor: more ? encodeCursor({ scope, key: last.sort }) : null,
    // A stable fingerprint of the listed set as a safe integer (48 bits of its digest).
    revision: Number.parseInt(fingerprint.slice(0, 12), 16),
  };
}

module.exports = { listRecipients, projectSessionRef };
