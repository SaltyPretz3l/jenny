const {
  normalizeJennyLevel,
  resolveStructuredLogLevel,
} = require('../log-level-utils');

// Hard ceiling on the *unterminated* line accumulator. A child that writes a
// multi-megabyte blob with no newline (a vendor CLI dumping a base64 payload, a
// crashing engine spewing a heap snapshot) used to grow `pending` without any
// bound at all, in the main process, until the string hit the V8 limit or the
// box swapped. 256 KiB is far past any legitimate log line and still cheap.
//
// The bound is in UTF-8 BYTES, not characters: the threat is memory, and a
// character count under-counts by up to 4x for non-ASCII output (a CJK or
// emoji-heavy crash dump would sail past a 256k *character* cap at ~750 KiB).
const MAX_PENDING_LINE_BYTES = 256 * 1024;

function normalizeLogger(logger) {
  return typeof logger === 'function' ? logger : () => {};
}

function normalizeMaxLineBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return MAX_PENDING_LINE_BYTES;
  }
  return Math.floor(parsed);
}

/**
 * Trim ``text`` to at most ``maxBytes`` UTF-8 bytes without slicing a
 * multi-byte sequence in half (which would decode to a replacement char and
 * corrupt the retained prefix).
 */
function truncateToUtf8Bytes(text, maxBytes) {
  // UTF-8 byte length is always >= JS string length, so a short string cannot
  // exceed the bound. Skips the Buffer allocation on every ordinary log line.
  if (text.length <= maxBytes) {
    return { text, bytes: text.length, droppedBytes: 0 };
  }
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) {
    return { text, bytes: buffer.length, droppedBytes: 0 };
  }
  let end = maxBytes;
  // Walk back off any continuation byte (0b10xxxxxx) so the cut lands on a
  // code-point boundary.
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return {
    text: buffer.subarray(0, end).toString('utf8'),
    bytes: end,
    droppedBytes: buffer.length - end,
  };
}

function resolveOutputLevel({ resolver, line, streamName, defaultLevel }) {
  const fallback = normalizeJennyLevel(defaultLevel, 'INFO');
  try {
    const resolved = resolver({ line, stream: streamName, defaultLevel: fallback });
    return resolved === null ? null : normalizeJennyLevel(resolved, fallback);
  } catch (_error) {
    return fallback;
  }
}

function pipeChildLogs(child, {
  logger, prefix, resolveLevel, onOutput, maxLineBytes,
} = {}) {
  const log = normalizeLogger(logger);
  const eventPrefix = String(prefix || 'child.process').trim() || 'child.process';
  const hasResolver = typeof resolveLevel === 'function';
  const hasOutputSink = typeof onOutput === 'function';
  const lineByteLimit = normalizeMaxLineBytes(maxLineBytes);
  const createLineHandler = (defaultLevel, streamName) => {
    let pending = '';
    // Bytes discarded from the line currently being accumulated. Reset once
    // that line is emitted so the counter reports per-line loss, not a
    // process-lifetime total that nobody can act on.
    let droppedLineBytes = 0;
    let overflowReported = false;
    const reportTruncation = (droppedBytes) => {
      if (overflowReported) {
        return;
      }
      // Actionable: a child producing a line this large is malfunctioning, and
      // the retained log line is now only a prefix — say so once per oversize
      // line rather than once per chunk.
      overflowReported = true;
      log('WARN', `${eventPrefix}.output_truncated`, {
        stream: streamName,
        maxLineBytes: lineByteLimit,
        droppedBytes,
      });
    };
    const emitLine = (rawLine) => {
      const carriedDroppedBytes = droppedLineBytes;
      droppedLineBytes = 0;
      // A complete oversize line can arrive inside a single chunk, so the bound
      // applies here too — not only to the unterminated remainder.
      const bounded = truncateToUtf8Bytes(rawLine, lineByteLimit);
      const droppedBytes = carriedDroppedBytes + bounded.droppedBytes;
      if (bounded.droppedBytes > 0) {
        reportTruncation(droppedBytes);
      }
      overflowReported = false;
      const trimmed = bounded.text.trim();
      if (!trimmed) {
        return;
      }
      let level = defaultLevel;
      if (hasResolver) {
        level = resolveOutputLevel({
          resolver: resolveLevel,
          line: trimmed,
          streamName,
          defaultLevel,
        });
      }
      const details = { stream: streamName, line: trimmed };
      if (droppedBytes > 0) {
        details.truncated = true;
        details.droppedBytes = droppedBytes;
      }
      if (level !== null) {
        log(level, `${eventPrefix}.output`, details);
      }
      if (hasOutputSink) {
        try {
          onOutput({ stream: streamName, line: trimmed, level });
        } catch (_error) {
          // best effort — a faulty sink must never break log piping
        }
      }
    };
    const boundPending = () => {
      const result = truncateToUtf8Bytes(pending, lineByteLimit);
      if (result.droppedBytes <= 0) {
        return;
      }
      pending = result.text;
      droppedLineBytes += result.droppedBytes;
      reportTruncation(droppedLineBytes);
    };
    const handleChunk = (chunk) => {
      pending += String(chunk || '');
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      for (const line of lines) {
        emitLine(line);
      }
      boundPending();
    };
    handleChunk.flush = () => {
      if (!pending) {
        return;
      }
      const line = pending;
      pending = '';
      emitLine(line);
    };
    return handleChunk;
  };
  if (child.stdout) {
    child.stdout.setEncoding('utf8');
    const handleStdout = createLineHandler('DEBUG', 'stdout');
    child.stdout.on('data', handleStdout);
    child.stdout.on('end', handleStdout.flush);
    child.stdout.on('close', handleStdout.flush);
  }
  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    const handleStderr = createLineHandler('WARN', 'stderr');
    child.stderr.on('data', handleStderr);
    child.stderr.on('end', handleStderr.flush);
    child.stderr.on('close', handleStderr.flush);
  }
}

module.exports = {
  MAX_PENDING_LINE_BYTES,
  pipeChildLogs,
  resolveStructuredLogLevel,
};
