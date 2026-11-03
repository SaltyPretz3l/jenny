'use strict';

/* services/primary-chat-export-service.js - the port behind the Jenny chat's `session_export` tool (row 94 P4,
 * docs/plans/APP_CONTROL_P4_EXPORT_TERMINAL_2026-11-02.md section 4.1).
 *
 * Invariant: a chat is exported only after the user saw it on the card. The approval path calls `prepareCard`
 * under the tool call id; it proves the chat is in the caller's directory scope and that the model's
 * `chat_title` (which the card shows verbatim) names that chat, refuses an empty chat, and remembers the
 * file name the card shows. `exportChat` writes only under that call's card (single use, 10 minutes),
 * re-checks the scope, renders the FULL history (the store's cache-neutral `peekSession`, not the
 * directory's page) with conversation-format-utils' `buildMarkdown` (user and assistant text, no reasoning),
 * redacts secrets and host paths as a user's transcript export does, and creates the file in Downloads with
 * an exclusive write (` (2)` .. ` (20)` on a collision). A Downloads folder that resolves into a protected
 * root (Jenny's data) is refused. Nothing is overwritten or deleted, so there is no Undo.
 *
 * Composition-root style: dependencies are injected getters; a missing or throwing one is a refusal
 * (`unavailable`), never a throw. Answers carry stable reasons and the file name only, never a path.
 */

const fs = require('node:fs');
const path = require('node:path');
const { buildMarkdown } = require('../renderer/shared/conversation-format-utils');
const { redactExportSecrets, redactTranscriptExportContent } = require('./backend/transcript-export-redaction');

const LIMITS = Object.freeze({
  id_chars: 256, title_chars: 200, name_title_points: 80, max_bytes: 8 * 1024 * 1024, cards_max: 32, copies_max: 20,
});
// Longer than the longest approval wait (an unattended-pause card waits up to 4 hours); bounded by `cards_max`.
const CARD_TTL_MS = 4 * 60 * 60 * 1000 + 10 * 60 * 1000;
const EXPORT_ROLES = new Set(['user', 'assistant']);
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_RE = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
const RESERVED_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

const refusal = (reason, extra = {}) => ({ ok: false, reason, ...extra });
const pad = (value) => String(value).padStart(2, '0');
const points = (text, limit) => Array.from(text).slice(0, limit).join('');
const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const fold = (value) => oneLine(value).normalize('NFC').toLowerCase();
const validId = (value) => typeof value === 'string' && value !== '' && value.length <= LIMITS.id_chars;
const validTitle = (value) => typeof value === 'string' && value.trim() !== '' && Array.from(value).length <= LIMITS.title_chars;

function read(getter) {
  try { return typeof getter === 'function' ? getter() ?? null : null; } catch (_error) { return null; }
}

function localStamp(date, separator) {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${day} ${pad(date.getHours())}${separator}${pad(date.getMinutes())}`;
}

function safeTitle(title) {
  const trimEnd = (text) => text.replace(/[. ]+$/, '');
  const cleaned = trimEnd(points(trimEnd(oneLine(String(title ?? '').replace(UNSAFE_NAME_RE, ' '))), LIMITS.name_title_points));
  if (!cleaned) return 'Chat';
  return RESERVED_NAME_RE.test(cleaned) ? `Chat ${cleaned}` : cleaned;
}

/** `Jenny - <safe title> - <YYYY-MM-DD HHmm>.md` in local time. */
function exportFileName(title, date) {
  return `Jenny - ${safeTitle(title)} - ${localStamp(new Date(date), '')}.md`;
}

function hasText(message) {
  const segments = Array.isArray(message.visible_segments) ? message.visible_segments : [];
  const joined = segments.map((segment) => String(segment?.text ?? '')).join('');
  return (joined || String(message.content ?? '')).trim() !== '';
}

// User and assistant messages with text that buildMarkdown keeps (it drops its skipped kinds).
function exportable(messages) {
  const list = Array.isArray(messages) ? messages : [];
  return list.filter((message) => message && typeof message === 'object' && EXPORT_ROLES.has(message.role)
    && hasText(message) && buildMarkdown([message], { includeReasoning: false }) !== '');
}

function render(title, messages, date) {
  const heading = `# ${oneLine(title) || 'Chat'}\n\nExported from Jenny on ${localStamp(date, ':')}.\n\n`;
  const content = `${heading}${buildMarkdown(messages, { includeReasoning: false })}\n`;
  return redactTranscriptExportContent(redactExportSecrets(content), 'markdown');
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative.split(path.sep)[0] !== '..' && !path.isAbsolute(relative));
}

function createPrimaryChatExportService({
  sessionStore = () => null, sessionDirectory = () => null, featureFlags = () => ({}), primarySessionId = () => null,
  hostMode = () => 'desktop', getDownloadsDir = () => null, protectedPaths = () => [],
  fsPromises = fs.promises, now = () => new Date(), log = () => {},
} = {}) {
  const cards = new Map(); // tool_call_id -> { caller, target, title, chat_title, file_name, expires }
  const note = (level, event, details) => { try { log(level, event, details); } catch (_error) { /* never changes an answer */ } };
  const clock = () => new Date(now());

  function gate(callerId) {
    const flags = read(featureFlags) || {};
    if (flags.primary_chat === false || flags.primary_chat_export === false) return 'disabled';
    if (read(hostMode) === 'server') return 'unavailable';
    const primary = read(primarySessionId);
    return typeof callerId === 'string' && callerId !== '' && primary === callerId ? null : 'not_allowed';
  }

  // `{ ok, title }` when the target is in the caller's directory scope, else a refusal (the directory's title read,
  // which reads no transcript).
  async function visibleTitle(callerId, targetId) {
    const directory = read(sessionDirectory);
    if (typeof directory?.title !== 'function') return refusal('unavailable');
    const answer = await directory.title({ callerSessionId: callerId, sessionId: targetId });
    if (answer?.ok !== true) return refusal('not_found');
    const title = answer.title;
    return { ok: true, title: typeof title === 'string' ? title : '' };
  }

  // The full canonical history, read without promoting the store's session cache.
  function messagesOf(targetId) {
    const store = read(sessionStore);
    if (typeof store?.peekSession !== 'function') return null;
    return exportable(store.peekSession(targetId)?.messages);
  }

  function remember(callId, card) {
    const at = clock().getTime();
    for (const [key, entry] of cards) if (entry.expires <= at) cards.delete(key);
    cards.delete(callId);
    cards.set(callId, card);
    while (cards.size > LIMITS.cards_max) cards.delete(cards.keys().next().value);
  }

  function take(callId, callerId, targetId, chatTitle) {
    const card = typeof callId === 'string' ? cards.get(callId) : null;
    if (!card) return null;
    cards.delete(callId); // one card, one attempt
    if (card.expires <= clock().getTime() || card.caller !== callerId || card.target !== targetId) return null;
    if (typeof chatTitle === 'string' && fold(chatTitle) !== fold(card.chat_title)) return null;
    return card;
  }

  async function prepare({ session_id: callerId, tool_call_id: callId, target_session_id: targetId, chat_title: chatTitle } = {}) {
    const blocked = gate(callerId);
    if (blocked) return refusal(blocked);
    if (!validId(callId) || !validId(targetId) || !validTitle(chatTitle)) return refusal('invalid_input');
    const visible = await visibleTitle(callerId, targetId);
    if (!visible.ok) return visible;
    if (fold(visible.title) !== fold(chatTitle)) return refusal('title_mismatch', { chat_title: points(visible.title, LIMITS.title_chars) });
    const messages = messagesOf(targetId);
    if (!messages) return refusal('unavailable');
    if (!messages.length) return refusal('empty');
    const at = clock();
    const fileName = exportFileName(visible.title, at);
    remember(callId, { caller: callerId, target: targetId, title: visible.title, chat_title: chatTitle, file_name: fileName, expires: at.getTime() + CARD_TTL_MS });
    return { ok: true, chat_title: chatTitle, file_name: fileName };
  }

  // The real Downloads folder, or a refusal when it is missing or resolves into a protected root.
  async function downloadsFolder() {
    const dir = read(getDownloadsDir);
    if (typeof dir !== 'string' || !dir.trim() || !path.isAbsolute(dir)) return refusal('no_folder');
    let real;
    try {
      if (!(await fsPromises.stat(dir)).isDirectory()) return refusal('no_folder');
      real = await fsPromises.realpath(dir);
    } catch (_error) {
      return refusal('no_folder');
    }
    const roots = read(protectedPaths);
    for (const root of Array.isArray(roots) ? roots : []) {
      if (typeof root !== 'string' || !root.trim()) continue;
      const realRoot = await fsPromises.realpath(root).catch(() => path.resolve(root));
      if (isInside(realRoot, real) || isInside(path.resolve(root), path.resolve(dir))) return refusal('protected_folder');
    }
    return { ok: true, dir: real };
  }

  // Creates the file without replacing anything; the name actually written, or null.
  async function writeExclusive(dir, fileName, content) {
    const stem = fileName.replace(/\.md$/, '');
    for (let copy = 1; copy <= LIMITS.copies_max; copy += 1) {
      const name = copy === 1 ? fileName : `${stem} (${copy}).md`;
      try {
        await fsPromises.writeFile(path.join(dir, name), content, { encoding: 'utf8', flag: 'wx' });
        return name;
      } catch (error) {
        if (error?.code !== 'EEXIST') return null;
      }
    }
    return null;
  }

  async function write(card, callerId) {
    const visible = await visibleTitle(callerId, card.target);
    if (!visible.ok) return visible;
    const messages = messagesOf(card.target);
    if (!messages) return refusal('unavailable');
    if (!messages.length) return refusal('empty');
    // Text alone past the cap is too large however it renders: refuse before building and redacting copies of it.
    if (messages.reduce((chars, message) => chars + String(message.content ?? '').length, 0) > LIMITS.max_bytes) return refusal('too_large');
    const content = render(card.title, messages, clock());
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > LIMITS.max_bytes) return refusal('too_large');
    const folder = await downloadsFolder();
    if (!folder.ok) return folder;
    const written = await writeExclusive(folder.dir, card.file_name, content);
    if (!written) return refusal('write_failed');
    note('INFO', 'primary_chat_export.written', { bytes, messages: messages.length });
    return { ok: true, file_name: written, bytes, messages: messages.length };
  }

  async function run({ caller_session_id: callerId, tool_call_id: callId, session_id: targetId, chat_title: chatTitle } = {}) {
    const blocked = gate(callerId);
    if (blocked) return refusal(blocked);
    const card = take(callId, callerId, targetId, chatTitle);
    if (!card) return refusal('not_allowed'); // no card was shown for this call
    const answer = await write(card, callerId);
    if (!answer.ok) note('WARN', 'primary_chat_export.failed', { reason: answer.reason });
    return answer;
  }

  /** Called by the approval path before the card: `{ ok, chat_title, file_name }` or a refusal. */
  async function prepareCard(input) {
    try { return await prepare(input); } catch (_error) { return refusal('unavailable'); }
  }

  /** The tool's write, under this call's card: `{ ok, file_name, bytes, messages }` or a refusal. */
  async function exportChat(input) {
    try { return await run(input); } catch (_error) { return refusal('unavailable'); }
  }

  return { exportChat, prepareCard };
}

module.exports = { createPrimaryChatExportService, exportFileName };
