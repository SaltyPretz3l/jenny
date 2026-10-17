'use strict';

// History scope selection for model-facing history (`session` | `recent` | `fresh`), split out of
// chat-stream-reasoning.js. Addressed session messages (`role:'context'` rows) sit just BEFORE the
// user anchor of the turn that admitted them, so they travel with the FOLLOWING turn group, and the
// contiguous context rows at the end of history (the turn being built) are pinned under every scope.

const { isCompactionSummaryMessage } = require('./session-compaction-snapshot');
const { normalizeContextPreferences } = require('./context-preferences');

const RECENT_TURN_GROUP_LIMIT = 6;

function isPlainUserAnchorMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return false;
  }
  return String(message.role || '').trim() === 'user' && !String(message.kind || '').trim();
}

// Addressed session messages (and their discard receipts) sit just BEFORE the user
// anchor of the turn that admitted them, so they travel with the FOLLOWING turn.
function isContextRow(message) {
  return Boolean(message) && typeof message === 'object' && message.role === 'context';
}

// The contiguous context rows at the end of history are the current turn's admitted mail:
// they are pinned under every history scope (the user anchor itself is not part of history).
function trailingContextRows(messages) {
  const rows = Array.isArray(messages) ? messages : [];
  let start = rows.length;
  while (start > 0 && isContextRow(rows[start - 1])) start -= 1;
  return rows.slice(start);
}

function selectRecentTurnGroups(messages, maxGroups = RECENT_TURN_GROUP_LIMIT) {
  const groups = [];
  const leadingSummaries = [];
  let currentGroup = [];
  let pendingContext = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    if (isContextRow(message)) {
      pendingContext.push(message);
      continue;
    }
    if (isPlainUserAnchorMessage(message)) {
      if (currentGroup.length) {
        groups.push(currentGroup);
      }
      currentGroup = [...pendingContext, message];
      pendingContext = [];
      continue;
    }
    if (pendingContext.length) {
      if (currentGroup.length) currentGroup.push(...pendingContext);
      pendingContext = [];
    }
    // Messages before the first plain user anchor are intentionally
    // dropped in 'recent' mode, except compaction-summary rows: a persisted
    // snapshot replaces the older history with that summary, so dropping it
    // would leave the model with neither. System/personality context is
    // re-injected fresh on each send, so nothing else before the first
    // anchor is retained.
    if (currentGroup.length) {
      currentGroup.push(message);
    } else if (isCompactionSummaryMessage(message)) {
      leadingSummaries.push(message);
    }
  }

  if (currentGroup.length) {
    groups.push(currentGroup);
  }

  return [...leadingSummaries, ...groups.slice(-Math.max(0, Number(maxGroups) || 0)).flat(), ...pendingContext];
}

function selectContextHistoryMessages(messages, contextPreferences) {
  const normalized = normalizeContextPreferences(contextPreferences);
  if (normalized.history_scope === 'fresh') {
    return trailingContextRows(messages);
  }
  if (normalized.history_scope === 'recent') {
    return selectRecentTurnGroups(messages, RECENT_TURN_GROUP_LIMIT);
  }
  if (normalized.history_scope === 'session') {
    return Array.isArray(messages) ? messages : [];
  }
  throw new Error(`Unsupported context history scope: ${normalized.history_scope}`);
}

module.exports = {
  RECENT_TURN_GROUP_LIMIT,
  isContextRow,
  selectContextHistoryMessages,
  selectRecentTurnGroups,
  trailingContextRows,
};
