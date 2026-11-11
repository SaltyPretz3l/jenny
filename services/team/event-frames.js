'use strict';

// The team event stream's frame parser (TEAM_CHAT_SPEC "2a-4a as built"). Fed
// raw response chunks, it returns the complete frames they finish, in order, as
// `{ id, event, data }` (a field the frame did not carry is null; several data
// lines are joined with "\n", as the event-stream format says). Lines end with
// "\n" (a "\r" before it is dropped), so a multi-byte character split across
// chunks is decoded whole. Comment lines and blocks with no field (the host's
// heartbeat) yield nothing; unknown fields are ignored.
//
// Bounded: a frame's bytes (every line of it with its line ending, not the blank
// line that ends it) may not pass MAX_FRAME_BYTES. A longer frame, or bytes that
// are not UTF-8, is a protocol error; the parser then stays failed and returns
// nothing more. A partial line is held in one doubling buffer, so memory stays
// within twice the bytes held however small the chunks. Pure: no timers, no I/O,
// nothing logged.

const MAX_FRAME_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;
const EMPTY = Buffer.alloc(0);
// A partial-line buffer larger than this is released once its line ends.
const KEEP_BYTES = 64 * 1024;

function createFrameParser({ maxFrameBytes = MAX_FRAME_BYTES } = {}) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  // The current line so far, in one buffer that doubles as it grows (memory stays within twice the
  // bytes held, however small the chunks), and the bytes of the current frame's finished lines.
  let partial = EMPTY;
  let partialBytes = 0;
  let frameBytes = 0;
  let fields = null;
  let error = null;

  function resetFrame() {
    fields = null;
    frameBytes = 0;
  }

  // Applies one finished line (bytes without the "\n"); returns a frame when the line ends one.
  function line(bytes) {
    let text;
    try { text = decoder.decode(bytes); } catch { error = 'event_frame_invalid'; return null; }
    if (text.endsWith('\r')) text = text.slice(0, -1);
    if (text === '') {
      const done = fields;
      resetFrame();
      return done;
    }
    frameBytes += bytes.length + 1;
    if (frameBytes > maxFrameBytes) { error = 'event_frame_too_large'; return null; }
    if (text.startsWith(':')) return null;
    const colon = text.indexOf(':');
    const name = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (name !== 'id' && name !== 'event' && name !== 'data') return null;
    fields ||= { id: null, event: null, data: null };
    if (name === 'data') fields.data = fields.data === null ? value : `${fields.data}\n${value}`;
    else fields[name] = value;
    return null;
  }

  function keep(piece) {
    const needed = partialBytes + piece.length;
    if (needed > partial.length) {
      const grown = Buffer.allocUnsafe(Math.max(needed, partial.length * 2, 256));
      partial.copy(grown, 0, 0, partialBytes);
      partial = grown;
    }
    piece.copy(partial, partialBytes);
    partialBytes = needed;
  }

  function releasePartial() {
    if (partial.length > KEEP_BYTES) partial = EMPTY;
    partialBytes = 0;
  }

  /** Feeds one chunk; returns { frames, error } where error is null or a reason. */
  function push(chunk) {
    const frames = [];
    if (error) return { frames, error };
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(NEWLINE, start);
      if (end === -1) {
        if (frameBytes + partialBytes + (chunk.length - start) > maxFrameBytes) { error = 'event_frame_too_large'; break; }
        keep(chunk.subarray(start));
        break;
      }
      const piece = chunk.subarray(start, end);
      const bytes = partialBytes ? Buffer.concat([partial.subarray(0, partialBytes), piece]) : piece;
      releasePartial();
      start = end + 1;
      const done = line(bytes);
      if (error) break;
      if (done) frames.push(done);
    }
    if (error) { partial = EMPTY; partialBytes = 0; resetFrame(); }
    return { frames, error };
  }

  // For tests: the bytes the partial-line buffer holds on to (its capacity, not its fill).
  return { push, retainedBytes: () => partial.length };
}

module.exports = { MAX_FRAME_BYTES, createFrameParser };
