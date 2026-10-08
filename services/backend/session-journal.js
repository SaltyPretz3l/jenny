'use strict';

const zlib = require('node:zlib');

const JOURNAL_VERSION = 1;
const MAX_LINE_BYTES = 256 * 1024 * 1024;
const MAX_LENGTH_DIGITS = 10;
const MAGIC = Buffer.from('J1 ', 'latin1');
const NEWLINE = 0x0a;
const SPACE = 0x20;
const FILE_NAME_PATTERN = /^(.+)\.([1-9][0-9]*)\.journal$/;

// Every journaled array: the session key, its truncate op and its set-element op.
const ARRAYS = [
  { key: 'messages', truncate: 'mt', set: 'm' },
  { key: 'turn_events', truncate: 'et', set: 'e' },
];
const ARRAY_KEYS = new Set(ARRAYS.map((entry) => entry.key));

// How an array key looks in a session. Anything but FORM_ARRAY has no elements.
const FORM_ARRAY = 'a';
const FORM_ABSENT = 'x';
const FORM_OTHER_PREFIX = 'o';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function journalFileName(stem, epoch) {
  if (typeof stem !== 'string' || stem === '') throw new TypeError('journal stem must be a non-empty string');
  if (!isPositiveSafeInteger(epoch)) throw new TypeError('journal epoch must be a positive safe integer');
  return `${stem}.${epoch}.journal`;
}

function parseJournalFileName(name) {
  if (typeof name !== 'string') return null;
  const match = FILE_NAME_PATTERN.exec(name);
  if (!match) return null;
  const epoch = Number(match[2]);
  if (!isPositiveSafeInteger(epoch)) return null;
  return { stem: match[1], epoch };
}

// ---- Wire format ----------------------------------------------------------

// A line the reader would refuse must never be written: the caller falls back
// to rewriting the whole file instead.
function frameLine(value, maxBytes = MAX_LINE_BYTES) {
  const json = JSON.stringify(value);
  const limit = Math.min(maxBytes, MAX_LINE_BYTES);
  if (json.length > limit || Buffer.byteLength(json, 'utf8') > limit) {
    throw new RangeError('journal record exceeds the maximum line size');
  }
  const body = Buffer.from(json, 'utf8');
  const crc = zlib.crc32(body).toString(16).padStart(8, '0');
  return Buffer.concat([Buffer.from(`J1 ${body.length} ${crc} `, 'latin1'), body, Buffer.from('\n')]);
}

// `continues: true` records that the base this journal was started on holds
// exactly the state at the end of the previous epoch's journal, so this journal
// may also be replayed after that one when the newer base was lost.
function encodeHeader({ sessionId, epoch, continues = false } = {}) {
  if (typeof sessionId !== 'string') throw new TypeError('journal session id must be a string');
  if (!isPositiveSafeInteger(epoch)) throw new TypeError('journal epoch must be a positive safe integer');
  const header = { t: 'header', v: JOURNAL_VERSION, session_id: sessionId, epoch };
  if (continues === true) header.continues = true;
  return frameLine(header);
}

function encodeRecord(ops, { maxBytes = MAX_LINE_BYTES } = {}) {
  if (!Array.isArray(ops)) throw new TypeError('journal ops must be an array');
  if (ops.length === 0) return null;
  return frameLine({ t: 'delta', ops }, maxBytes);
}

function hexDigit(byte) {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
  return -1;
}

// Reads one complete line at `start`: magic, canonical length, lowercase CRC,
// exactly `length` JSON bytes and the terminating newline. Returns null for
// anything else, and never allocates from the declared length. `budget`
// (`{ left }`, bytes) bounds the body bytes a scan may examine.
function readLine(buffer, start, budget = null) {
  const size = buffer.length;
  if (start + MAGIC.length > size) return null;
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (buffer[start + i] !== MAGIC[i]) return null;
  }
  const digitsStart = start + MAGIC.length;
  let cursor = digitsStart;
  let length = 0;
  while (cursor < size && buffer[cursor] >= 0x30 && buffer[cursor] <= 0x39) {
    length = length * 10 + (buffer[cursor] - 0x30);
    cursor += 1;
    if (cursor - digitsStart > MAX_LENGTH_DIGITS) return null;
  }
  const digitCount = cursor - digitsStart;
  if (digitCount === 0 || buffer[digitsStart] === 0x30) return null;
  if (cursor >= size || buffer[cursor] !== SPACE) return null;
  if (length > MAX_LINE_BYTES) return null;

  const crcStart = cursor + 1;
  const jsonStart = crcStart + 9;
  if (jsonStart > size) return null;
  let crc = 0;
  for (let i = 0; i < 8; i += 1) {
    const digit = hexDigit(buffer[crcStart + i]);
    if (digit < 0) return null;
    crc = crc * 16 + digit;
  }
  if (buffer[crcStart + 8] !== SPACE) return null;

  const jsonEnd = jsonStart + length;
  if (jsonEnd >= size || buffer[jsonEnd] !== NEWLINE) return null;
  if (budget) {
    budget.left -= length;
    if (budget.left < 0) return null;
  }
  // A valid body holds no raw newline. Checking that first keeps a scan over
  // crafted prefixes linear instead of one CRC pass per candidate.
  if (buffer.indexOf(NEWLINE, jsonStart) !== jsonEnd) return null;
  const body = buffer.subarray(jsonStart, jsonEnd);
  if (zlib.crc32(body) !== crc) return null;
  try {
    return { end: jsonEnd + 1, value: JSON.parse(body.toString('utf8')) };
  } catch (parseError) {
    void parseError;
    return null;
  }
}

const SCAN_BUDGET_FLOOR_BYTES = 1024 * 1024;

function isHeaderFor(value, sessionId, epoch) {
  return isPlainObject(value)
    && value.t === 'header'
    && value.v === JOURNAL_VERSION
    && value.session_id === sessionId
    && value.epoch === epoch;
}

function isDelta(value) {
  return isPlainObject(value) && value.t === 'delta' && Array.isArray(value.ops);
}

// True when any complete delta line starts beyond `from`. Candidates are every
// occurrence of the magic, not only those after a newline, because the bad
// line's own newline may be the damaged byte. Many candidates can each claim
// a body that ends at the same newline, so the bytes examined are bounded;
// past the bound the answer is true (corrupt), which keeps a copy of the file.
function hasValidLineAfter(buffer, from) {
  const budget = { left: SCAN_BUDGET_FLOOR_BYTES + 4 * buffer.length };
  let candidate = buffer.indexOf(MAGIC, from + 1);
  while (candidate !== -1) {
    const line = readLine(buffer, candidate, budget);
    if (budget.left < 0 || (line && isDelta(line.value))) return true;
    candidate = buffer.indexOf(MAGIC, candidate + 1);
  }
  return false;
}

// ---- Replay ---------------------------------------------------------------

function setTopLevel(target, key, value) {
  // defineProperty keeps a JSON "__proto__" key an own property instead of a prototype write.
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function requireKey(op) {
  if (typeof op.k !== 'string') throw new TypeError(`journal op ${op.o} needs a string key`);
  return op.k;
}

function requireValue(op) {
  if (op.v === undefined) throw new TypeError(`journal op ${op.o} needs a value`);
  return op.v;
}

function ownedArray(next, key, owned) {
  const current = next[key];
  if (!Array.isArray(current)) throw new RangeError(`journal op needs ${key} to be an array`);
  if (!owned.has(key)) {
    next[key] = current.slice();
    owned.add(key);
  }
  return next[key];
}

function requireIndex(op, limit) {
  const { i } = op;
  if (!Number.isInteger(i) || i < 0 || i > limit) throw new RangeError(`journal op ${op.o} index ${i} out of range`);
  return i;
}

function applyOp(next, op, owned) {
  if (!isPlainObject(op)) throw new TypeError('journal op must be an object');
  const arrayByTruncate = ARRAYS.find((entry) => entry.truncate === op.o);
  const arrayBySet = ARRAYS.find((entry) => entry.set === op.o);
  if (op.o === 'set') {
    const key = requireKey(op);
    setTopLevel(next, key, requireValue(op));
    owned.delete(key);
  } else if (op.o === 'unset') {
    const key = requireKey(op);
    delete next[key];
    owned.delete(key);
  } else if (arrayByTruncate) {
    const list = ownedArray(next, arrayByTruncate.key, owned);
    const { n } = op;
    if (!Number.isInteger(n) || n < 0 || n > list.length) {
      throw new RangeError(`journal op ${op.o} length ${n} out of range`);
    }
    list.length = n;
  } else if (arrayBySet) {
    const list = ownedArray(next, arrayBySet.key, owned);
    const index = requireIndex(op, list.length);
    list[index] = requireValue(op);
  } else {
    throw new TypeError(`unknown journal op ${String(op.o)}`);
  }
}

// Returns a new session; the input and its arrays are never mutated.
function applyOps(session, ops) {
  if (!isPlainObject(session)) throw new TypeError('session must be an object');
  if (!Array.isArray(ops)) throw new TypeError('journal ops must be an array');
  const next = { ...session };
  const owned = new Set();
  for (const op of ops) applyOp(next, op, owned);
  return next;
}

function replayJournal(baseSession, buffer, { sessionId, epoch } = {}) {
  const mismatch = { session: baseSession, status: 'header_mismatch', validBytes: 0, records: 0, continues: false };
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return mismatch;
  const header = readLine(buffer, 0);
  // A header that does not read, in front of records that do, is damage: the
  // records cannot be attributed, and ignoring the file would hide them.
  if (!header) return hasValidLineAfter(buffer, 0) ? { ...mismatch, status: 'corrupt' } : mismatch;
  if (!isHeaderFor(header.value, sessionId, epoch)) return mismatch;

  let session = baseSession;
  let position = header.end;
  let records = 0;
  let status = 'ok';
  while (position < buffer.length) {
    const line = readLine(buffer, position);
    let next = null;
    if (line && isDelta(line.value)) {
      try {
        next = applyOps(session, line.value.ops);
      } catch (applyError) {
        void applyError;
      }
    }
    if (!next) {
      status = hasValidLineAfter(buffer, position) ? 'corrupt' : 'torn_tail';
      break;
    }
    session = next;
    position = line.end;
    records += 1;
  }
  return { session, status, validBytes: position, records, continues: header.value.continues === true };
}

// ---- Delta encoding -------------------------------------------------------

function serialize(value) {
  return JSON.stringify(value);
}

function serializeElement(value) {
  const json = JSON.stringify(value);
  return json === undefined ? 'null' : json;
}

function snapshotArray(value) {
  if (Array.isArray(value)) {
    const items = new Array(value.length);
    for (let i = 0; i < value.length; i += 1) items[i] = serializeElement(value[i]);
    return { form: FORM_ARRAY, items };
  }
  const json = serialize(value);
  return { form: json === undefined ? FORM_ABSENT : `${FORM_OTHER_PREFIX}${json}`, items: [] };
}

// The baseline is strings only, so later mutation of the caller's objects
// cannot change what it remembers.
function snapshotSession(session) {
  const source = isPlainObject(session) ? session : {};
  const values = new Map();
  for (const key of Object.keys(source)) {
    if (ARRAY_KEYS.has(key)) continue;
    const json = serialize(source[key]);
    if (json !== undefined) values.set(key, json);
  }
  const arrays = {};
  for (const { key } of ARRAYS) arrays[key] = snapshotArray(source[key]);
  return { values, arrays };
}

function diffArray(entry, before, after, ops) {
  // A form change is replayed as a whole-key set/unset, which also resets the elements.
  const formChanged = before.form !== after.form;
  if (formChanged) {
    if (after.form === FORM_ARRAY) ops.push({ o: 'set', k: entry.key, v: [] });
    else if (after.form === FORM_ABSENT) ops.push({ o: 'unset', k: entry.key });
    else ops.push({ o: 'set', k: entry.key, v: JSON.parse(after.form.slice(FORM_OTHER_PREFIX.length)) });
  }
  const beforeLength = formChanged ? 0 : before.items.length;
  if (after.items.length < beforeLength) ops.push({ o: entry.truncate, n: after.items.length });
  for (let i = 0; i < after.items.length; i += 1) {
    if (i >= beforeLength || before.items[i] !== after.items[i]) {
      ops.push({ o: entry.set, i, v: JSON.parse(after.items[i]) });
    }
  }
}

function diffSnapshots(before, after) {
  const ops = [];
  for (const [key, json] of after.values) {
    if (before.values.get(key) !== json) ops.push({ o: 'set', k: key, v: JSON.parse(json) });
  }
  for (const key of before.values.keys()) {
    if (!after.values.has(key)) ops.push({ o: 'unset', k: key });
  }
  for (const entry of ARRAYS) diffArray(entry, before.arrays[entry.key], after.arrays[entry.key], ops);
  return ops;
}

// prepare() never moves the baseline: a caller whose append failed skips commit()
// and the next prepare() re-derives the same ops plus whatever changed since.
// prepare() throws RangeError when the record would be too large to read back.
function createDeltaEncoder(session) {
  let baseline = snapshotSession(session);
  let revision = 0;
  return {
    prepare(nextSession) {
      const after = snapshotSession(nextSession);
      const ops = diffSnapshots(baseline, after);
      const record = encodeRecord(ops);
      const preparedAt = revision;
      return {
        ops,
        record,
        bytes: record ? record.length : 0,
        commit() {
          // The record was computed against one baseline; committing it over
          // another would make later deltas silently wrong.
          if (preparedAt !== revision) throw new Error('journal delta is stale: the baseline has moved');
          baseline = after;
          revision += 1;
        },
      };
    },
    reset(nextSession) {
      baseline = snapshotSession(nextSession);
      revision += 1;
    },
  };
}

module.exports = {
  JOURNAL_VERSION,
  applyOps,
  createDeltaEncoder,
  encodeHeader,
  encodeRecord,
  journalFileName,
  parseJournalFileName,
  replayJournal,
};
