'use strict';

// The part window of one model transfer (row 123, slice 6-2; TEAM_MODEL_SHARING_SPEC "The relay", Window
// and Start points). Pure: no clock, no timer, no I/O.
//
// A transfer's parts form one sequence: file 0 from its start point to its end, then file 1, and so on.
// The sender puts only the next part; the window holds at most `windowParts` put parts the receiver has
// not passed. The rule 6-4 follows: a part leaves the window once it has been served at least once AND
// a later part has also been served. A take never releases an unserved part, and asking for a part not
// yet put only waits. `drop()` (pause) releases the window and rewinds the sender to the first part not
// passed; `clear()` (end) releases everything for good.
//
// Review round two (R14-F03): a part a response is still streaming keeps its buffer alive, so it keeps its place
// until that stream ends. `take` answers a `release()` the route calls once its response has finished or closed; a
// part that left the window (passed, dropped or cleared) while a stream still held it is counted in `streamParts`,
// and the window is full when its parts and those together reach `windowParts`. One transfer therefore holds at
// most `windowParts` part buffers, in the window or on the wire.

const RESUME_KEYS = Object.freeze(['index', 'offset']);

function isResumeEntry(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Object.keys(value);
  return keys.length === RESUME_KEYS.length && RESUME_KEYS.every((key) => Object.hasOwn(value, key));
}

/**
 * Start offsets per file from an accept's `resume: [{ index, offset }]`. Each index names a file of the
 * offer once; each offset is a multiple of the part size inside the file, or the file's size (the file is
 * already complete). A file not named starts at 0. Answers `{ ok: true, starts }` or `{ ok: false }`.
 */
function parseResume(files, resume, partBytes) {
  const starts = files.map(() => 0);
  if (resume === undefined) return { ok: true, starts };
  if (!Array.isArray(resume) || resume.length > files.length) return { ok: false };
  const seen = new Set();
  for (let position = 0; position < resume.length; position += 1) {
    const entry = resume[position];
    if (!isResumeEntry(entry)) return { ok: false };
    const { index, offset } = entry;
    if (!Number.isSafeInteger(index) || index < 0 || index >= files.length || seen.has(index)) return { ok: false };
    const { size } = files[index];
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) return { ok: false };
    if (offset % partBytes !== 0 && offset !== size) return { ok: false };
    seen.add(index);
    starts[index] = offset;
  }
  return { ok: true, starts };
}

/**
 * The window of one transfer. `files` are the manifest's `{ size }` entries, `starts` the parsed start
 * offsets, `lookahead` how far past the next part to be put a take may wait (2: the next part and one
 * more). Words from `check`, `put` and `take`: 'ok', 'duplicate', 'full', 'stale', 'short', 'size', 'not_ready'.
 */
function createTransferWindow({ files, starts, partBytes, windowParts, lookahead }) {
  const partsIn = files.map((file) => Math.ceil(file.size / partBytes));
  const firstPart = files.map((file, index) => (starts[index] === file.size ? partsIn[index] : starts[index] / partBytes));
  // prefix[i]: the ordinal of file i's first part to send.
  const prefix = [0];
  for (let index = 0; index < files.length; index += 1) prefix.push(prefix[index] + partsIn[index] - firstPart[index]);
  const totalParts = prefix[files.length];
  const bytesTotal = files.reduce((sum, file) => sum + file.size, 0);
  const startedBytes = starts.reduce((sum, offset) => sum + offset, 0);

  let sendOrd = 0;
  // Put parts not passed: { ord, bytes, served, streams }, contiguous, ending at sendOrd - 1.
  let window = [];
  // Parts out of the window whose buffers a stream still holds.
  const streaming = new Set();
  let passedBytes = 0;
  let maxServed = -1;
  const low = () => (window.length > 0 ? window[0].ord : sendOrd);

  function ordinal(index, part) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= files.length) return -1;
    if (!Number.isSafeInteger(part) || part < firstPart[index] || part >= partsIn[index]) return -1;
    return prefix[index] + part - firstPart[index];
  }

  function position(ord) {
    if (ord >= totalParts) return null;
    let index = 0;
    while (prefix[index + 1] <= ord) index += 1;
    return { index, part: firstPart[index] + ord - prefix[index] };
  }

  function partLength(ord) {
    const { index, part } = position(ord);
    return Math.min(partBytes, files[index].size - part * partBytes);
  }

  // A part number past its file's last part is 'size'; any other place outside the sequence is 'stale'.
  function placeWord(index, part) {
    if (Number.isSafeInteger(index) && index >= 0 && index < files.length
      && Number.isSafeInteger(part) && part >= partsIn[index]) return 'size';
    return 'stale';
  }

  function check(index, part) {
    const ord = ordinal(index, part);
    if (ord < 0) return { word: placeWord(index, part) };
    if (ord < sendOrd) return { word: 'duplicate' };
    if (ord > sendOrd) return { word: 'stale' };
    if (window.length + streaming.size >= windowParts) return { word: 'full' };
    return { word: 'ok', bytes: partLength(ord) };
  }

  function put(index, part, bytes) {
    const checked = check(index, part);
    if (checked.word !== 'ok') return checked.word;
    if (bytes.length > checked.bytes) return 'size';
    if (bytes.length < checked.bytes) return 'short';
    window.push({ ord: sendOrd, bytes, served: false, streams: 0 });
    sendOrd += 1;
    return 'ok';
  }

  // Parts leaving the window: one a stream still holds keeps its place among the streamed parts.
  function leave(entries) {
    for (const entry of entries) if (entry.streams > 0) streaming.add(entry);
  }

  // The stream of `entry` has ended (once per take): true when that freed a place.
  function releaser(entry) {
    let done = false;
    return () => {
      if (done) return false;
      done = true;
      entry.streams -= 1;
      return entry.streams === 0 && streaming.delete(entry);
    };
  }

  // `first` says the part was served for the first time; `released` counts places freed by this take (none for a
  // part still streamed: it keeps its place). With `hold` (the part route, which streams `bytes`) the answer carries
  // `release()`, called once when that response ends.
  function take(index, part, { hold = false } = {}) {
    const ord = ordinal(index, part);
    if (ord < 0 || ord < low()) return { word: 'stale', released: 0 };
    if (ord >= sendOrd) return { word: ord - sendOrd < lookahead ? 'not_ready' : 'stale', released: 0 };
    const entry = window[ord - low()];
    const first = !entry.served;
    entry.served = true;
    if (hold) entry.streams += 1;
    maxServed = Math.max(maxServed, ord);
    let released = 0;
    while (window.length > 0 && window[0].served && window[0].ord < maxServed) {
      passedBytes += window[0].bytes.length;
      const passed = window.shift();
      leave([passed]);
      if (passed.streams === 0) released += 1;
    }
    return { word: 'ok', bytes: entry.bytes, first, released, ...(hold ? { release: releaser(entry) } : {}) };
  }

  function drop() {
    const released = window.length;
    sendOrd = low();
    maxServed = sendOrd - 1;
    leave(window);
    window = [];
    return released;
  }

  function clear() {
    const released = window.length;
    leave(window);
    window = [];
    return released;
  }

  return {
    check,
    put,
    take,
    drop,
    clear,
    bytesTotal,
    bytesDone: () => startedBytes + passedBytes,
    next: () => position(sendOrd),
    parts: () => window.length,
    windowBytes: () => window.reduce((sum, entry) => sum + entry.bytes.length, 0),
    streamParts: () => streaming.size,
    streamBytes: () => [...streaming].reduce((sum, entry) => sum + entry.bytes.length, 0),
  };
}

module.exports = { createTransferWindow, parseResume };
