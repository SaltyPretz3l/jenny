const { buildResumePayload } = require('../session-recovery-service');
const {
  buildPreparedContextHistory,
  selectContextHistoryMessages,
} = require('./chat-stream-reasoning');
const { normalizeContextPreferences } = require('./context-preferences');
const { applyCompactionSnapshotToHistory } = require('./session-compaction-snapshot');

const SESSION_SCOPE = { history_scope: 'session' };

// The compact wire carries what the model reads from a prepared chat.send row:
// role, text and tool identity. Envelopes and unknown fields stay behind.
function projectCompactRow(prepared) {
  const compactMessage = {
    role: String(prepared?.role || ''),
    content: prepared?.content == null ? '' : String(prepared.content),
  };
  if (prepared?.tool_calls) compactMessage.tool_calls = prepared.tool_calls;
  for (const field of ['tool_call_id', 'name', 'error_code']) {
    if (field in (prepared || {})) compactMessage[field] = prepared[field];
  }
  if (prepared?.is_error === true) compactMessage.is_error = true;
  return compactMessage;
}

function prepareRows(rows) {
  return buildPreparedContextHistory(rows, SESSION_SCOPE).map(projectCompactRow);
}

// The history the next chat.send would carry, as the compact payload: the
// persisted snapshot substituted for its prefix, the send path's resume
// filters, the session's history scope, and the send path's converters (a
// tool result carries its full output_text, not the stored one-line summary).
// The mid-turn resume prompt is a per-send addition, not history, so it stays
// out.
//
// The `recent` scope narrows what a send carries but not what a summary may
// cover: the snapshot replaces every canonical row before the kept tail, so the
// summarizer must read all of them. `recent` therefore selects like `session`;
// `fresh` still yields an empty payload.
//
// `anchors` maps payload rows back to their canonical index (-1 for a snapshot
// row), so a result that keeps the latest round verbatim can be placed on the
// canonical boundary. The send path's only cross-row step folds assistant text
// into the tool call that follows it, so rows are prepared in runs that start
// at every row a fold cannot absorb (anything but a tool call); the
// concatenation of the runs is the send path's list.
function buildCompactPayload(canonicalMessages, { snapshot = null, contextPreferences = null } = {}) {
  const canonical = Array.isArray(canonicalMessages) ? canonicalMessages : [];
  const origins = new Map(canonical.map((message, index) => [message, index]));
  const substituted = snapshot ? applyCompactionSnapshotToHistory(snapshot, canonical) : null;
  const history = substituted?.applied ? substituted.messages : canonical;
  const resumable = buildResumePayload({ messages: history, active_turn: null }).messages;
  const scope = normalizeContextPreferences(contextPreferences).history_scope;
  const selected = selectContextHistoryMessages(
    resumable,
    scope === 'recent' ? SESSION_SCOPE : contextPreferences
  );
  const messages = [];
  const anchors = [];
  let run = [];
  for (const message of selected) {
    const [prepared] = prepareRows([message]);
    if (prepared && !prepared.tool_calls) {
      messages.push(...prepareRows(run));
      run = [];
      anchors.push({ index: messages.length, origin: origins.has(message) ? origins.get(message) : -1 });
    }
    run.push(message);
  }
  messages.push(...prepareRows(run));
  return { messages, anchors };
}

module.exports = { buildCompactPayload };
