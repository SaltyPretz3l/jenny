'use strict';

/* services/backend/session-todo-projection.js - the latest `todo_write` checklist of a
 * chat, read from its Electron transcript (row 69 W2). A port of the renderer's
 * checklist scan (renderer/features/renderer-task-rail-render.js
 * buildSessionChecklistValue), which services may not require: the newest
 * successful `todo_write` tool result wins; a newest `{cleared: true}` answer means
 * the list was finished and dropped, so the projection is an empty list. Pure over
 * the transcript rows; never mutates them and never throws.
 */

const MAX_ITEMS = 50;
const MAX_CONTENT_CHARS = 300;
const STATUSES = new Set(['pending', 'in_progress', 'completed']);

function toolNameOf(message, result) {
  return String(result.tool_name || message?.tool_name || message?.toolName || '').trim().toLowerCase();
}

function failed(message, result) {
  return result.is_error === true || message?.is_error === true
    || Boolean(String(result.error_code || message?.error_code || '').trim());
}

function sourceTurnOf(message) {
  const turnId = typeof message?.turn_id === 'string' ? message.turn_id.trim() : '';
  return turnId ? turnId.slice(0, 128) : null;
}

function itemsOf(parsed) {
  const todos = Array.isArray(parsed?.todos) ? parsed.todos.slice(0, MAX_ITEMS) : [];
  return todos.map((todo) => {
    const content = String(todo?.content ?? '').trim().slice(0, MAX_CONTENT_CHARS);
    const raw = String(todo?.status || '').trim().toLowerCase();
    return content ? { content, status: STATUSES.has(raw) ? raw : 'pending' } : null;
  }).filter(Boolean);
}

// -> {items: [{content, status}], source_turn} | null (no todo_write in the transcript).
function latestTodoList(messages) {
  const source = Array.isArray(messages) ? messages : [];
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const message = source[index];
    if (message?.kind !== 'tool_result') continue;
    const result = message.tool_result && typeof message.tool_result === 'object' ? message.tool_result : {};
    if (toolNameOf(message, result) !== 'todo_write' || failed(message, result)) continue;
    let parsed;
    try {
      parsed = JSON.parse(String(result.output_text || result.content || ''));
    } catch (_error) {
      return { items: [], source_turn: sourceTurnOf(message) };
    }
    if (parsed?.cleared === true) return { items: [], source_turn: sourceTurnOf(message) };
    return { items: itemsOf(parsed), source_turn: sourceTurnOf(message) };
  }
  return null;
}

module.exports = { latestTodoList };
