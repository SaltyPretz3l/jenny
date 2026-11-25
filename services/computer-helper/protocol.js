'use strict';

// Node side of the jenny-computer wire protocol, version 1.
//
// The contract is native/jenny-computer/PROTOCOL.md; the Rust twin is
// native/jenny-computer/src/protocol.rs. A change here changes both and the
// protocol number in the same commit. The helper host (this folder) and the
// test fake (tests/fixtures/fake-computer-helper.js) both speak through this
// module, so neither spells a message by hand.

const PROTOCOL = 1;
const VERSION_LINE = 'jenny-computer protocol 1';
const MAX_REQUEST_BYTES = 64 * 1024;
// A capture reply is a base64 PNG of at most 2 MiB (under 3 MiB of text).
const MAX_REPLY_BYTES = 4 * 1024 * 1024;

const OPS = Object.freeze([
  'hello',
  'shutdown',
  'windows.list',
  'window.geometry',
  'window.show',
  'run.start',
  'run.close',
  'run.stop',
  'run.output',
  'run.list',
  'capture',
]);

// Row 196's operations, built behind the helper's `input` feature (`not_built` without it).
const RESERVED_INPUT_OPS = Object.freeze([
  'input.focus',
  'input.click',
  'input.drag',
  'input.move',
  'input.scroll',
  'input.type',
  'input.key',
  'input.release_all',
  'watch.start',
  'watch.stop',
  'watch.resume',
  'watch.state',
  'program.identify',
]);

const EVENTS = Object.freeze([
  'run.window',
  'run.window_state',
  'run.exited',
  'watch.owner_input',
  'watch.stop_chord',
  'log',
]);

// Why the helper's own check refused an input operation (a `refused` error's `reason`), in the order checked.
const REFUSE_REASONS = Object.freeze([
  'no_watch',
  'owner_active',
  'secure_desktop',
  'window_gone',
  'outside_window',
  'denied',
  'elevated',
  'unidentified',
  'wrong_program',
  'password_field',
  'refused_chord',
  'not_front',
]);

const ERROR_CODES = Object.freeze([
  'bad_request',
  'unknown_op',
  'not_available',
  'not_built',
  'no_such_run',
  'run_exists',
  'no_such_window',
  'start_failed',
  'capture_failed',
  'too_large',
  'refused',
  'internal',
]);

const KNOWN_OPS = new Set([...OPS, ...RESERVED_INPUT_OPS]);
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/u;

function isValidRunId(value) {
  return typeof value === 'string' && RUN_ID_RE.test(value);
}

function isValidHwnd(value) {
  return Number.isSafeInteger(value) && value > 0;
}

// Electron's desktopCapturer source id for a window handle.
function sourceIdForHwnd(hwnd) {
  if (!isValidHwnd(hwnd)) throw new TypeError('hwnd must be a positive safe integer');
  return `window:${hwnd}:0`;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

// One request line, line feed included.
function encodeRequest(id, op, args = {}) {
  if (!Number.isSafeInteger(id) || id < 0) throw new TypeError('id must be a non-negative safe integer');
  if (!KNOWN_OPS.has(op)) throw new TypeError(`unknown op: ${String(op)}`);
  if (!isPlainObject(args)) throw new TypeError('args must be a plain object');
  if (Object.hasOwn(args, 'id') || Object.hasOwn(args, 'op')) {
    throw new TypeError('args must not carry id or op');
  }
  const line = `${JSON.stringify({ id, op, ...args })}\n`;
  if (Buffer.byteLength(line, 'utf8') - 1 > MAX_REQUEST_BYTES) throw new RangeError('request is over 64 KiB');
  return line;
}

// Classify one parsed message. Returns null for anything that is not a
// well-formed reply or event.
function classifyMessage(value) {
  if (!isPlainObject(value)) return null;
  if (typeof value.event === 'string') {
    const { event, ...fields } = value;
    return { kind: 'event', name: event, fields };
  }
  if (!Object.hasOwn(value, 'id') || typeof value.ok !== 'boolean') return null;
  const id = value.id === null ? null : value.id;
  if (id !== null && (!Number.isSafeInteger(id) || id < 0)) return null;
  if (value.ok) {
    return { kind: 'reply', id, ok: true, result: isPlainObject(value.result) ? value.result : {} };
  }
  const error = isPlainObject(value.error) ? value.error : {};
  const code = ERROR_CODES.includes(error.code) ? error.code : 'internal';
  const classified = { code, message: typeof error.message === 'string' ? error.message : '' };
  if (code === 'refused') classified.reason = REFUSE_REASONS.includes(error.reason) ? error.reason : 'unidentified';
  return { kind: 'reply', id, ok: false, error: classified };
}

// Split a byte stream into messages. `onMessage(message)` gets each classified
// message; `onError(reason)` gets 'line_too_long', 'not_json' or
// 'unrecognised' and the stream goes on.
function createLineDecoder({ onMessage, onError = () => {}, maxLineBytes = MAX_REPLY_BYTES } = {}) {
  if (typeof onMessage !== 'function') throw new TypeError('onMessage is required');
  let pending = [];
  let pendingBytes = 0;
  let discarding = false;

  function emitLine(buffer) {
    let text = buffer.toString('utf8');
    if (text.endsWith('\r')) text = text.slice(0, -1);
    if (text.trim() === '') return;
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      onError('not_json');
      return;
    }
    const message = classifyMessage(value);
    if (message) onMessage(message);
    else onError('unrecognised');
  }

  function push(chunk) {
    let data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    while (data.length > 0) {
      const newline = data.indexOf(0x0a);
      const part = newline === -1 ? data : data.subarray(0, newline);
      if (!discarding) {
        if (pendingBytes + part.length > maxLineBytes) {
          discarding = true;
          pending = [];
          pendingBytes = 0;
          onError('line_too_long');
        } else {
          pending.push(part);
          pendingBytes += part.length;
        }
      }
      if (newline === -1) return;
      if (!discarding) emitLine(Buffer.concat(pending, pendingBytes));
      pending = [];
      pendingBytes = 0;
      discarding = false;
      data = data.subarray(newline + 1);
    }
  }

  function end() {
    if (!discarding && pendingBytes > 0) emitLine(Buffer.concat(pending, pendingBytes));
    pending = [];
    pendingBytes = 0;
    discarding = false;
  }

  return { push, end };
}

module.exports = {
  ERROR_CODES,
  EVENTS,
  MAX_REPLY_BYTES,
  MAX_REQUEST_BYTES,
  OPS,
  PROTOCOL,
  REFUSE_REASONS,
  RESERVED_INPUT_OPS,
  VERSION_LINE,
  classifyMessage,
  createLineDecoder,
  encodeRequest,
  isValidHwnd,
  isValidRunId,
  sourceIdForHwnd,
};
