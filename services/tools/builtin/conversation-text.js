'use strict';

// The canonical text rows of a chat (row 58): plain user/assistant messages
// with string content, no receipts or other `kind` rows. Shared by the
// conversations_* tools and the conversation index pump so both read the
// same rows. Never mutates the messages it is given.

const { GENERAL_PROJECT_ID, normalizeProjectId } = require('../../projects/project-schema');

const MAX_TEXT_CHARS = 2000;
const MAX_ID_CHARS = 128;

const projectIdOf = value => normalizeProjectId(value) || GENERAL_PROJECT_ID;

function isTextRow(message) {
  return Boolean(message) && ['user', 'assistant'].includes(message.role)
    && !message.kind && typeof message.content === 'string' && Boolean(message.content.trim());
}

// Tool view: long text keeps a visible clipping marker.
function textRows(messages) {
  return messages.filter(isTextRow).map(message => ({
    id: message.id,
    role: message.role,
    text: message.content.length > MAX_TEXT_CHARS ? message.content.slice(0, MAX_TEXT_CHARS) + ' [clipped]' : message.content,
    timestamp: message.timestamp,
  }));
}

function createdAtOf(timestamp) {
  if (typeof timestamp === 'string') return timestamp.slice(0, 64);
  if (Number.isFinite(timestamp)) {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }
  return '';
}

// Index view: the newest `limit` text rows with a usable id, text clipped to
// exactly MAX_TEXT_CHARS (the sidecar refuses longer rows). A repeated id
// keeps its newest row only (the index holds one row per message id).
function indexRows(messages, limit = 500) {
  const seen = new Set();
  const rows = [];
  for (let index = messages.length - 1; index >= 0 && rows.length < limit; index -= 1) {
    const message = messages[index];
    if (!isTextRow(message) || typeof message.id !== 'string' || !message.id
      || message.id.length > MAX_ID_CHARS || seen.has(message.id)) continue;
    seen.add(message.id);
    rows.push({
      message_id: message.id,
      role: message.role,
      created_at: createdAtOf(message.timestamp),
      text: message.content.slice(0, MAX_TEXT_CHARS),
    });
  }
  return rows.reverse();
}

module.exports = { MAX_ID_CHARS, MAX_TEXT_CHARS, indexRows, projectIdOf, textRows };
