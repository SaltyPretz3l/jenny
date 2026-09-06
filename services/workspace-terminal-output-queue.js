'use strict';

const DEFAULT_MAX_BUFFERED_BYTES = 256 * 1024;
const DEFAULT_MAX_EVENT_BYTES = 64 * 1024;

function positiveInt(value, fallback) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createTerminalOutputQueue({
  emit,
  log = null,
  maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES,
  maxEventBytes = DEFAULT_MAX_EVENT_BYTES,
  schedule = (callback) => { queueMicrotask(callback); return null; },
  cancel = null,
} = {}) {
  const bufferCap = positiveInt(maxBufferedBytes, DEFAULT_MAX_BUFFERED_BYTES);
  const eventCap = Math.min(positiveInt(maxEventBytes, DEFAULT_MAX_EVENT_BYTES), bufferCap);
  const emitChunk = typeof emit === 'function' ? emit : () => {};
  const logDrop = typeof log === 'function' ? log : null;
  const scheduleFlush = typeof schedule === 'function' ? schedule : (callback) => queueMicrotask(callback);
  const cancelFlush = typeof cancel === 'function' ? cancel : null;
  let chunks = [];
  let bufferedBytes = 0;
  let droppedBytes = 0;
  let scheduled = false;
  let scheduleHandle = null;
  let disposed = false;

  function trimToBufferCap() {
    let excess = bufferedBytes - bufferCap;
    while (excess > 0 && chunks.length) {
      const first = chunks[0];
      if (first.data.length <= excess) {
        chunks.shift();
        bufferedBytes -= first.data.length;
        droppedBytes += first.data.length;
        excess -= first.data.length;
      } else {
        first.data = first.data.subarray(excess);
        bufferedBytes -= excess;
        droppedBytes += excess;
        excess = 0;
      }
    }
  }

  // A byte-cap slice can start inside a multibyte UTF-8 character (both the
  // head trim in trimToBufferCap and the per-event tail cap below). Skipping
  // any leading continuation bytes (0b10xxxxxx) realigns the slice to a
  // character boundary so the decoded text never opens with U+FFFD (JCA-009).
  function alignToUtf8Boundary(buffer) {
    let offset = 0;
    while (offset < buffer.length && (buffer[offset] & 0xC0) === 0x80) {
      offset += 1;
    }
    return offset === 0 ? buffer : buffer.subarray(offset);
  }

  function flush() {
    if (disposed) return;
    scheduled = false;
    scheduleHandle = null;
    if (!chunks.length) return;
    const batch = chunks;
    let totalDropped = droppedBytes;
    chunks = [];
    bufferedBytes = 0;
    droppedBytes = 0;
    // JCA-009: coalesce only ADJACENT same-stream chunks so run order is
    // preserved. Grouping the whole batch by stream delivered stdout A,
    // stderr B, stdout C as "AC" then "B", misstating compiler/test output
    // order across the stdout/stderr boundary.
    const deliveries = [];
    for (const entry of batch) {
      const last = deliveries[deliveries.length - 1];
      if (last && last.stream === entry.stream) {
        last.buffers.push(entry.data);
      } else {
        deliveries.push({ stream: entry.stream, buffers: [entry.data] });
      }
    }
    const events = [];
    for (const delivery of deliveries) {
      let combined = Buffer.concat(delivery.buffers);
      if (combined.length > eventCap) {
        totalDropped += combined.length - eventCap;
        combined = combined.subarray(combined.length - eventCap);
      }
      const aligned = alignToUtf8Boundary(combined);
      totalDropped += combined.length - aligned.length;
      if (!aligned.length) continue;
      events.push({ stream: delivery.stream, text: aligned.toString('utf8') });
    }
    if (totalDropped > 0) logDrop?.(totalDropped);
    events.forEach((event, index) => {
      emitChunk(event.stream, event.text, index === 0 ? totalDropped : 0);
    });
  }

  function push(stream, value) {
    if (disposed) return;
    const data = Buffer.from(String(value ?? ''), 'utf8');
    if (!data.length) return;
    chunks.push({ stream: String(stream || 'stdout'), data });
    bufferedBytes += data.length;
    trimToBufferCap();
    if (!scheduled) {
      scheduled = true;
      scheduleHandle = scheduleFlush(flush);
    }
  }

  function dispose({ flushPending = false } = {}) {
    if (disposed) return;
    if (flushPending) flush();
    disposed = true;
    if (scheduled && cancelFlush && scheduleHandle != null) {
      try { cancelFlush(scheduleHandle); } catch (_error) { /* best-effort */ }
    }
    scheduled = false;
    scheduleHandle = null;
    chunks = [];
    bufferedBytes = 0;
    droppedBytes = 0;
  }

  return { push, flush, dispose };
}

module.exports = {
  createTerminalOutputQueue,
};
