'use strict';

// The desktop team host's own log lines (owner decision E51): the child's stdout, kept as ids, counts
// and reason words in a small rotating file, `<logsDir>/host.log`, and never acted on. The rule, the
// sizes and the known limits are in the team membership spec, "E51 as built".

const fs = require('node:fs');
const path = require('node:path');

const MAX_LINE_BYTES = 4096;
const LOG_FILE_BYTES = 1024 * 1024;
// The current file and two older ones.
const LOG_FILES = 3;
const MAX_PENDING_BYTES = 64 * 1024;
// How long an exited child's pipe is still read for its last lines.
const DRAIN_MS = 1000;

const LEVELS = new Set(['DEBUG', 'INFO', 'WARN', 'ERROR']);
const EVENT = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,8}$/u;
const MAX_EVENT = 96;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const FIELD_NAME = /^[a-z][a-z0-9_]{0,30}$/u;
const VALUE = /^[A-Za-z0-9_-]{1,64}$/u;
// The shapes server/team/ids.js, the member store and the channel prefix make, and the host's own
// request ids and boot epoch (`randomUUID`): only these may be long runs.
const ID_SHAPE = /^(?:(?:team|member|device|invite|project|chan_project)_[A-Za-z0-9_-]{1,32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;
// The audit detail rule (server/team/audit-log.js `isDetail`), for any invite version: a long base64url
// run, or an invite prefix.
const KEY_LIKE = /[A-Za-z0-9_-]{32,}/u;
const SECRET_PREFIX = /jteam(?:addr)?\d+_/iu;
const OWN_FIELDS = new Set(['timestamp', 'level', 'event']);

const OPEN_FLAGS = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

const noSecret = (text) => !SECRET_PREFIX.test(text) && !KEY_LIKE.test(text);

const isEvent = (value) => typeof value === 'string' && value.length <= MAX_EVENT && EVENT.test(value) && noSecret(value);

/** A value the file may hold. Any doubt is false. */
function plainValue(value) {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string' || !VALUE.test(value) || SECRET_PREFIX.test(value)) return false;
  return ID_SHAPE.test(value) || !KEY_LIKE.test(value);
}

/** `{ line, dropped }` for a line to keep, or null for one to drop whole. */
function filterLine(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(value) || !LEVELS.has(value.level) || typeof value.timestamp !== 'string' || !TIMESTAMP.test(value.timestamp)
    || !isEvent(value.event)) return null;
  const kept = {};
  let dropped = 0;
  for (const [name, field] of Object.entries(value)) {
    if (OWN_FIELDS.has(name)) kept[name] = field;
    else if (name !== 'dropped_fields' && FIELD_NAME.test(name) && noSecret(name) && plainValue(field)) kept[name] = field;
    else dropped += 1;
  }
  if (dropped > 0) kept.dropped_fields = dropped;
  return { line: JSON.stringify(kept), dropped };
}

/**
 * Starts reading `stream` into `<logsDir>/host.log`. `logsDir` null (or a folder that fails its check)
 * still reads and discards the stream. Answers `{ end, drain, stats, resources }`.
 */
function createHostLogSink({ stream, logsDir, say = () => {}, now = Date.now, fsImpl = fs }) {
  const file = typeof logsDir === 'string' ? path.join(logsDir, 'host.log') : null;
  const counts = { kept: 0, dropped_lines: 0, dropped_fields: 0, dropped_pressure: 0 };
  let peakPendingBytes = 0;
  let pending = [];
  let pendingBytes = 0;
  let parts = [];
  let partBytes = 0;
  let overflow = false;
  let fd = null;
  let fileBytes = 0;
  let disabled = false;
  let ended = false;
  let flushHandle = null;
  let drainTimer = null;
  let closed = null;
  let resolveClosed = () => {};

  function closeFile() {
    if (fd === null) return;
    try { fsImpl.closeSync(fd); } catch { /* already gone */ }
    fd = null;
  }

  function stopFile(reason) {
    if (disabled) return;
    disabled = true;
    pending = [];
    pendingBytes = 0;
    closeFile();
    say('WARN', 'team.host.log_stopped', { reason });
  }

  // The folder: a directory, not a link, at its real path. The file: absent, or a plain file with one link.
  function openFile() {
    const folder = fsImpl.lstatSync(logsDir);
    if (!folder.isDirectory() || folder.isSymbolicLink() || fsImpl.realpathSync.native(logsDir) !== logsDir) {
      throw Object.assign(new Error('folder'), { reason: 'team_host_log_folder_invalid' });
    }
    try {
      const stat = fsImpl.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Object.assign(new Error('file'), { reason: 'team_host_log_file_invalid' });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    fd = fsImpl.openSync(file, OPEN_FLAGS, 0o600);
    fileBytes = fsImpl.fstatSync(fd).size;
  }

  function rotate() {
    closeFile();
    const ignoreMissing = (operation) => { try { operation(); } catch (error) { if (error?.code !== 'ENOENT') throw error; } };
    ignoreMissing(() => fsImpl.unlinkSync(`${file}.${LOG_FILES - 1}`));
    for (let index = LOG_FILES - 2; index >= 1; index -= 1) {
      ignoreMissing(() => fsImpl.renameSync(`${file}.${index}`, `${file}.${index + 1}`));
    }
    fsImpl.renameSync(file, `${file}.1`);
    openFile();
  }

  function writeText(text) {
    if (disabled || fd === null) return;
    try {
      const buffer = Buffer.from(text, 'utf8');
      if (fileBytes > 0 && fileBytes + buffer.length > LOG_FILE_BYTES) rotate();
      for (let offset = 0; offset < buffer.length;) {
        const written = fsImpl.writeSync(fd, buffer, offset, buffer.length - offset);
        if (!(written > 0)) throw Object.assign(new Error('stalled'), { reason: 'team_host_log_write_stalled' });
        offset += written;
      }
      fileBytes += buffer.length;
    } catch (error) {
      stopFile(error?.reason || 'team_host_log_write_failed');
    }
  }

  function flush() {
    flushHandle = null;
    if (pending.length === 0) return;
    const text = pending.join('');
    pending = [];
    pendingBytes = 0;
    writeText(text);
  }

  // A stopped file or a full queue takes nothing, so such a line is counted before it costs a parse.
  function take(text, bytes) {
    if (disabled || pendingBytes + bytes + 1 > MAX_PENDING_BYTES) { counts.dropped_pressure += 1; return; }
    const result = filterLine(text.endsWith('\r') ? text.slice(0, -1) : text);
    if (!result) { counts.dropped_lines += 1; return; }
    const size = Buffer.byteLength(result.line, 'utf8') + 1;
    if (pendingBytes + size > MAX_PENDING_BYTES) { counts.dropped_pressure += 1; return; }
    pending.push(`${result.line}\n`);
    pendingBytes += size;
    peakPendingBytes = Math.max(peakPendingBytes, pendingBytes);
    counts.kept += 1;
    counts.dropped_fields += result.dropped;
    flushHandle ??= setImmediate(flush);
  }

  function finishLine() {
    if (overflow) counts.dropped_lines += 1;
    else if (partBytes > 0) take(Buffer.concat(parts, partBytes).toString('utf8'), partBytes);
    parts = [];
    partBytes = 0;
    overflow = false;
  }

  function onData(chunk) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    for (let start = 0; start <= buffer.length;) {
      const newline = buffer.indexOf(10, start);
      const end = newline === -1 ? buffer.length : newline;
      if (!overflow) {
        if (partBytes + (end - start) > MAX_LINE_BYTES) {
          overflow = true;
          parts = [];
          partBytes = 0;
        } else if (end > start) {
          // A copy, so a partial line never keeps the whole chunk alive.
          parts.push(Buffer.from(buffer.subarray(start, end)));
          partBytes += end - start;
        }
      }
      if (newline === -1) break;
      finishLine();
      start = newline + 1;
    }
  }

  // Stays after end(): a read error on a pipe being torn down must never be an uncaught exception.
  const onError = () => { /* the child's exit ends the run */ };
  const onDone = () => {
    try { end(); } catch { resolveClosed(); }
  };

  if (file === null) stopFile('team_host_log_folder_invalid');
  else {
    try { openFile(); } catch (error) { stopFile(error?.reason || 'team_host_log_open_failed'); }
  }
  stream.on('data', onData);
  stream.on('error', onError);

  /** Stops reading, writes what is pending and one closing line with the counts, and closes the file. */
  function end() {
    if (ended) return;
    ended = true;
    clearTimeout(drainTimer);
    stream.removeListener('data', onData);
    stream.removeListener('end', onDone);
    stream.removeListener('close', onDone);
    if (flushHandle !== null) { clearImmediate(flushHandle); flushHandle = null; }
    if (overflow || partBytes > 0) counts.dropped_lines += 1;
    parts = [];
    partBytes = 0;
    flush();
    writeText(`${JSON.stringify({ timestamp: new Date(now()).toISOString(), level: 'INFO', event: 'team.host_log.closed', ...counts })}\n`);
    closeFile();
    resolveClosed();
  }

  /**
   * For an exited child: keeps reading until the stream ends or closes, or DRAIN_MS passes, then end().
   * Answers a promise that settles once the file is closed.
   */
  function drain() {
    if (ended) return Promise.resolve();
    if (closed) return closed;
    closed = new Promise((resolve) => { resolveClosed = resolve; });
    if (stream.readableEnded || stream.destroyed) onDone();
    else {
      // The timer first, so the file still closes if subscribing to the stream throws.
      drainTimer = setTimeout(onDone, DRAIN_MS);
      drainTimer.unref?.();
      stream.once('end', onDone);
      stream.once('close', onDone);
    }
    return closed;
  }

  return Object.freeze({
    end,
    drain,
    stats: () => ({ ...counts, peak_pending_bytes: peakPendingBytes }),
    resources: () => ({ reading: !ended, open: fd !== null, pending_bytes: pendingBytes }),
  });
}

module.exports = { LOG_FILE_BYTES, LOG_FILES, MAX_LINE_BYTES, MAX_PENDING_BYTES, createHostLogSink };
