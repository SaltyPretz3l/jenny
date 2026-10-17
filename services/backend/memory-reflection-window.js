'use strict';

// Reflection window (agentic memory v2, row 58 W2). Electron owns history, so it
// builds the bounded window the sidecar's `memory.reflect` reads and the opaque
// fingerprint that fences the later `memory.apply` against any edit, truncation,
// regeneration or branch of the canonical messages.

const { createHash } = require('node:crypto');

const MAX_WINDOW_ENTRIES = 24;
const MAX_NEW_USER_MESSAGES = 8;
const MAX_WINDOW_CHARS = 12_000;
const MAX_USER_CHARS = 2_000;
const MAX_ASSISTANT_CHARS = 600;
const MAX_FENCED_BLOCK_CHARS = 400;
const CODE_OMITTED = '[code omitted]';
// A fence runs to its closing ``` or, when unclosed, to the end of the text.
const FENCED_BLOCK = /```[\s\S]*?(?:```|$)/g;

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function messageId(message) {
  return String(message?.id ?? '');
}

// "sha256:" + hex(sha256(JSON of [id, role, sha256hex(content)] for messages[0..endIndex])).
function windowFingerprint(messages, endIndex) {
  const list = Array.isArray(messages) ? messages : [];
  if (!Number.isSafeInteger(endIndex) || endIndex < 0 || endIndex >= list.length) return null;
  const rows = list.slice(0, endIndex + 1)
    .map(message => [message?.id, message?.role, sha256Hex(String(message?.content ?? ''))]);
  return `sha256:${sha256Hex(JSON.stringify(rows))}`;
}

// Only plain user prompts and plain assistant replies are conversation text;
// tool rows, reasoning, plan documents, recaps and receipts are not.
function isUserText(message) {
  return message?.role === 'user' && !String(message?.kind || '').trim();
}

function isAssistantText(message) {
  return message?.role === 'assistant' && !String(message?.kind || '').trim();
}

function capChars(text, limit) {
  const chars = Array.from(text);
  return chars.length > limit ? chars.slice(0, limit).join('') : text;
}

function userWindowText(content) {
  const text = typeof content === 'string' ? content : '';
  return capChars(text.replace(FENCED_BLOCK, block => (
    block.length > MAX_FENCED_BLOCK_CHARS ? CODE_OMITTED : block)), MAX_USER_CHARS);
}

function assistantWindowText(content) {
  return capChars(typeof content === 'string' ? content : '', MAX_ASSISTANT_CHARS);
}

// The verified cursor index, or -1 when the cursor is absent, its message is
// gone or ambiguous, or the history before it changed.
function locateCursor(messages, cursor) {
  const lastId = String(cursor?.last_message_id || '');
  if (!lastId || typeof cursor?.window_fingerprint !== 'string') return -1;
  const indexes = [];
  messages.forEach((message, index) => { if (messageId(message) === lastId) indexes.push(index); });
  if (indexes.length !== 1) return -1;
  return windowFingerprint(messages, indexes[0]) === cursor.window_fingerprint ? indexes[0] : -1;
}

// G4 (row 58 W4): with `notesSince` set, a message dated before it (or with no
// readable date) was sent while "Jenny takes notes" was off and is never mined,
// neither as a new message nor as context. No `notesSince`: no filter.
function mineableAfter(notesSince) {
  const since = Date.parse(String(notesSince || ''));
  if (!Number.isFinite(since)) return () => true;
  return message => {
    const at = Date.parse(String(message?.timestamp || ''));
    return Number.isFinite(at) && at >= since;
  };
}

function pendingUserIndexes(messages, cursorIndex, mineable) {
  const userIndexes = [];
  messages.forEach((message, index) => {
    if (isUserText(message) && messageId(message) && mineable(message)) userIndexes.push(index);
  });
  // A missing or mismatched cursor reprocesses the last 8 user messages; the
  // sidecar's dedupe makes repeating them safe.
  return cursorIndex < 0
    ? userIndexes.slice(-MAX_NEW_USER_MESSAGES)
    : userIndexes.filter(index => index > cursorIndex);
}

// The new user messages one run takes: at most 8, in order, while their window
// text fits the total cap (always at least one; one capped message always fits).
// UTF-16 length over-counts the sidecar's code points, so a fit here fits there.
function takeNewUserIndexes(messages, pending) {
  const taken = [];
  let chars = 0;
  for (const index of pending.slice(0, MAX_NEW_USER_MESSAGES)) {
    const size = userWindowText(messages[index].content).length;
    if (taken.length && chars + size > MAX_WINDOW_CHARS) break;
    taken.push(index);
    chars += size;
  }
  return taken;
}

// Trim the oldest entries first; a new user message is never trimmed. Walking
// newest to oldest, the context entries kept are the newest run that fits.
function boundEntries(entries) {
  const fresh = entries.filter(entry => entry.isNew);
  let slots = MAX_WINDOW_ENTRIES - fresh.length;
  let chars = MAX_WINDOW_CHARS - fresh.reduce((sum, entry) => sum + entry.content.length, 0);
  const kept = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.isNew) {
      kept.push(entry);
    } else if (slots > 0 && entry.content.length <= chars) {
      kept.push(entry);
      slots -= 1;
      chars -= entry.content.length;
    } else {
      slots = 0;
    }
  }
  return kept.reverse();
}

// Builds the reflect window over canonical `messages` from the stored cursor
// (or null). Returns null when no mineable user message is new since the
// cursor, so a chat whose only new messages predate `notesSince` never runs and
// its cursor never moves over them.
function buildReflectionWindow(messages, cursor, { notesSince = null } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const mineable = mineableAfter(notesSince);
  const cursorIndex = locateCursor(list, cursor);
  const pending = pendingUserIndexes(list, cursorIndex, mineable);
  if (!pending.length) return null;
  const taken = takeNewUserIndexes(list, pending);
  // More pending than one run takes: end just before the next untaken prompt,
  // so the following run starts from a cursor on this window's end.
  const endIndex = pending.length > taken.length ? pending[taken.length] - 1 : list.length - 1;
  const newIds = new Set(taken.map(index => messageId(list[index])));
  const entries = [];
  for (let index = 0; index <= endIndex; index += 1) {
    const message = list[index];
    if (!mineable(message)) continue;
    if (isUserText(message) && messageId(message)) {
      entries.push({ id: messageId(message), role: 'user', content: userWindowText(message.content),
        isNew: newIds.has(messageId(message)) });
    } else if (isAssistantText(message) && messageId(message)) {
      entries.push({ id: messageId(message), role: 'assistant', content: assistantWindowText(message.content),
        isNew: false });
    }
  }
  const windowMessages = boundEntries(entries).map(({ id, role, content }) => ({ id, role, content }));
  const endMessage = list[endIndex];
  return {
    messages: windowMessages,
    newUserIds: [...newIds],
    pendingUserCount: pending.length,
    endIndex,
    fingerprint: windowFingerprint(list, endIndex),
    cursorValid: cursorIndex >= 0,
    lastMessageId: messageId(endMessage),
  };
}

module.exports = {
  MAX_NEW_USER_MESSAGES,
  MAX_WINDOW_CHARS,
  MAX_WINDOW_ENTRIES,
  buildReflectionWindow,
  locateCursor,
  windowFingerprint,
};
