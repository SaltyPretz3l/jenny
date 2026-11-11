'use strict';

// Readable dev console for `npm run dev` (start.js).
//
// The Electron main process prints every diagnostic entry to stdout as one
// JSON object per line (services/process-log-writer.js). That is the right
// shape for a driving agent or a pipe, and unreadable for a person: entries
// average about a thousand characters and a quarter of them repeat the line
// before. This module turns that stream into one aligned line per entry,
// folds consecutive repeats into a running count, hides known chatter, and
// marks chat turns. It only formats what the launcher shows: shell.log and the
// in-app diagnostics still hold every entry.
//
// It is used only when the launcher's stdout is a terminal and the launch is
// not agent mode (see resolveDevConsoleMode); everything else gets the raw
// stream unchanged.

const { StringDecoder } = require('node:string_decoder');

const MODE_ENV = 'JENNY_DEV_CONSOLE';
const HIDE_ENV = 'JENNY_DEV_CONSOLE_HIDE';

// Events hidden in the default view, by prefix: scroll and sweep chatter, and
// the per-turn preamble that repeats what the turn rule already says. Measured
// on a real dev session these are a fifth of all entries and say nothing while
// they are healthy. WARN and ERROR are never hidden, whatever the event.
const DEFAULT_HIDDEN_EVENT_PREFIXES = Object.freeze([
  'chat.scroll_move',
  'chat_timeline.row_model_rollout_signal',
  'artifacts.retention_swept',
  'chat.first_notification_forwarded',
  'chat.context_assembly_started',
  'chat.tool_preferences_applied',
  'chat.prompt_contributions',
]);

const MAX_PENDING_LINE_CHARS = 256 * 1024;
const DEFAULT_COLUMNS = 120;
const MIN_COLUMNS = 60;
const EVENT_WIDTH = 32;
const MAX_FIELDS = 6;
const MAX_FIELD_VALUE_CHARS = 48;

const MAX_REMEMBERED_STREAMS = 64;
const TURN_END_EVENT = 'chat.stream_summary';

// Identifiers and duplicated text that make a line long without helping a scan.
const SKIPPED_FIELD_KEYS = new Set([
  'sessionId', 'session_id', 'streamId', 'stream_id', 'requestId', 'request_id',
  'traceId', 'trace_id', 'tool_call_id', 'toolCallId', 'turnId', 'turn_id',
  'message', 'line', 'stream', 'early_log_at', 'status',
]);
const CHILD_LINE_STAMP = /^(?:time=\S+\s+level=\w+\s+|\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d\S*\s+(?:(?:TRACE|DEBUG|INFO|WARN|WARNING|ERROR)\s+)?)/;
const QUIET_STATUSES = new Set(['', 'ok', 'success', 'start', 'started', 'completed', 'complete']);

const ANSI = Object.freeze({
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m',
});
const LEVEL_STYLE = Object.freeze({
  DEBUG: 'gray', INFO: 'dim', WARN: 'yellow', ERROR: 'red',
});
const SOURCE_STYLE = Object.freeze({
  electron: 'cyan', renderer: 'magenta', sidecar: 'green', engine: 'blue',
});

function resolveDevConsoleMode({ env = {}, agentMode = false, stdoutIsTTY = false } = {}) {
  const requested = String(env[MODE_ENV] || '').trim().toLowerCase();
  // Cursor rewrites need a terminal, and agents and pipes read the JSON lines.
  if (requested === 'raw' || agentMode || !stdoutIsTTY) return 'raw';
  return requested === 'verbose' ? 'verbose' : 'pretty';
}

function resolveHiddenEventPrefixes(env = {}) {
  const extra = String(env[HIDE_ENV] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return [...DEFAULT_HIDDEN_EVENT_PREFIXES, ...extra];
}

function parseEntry(line) {
  if (line.charCodeAt(0) !== 0x7b /* { */) return null;
  let entry;
  try { entry = JSON.parse(line); } catch (_error) { return null; }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  if (typeof entry.event !== 'string' || !entry.event) return null;
  return entry;
}

function levelOf(entry) {
  const level = String(entry.level || 'INFO').trim().toUpperCase();
  return Object.hasOwn(LEVEL_STYLE, level) ? level : 'INFO';
}

function isChildOutputEvent(event) {
  return event.endsWith('.output');
}

function sourceOf(entry) {
  // A managed engine's own stdout/stderr arrives wrapped in an electron entry.
  if (isChildOutputEvent(entry.event)) return 'engine';
  const layer = String(entry.layer || entry.source || '').trim().toLowerCase();
  return Object.hasOwn(SOURCE_STYLE, layer) ? layer : 'electron';
}

function clockOf(entry) {
  const date = new Date(entry.ts);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  const two = (value) => String(value).padStart(2, '0');
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

// Control characters (an engine's own colour codes included) would break the
// one-row-per-entry accounting the in-place repeat count depends on.
function cleanText(value) {
  // eslint-disable-next-line no-control-regex
  return String(value == null ? '' : value).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
}

function formatFieldValue(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
  }
  if (typeof value === 'boolean') return String(value);
  const text = cleanText(value);
  return text.length > MAX_FIELD_VALUE_CHARS ? `${text.slice(0, MAX_FIELD_VALUE_CHARS - 1)}…` : text;
}

function formatFields(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return '';
  const parts = [];
  for (const [key, value] of Object.entries(data)) {
    if (parts.length >= MAX_FIELDS) break;
    if (SKIPPED_FIELD_KEYS.has(key) || key.startsWith('_')) continue;
    if (value === null || value === '' || typeof value === 'object') continue;
    parts.push(`${key}=${formatFieldValue(value)}`);
  }
  return parts.join(' ');
}

function detailOf(entry) {
  const data = entry.data && typeof entry.data === 'object' ? entry.data : entry.details;
  let message = cleanText(entry.message);
  // An engine stamps its own time and level on every line; the row has both.
  if (isChildOutputEvent(entry.event)) message = message.replace(CHILD_LINE_STAMP, '');
  const parts = [];
  if (message && message !== entry.event) parts.push(message);
  if (!isChildOutputEvent(entry.event)) {
    const status = String(entry.status || '').trim().toLowerCase();
    if (!QUIET_STATUSES.has(status)) parts.push(`status=${status}`);
    const fields = formatFields(data);
    if (fields) parts.push(fields);
  }
  return parts.join('  ');
}

function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '';
  return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`;
}

function createDevConsoleFormatter({
  write,
  getColumns = () => DEFAULT_COLUMNS,
  color = true,
  verbose = false,
  hiddenEventPrefixes = DEFAULT_HIDDEN_EVENT_PREFIXES,
} = {}) {
  if (typeof write !== 'function') throw new TypeError('createDevConsoleFormatter requires a write function');
  const paint = (style, text) => (color && style && text ? `${ANSI[style]}${text}${ANSI.reset}` : text);
  const columns = () => {
    const value = Number(getColumns());
    return Math.max(MIN_COLUMNS, Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_COLUMNS);
  };
  // One column short of the edge: a line that exactly fills the row wraps on
  // some terminals, and a wrapped line cannot be rewritten in place.
  const fit = (text, used) => {
    const room = columns() - 1 - used;
    if (room <= 0) return '';
    return text.length > room ? `${text.slice(0, Math.max(0, room - 1))}…` : text;
  };

  const streams = new Map();
  const stats = { entries: 0, warnings: 0, errors: 0, hidden: 0 };
  let turnCount = 0;
  // Chat streams already given a turn rule, oldest first, and the rule that is
  // waiting for the turn's first visible row (so it can name the model).
  const seenStreams = new Set();
  let pendingTurn = null;
  // The last printed line when it can still absorb a repeat: its key, how many
  // times it was seen, and a renderer that redraws it with a count.
  let group = null;

  const emit = (text) => { write(`${text}\n`); };
  const closeGroup = () => { group = null; };

  // `render(count)` returns one row. A first sighting prints it; a consecutive
  // repeat moves the cursor up and redraws the row with the new count, unless
  // the first print could not fit one row (then a count row follows it).
  const emitGrouped = (key, singleRow, render) => {
    if (group && group.key === key) {
      group.count += 1;
      if (group.singleRow) {
        write(`\x1b[1A\x1b[2K${render(group.count)}\n`);
      } else {
        const marker = paint('dim', `          ↳ repeated ×${group.count - 1} more`);
        write(group.markerShown ? `\x1b[1A\x1b[2K${marker}\n` : `${marker}\n`);
        group.markerShown = true;
      }
      return;
    }
    group = { key, count: 1, singleRow, markerShown: false };
    emit(render(1));
  };

  const isHidden = (entry, level) => {
    if (level === 'WARN' || level === 'ERROR') return false;
    if (verbose) return false;
    if (level === 'DEBUG') return true;
    return hiddenEventPrefixes.some((prefix) => entry.event.startsWith(prefix));
  };

  const emitRule = (label) => {
    closeGroup();
    const head = `── ${label} `;
    const tail = '─'.repeat(Math.max(2, columns() - 1 - head.length));
    emit(paint('bold', head) + paint('dim', tail));
  };

  // A turn starts at the first chat entry that carries a stream id not seen
  // before; a late entry from an earlier stream never opens a new turn.
  const noteTurn = (entry) => {
    if (!entry.event.startsWith('chat.')) return;
    const data = entry.data && typeof entry.data === 'object' ? entry.data : {};
    const streamId = cleanText(data.streamId || data.stream_id || entry.stream_id);
    if (!streamId) return;
    if (!seenStreams.has(streamId)) {
      seenStreams.add(streamId);
      if (seenStreams.size > MAX_REMEMBERED_STREAMS) seenStreams.delete(seenStreams.values().next().value);
      turnCount += 1;
      pendingTurn = { number: turnCount, streamId, model: '' };
    }
    if (pendingTurn && pendingTurn.streamId === streamId && !pendingTurn.model) {
      pendingTurn.model = cleanText(data.model);
    }
  };
  const flushTurnRule = () => {
    if (!pendingTurn) return;
    const { number, model } = pendingTurn;
    pendingTurn = null;
    emitRule(`turn ${number}${model ? ` · ${model}` : ''}`);
  };

  const turnEndSuffix = (entry) => {
    if (entry.event !== TURN_END_EVENT) return '';
    const data = entry.data && typeof entry.data === 'object' ? entry.data : {};
    const parts = [cleanText(data.type) || 'ended', formatDuration(data.durationMs)];
    const tools = Number(data.toolEventCount);
    if (Number.isFinite(tools) && tools > 0) parts.push(`${tools} tool events`);
    const errorCode = cleanText(data.errorCode);
    if (errorCode) parts.push(errorCode);
    return parts.filter(Boolean).join(' · ');
  };

  const handleEntry = (entry) => {
    const level = levelOf(entry);
    stats.entries += 1;
    if (level === 'WARN') stats.warnings += 1;
    if (level === 'ERROR') stats.errors += 1;
    noteTurn(entry);
    if (isHidden(entry, level)) {
      stats.hidden += 1;
      return;
    }
    flushTurnRule();

    const source = sourceOf(entry);
    const severe = level === 'WARN' || level === 'ERROR';
    const clock = clockOf(entry);
    // Most event names fit the column; a longer one keeps its whole name.
    const eventName = entry.event.padEnd(EVENT_WIDTH);
    const summary = turnEndSuffix(entry);
    const detail = summary || detailOf(entry);
    const prefixPlain = `${clock}  ${level.padEnd(5)}  ${source.padEnd(8)}  ${eventName}  `;
    const prefix = `${paint('dim', clock)}  ${paint(LEVEL_STYLE[level], level.padEnd(5))}  `
      + `${paint(SOURCE_STYLE[source], source.padEnd(8))}  ${paint(severe ? LEVEL_STYLE[level] : '', eventName)}  `;
    // A warning or error keeps its whole text, even when that takes several rows.
    const singleRow = !severe || prefixPlain.length + detail.length < columns();
    const render = (count) => {
      const countText = count > 1 ? `×${count}  ` : '';
      const body = severe ? detail : fit(detail, prefixPlain.length + countText.length);
      return prefix + paint('bold', countText) + (severe ? body : paint(summary ? '' : 'dim', body));
    };
    emitGrouped(`entry:${level}:${source}:${entry.event}`, singleRow, render);
  };

  // Anything that is not a diagnostic entry: Chromium and Node warnings, stack
  // traces, npm output. Kept whole so a crash trace stays readable.
  const handleRawLine = (line) => {
    const text = cleanText(line);
    if (!text) return;
    const gutter = '          ';
    const singleRow = gutter.length + text.length < columns();
    emitGrouped(`raw:${text}`, singleRow, (count) => (
      paint('dim', gutter + text) + (count > 1 ? paint('bold', `  ×${count}`) : '')
    ));
  };

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const entry = parseEntry(trimmed);
    if (entry) handleEntry(entry);
    else handleRawLine(trimmed);
  };

  const streamState = (name) => {
    let state = streams.get(name);
    if (!state) {
      state = { decoder: new StringDecoder('utf8'), pending: '' };
      streams.set(name, state);
    }
    return state;
  };

  const push = (chunk, streamName = 'stdout') => {
    const state = streamState(streamName);
    state.pending += typeof chunk === 'string' ? chunk : state.decoder.write(chunk);
    const lines = state.pending.split(/\r?\n/);
    state.pending = lines.pop() || '';
    for (const line of lines) handleLine(line);
    // A child that never ends its line must not grow this buffer without bound.
    if (state.pending.length > MAX_PENDING_LINE_CHARS) {
      const line = state.pending;
      state.pending = '';
      handleLine(line);
    }
  };

  const notice = (text) => {
    closeGroup();
    emit(paint('dim', text));
  };

  const end = () => {
    for (const state of streams.values()) {
      const rest = state.pending + state.decoder.end();
      state.pending = '';
      if (rest) handleLine(rest);
    }
    const parts = [`${stats.entries} entries`, `${stats.warnings} warnings`, `${stats.errors} errors`];
    if (stats.hidden > 0) parts.push(`${stats.hidden} quiet entries hidden (${MODE_ENV}=verbose shows them)`);
    emitRule(`Jenny stopped · ${parts.join(' · ')}`);
    return { ...stats, turns: turnCount };
  };

  return { push, notice, end, stats };
}

module.exports = {
  DEFAULT_HIDDEN_EVENT_PREFIXES,
  HIDE_ENV,
  MODE_ENV,
  createDevConsoleFormatter,
  resolveDevConsoleMode,
  resolveHiddenEventPrefixes,
};
