const { EventEmitter } = require('events');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_PENDING_LINE_BYTES,
  pipeChildLogs,
  resolveStructuredLogLevel,
} = require('../services/backend/child-process-logging');

function createStream() {
  const stream = new EventEmitter();
  stream.encoding = '';
  stream.setEncoding = (encoding) => {
    stream.encoding = encoding;
  };
  return stream;
}

test('pipeChildLogs keeps default stdout DEBUG and stderr WARN levels', () => {
  const stdout = createStream();
  const stderr = createStream();
  const logs = [];

  pipeChildLogs({ stdout, stderr }, {
    prefix: 'child.test',
    logger: (level, event, details) => logs.push({ level, event, details }),
  });

  stdout.emit('data', 'ready\n');
  stderr.emit('data', 'plain stderr warning\n');

  assert.deepEqual(logs, [
    {
      level: 'DEBUG',
      event: 'child.test.output',
      details: { stream: 'stdout', line: 'ready' },
    },
    {
      level: 'WARN',
      event: 'child.test.output',
      details: { stream: 'stderr', line: 'plain stderr warning' },
    },
  ]);
});

test('pipeChildLogs lets a caller resolve each output line level', () => {
  const stderr = createStream();
  const seen = [];
  const logs = [];

  pipeChildLogs({ stderr }, {
    prefix: 'ollama',
    logger: (level, event, details) => logs.push({ level, event, details }),
    resolveLevel: ({ line, stream, defaultLevel }) => {
      seen.push({ line, stream, defaultLevel });
      return resolveStructuredLogLevel({ line, defaultLevel });
    },
  });

  stderr.emit('data', [
    'time=2026-04-29T16:03:23 level=INFO msg="server config"',
    'time=2026-04-29T16:03:24 level=ERROR msg="startup failed"',
    'unstructured stderr line',
  ].join('\n') + '\n');

  assert.deepEqual(seen, [
    {
      line: 'time=2026-04-29T16:03:23 level=INFO msg="server config"',
      stream: 'stderr',
      defaultLevel: 'WARN',
    },
    {
      line: 'time=2026-04-29T16:03:24 level=ERROR msg="startup failed"',
      stream: 'stderr',
      defaultLevel: 'WARN',
    },
    {
      line: 'unstructured stderr line',
      stream: 'stderr',
      defaultLevel: 'WARN',
    },
  ]);
  assert.deepEqual(
    logs.map((entry) => entry.level),
    ['INFO', 'ERROR', 'WARN']
  );
});

test('pipeChildLogs drops null-resolved lines after notifying onOutput', () => {
  const stderr = createStream();
  const logs = [];
  const seen = [];

  pipeChildLogs({ stderr }, {
    prefix: 'ollama',
    logger: (level, event, details) => logs.push({ level, event, details }),
    resolveLevel: ({ line }) => line === 'drop me' ? null : 'unknown-level',
    onOutput: (output) => seen.push(output),
  });

  stderr.emit('data', 'drop me\nkeep me\n');

  assert.deepEqual(logs, [{
    level: 'WARN',
    event: 'ollama.output',
    details: { stream: 'stderr', line: 'keep me' },
  }]);
  assert.deepEqual(seen, [
    { stream: 'stderr', line: 'drop me', level: null },
    { stream: 'stderr', line: 'keep me', level: 'WARN' },
  ]);
});

test('pipeChildLogs buffers fragmented output until complete lines are available', () => {
  const stderr = createStream();
  const logs = [];

  pipeChildLogs({ stderr }, {
    prefix: 'ollama',
    logger: (level, event, details) => logs.push({ level, event, details }),
    resolveLevel: ({ line, defaultLevel }) => resolveStructuredLogLevel({ line, defaultLevel }),
  });

  stderr.emit('data', 'time=2026-04-29T16:03:23 lev');

  assert.deepEqual(logs, []);

  stderr.emit('data', 'el=INFO msg="server config"\nplain final stderr line');

  assert.deepEqual(logs, [
    {
      level: 'INFO',
      event: 'ollama.output',
      details: {
        stream: 'stderr',
        line: 'time=2026-04-29T16:03:23 level=INFO msg="server config"',
      },
    },
  ]);

  stderr.emit('end');

  assert.deepEqual(logs[1], {
    level: 'WARN',
    event: 'ollama.output',
    details: { stream: 'stderr', line: 'plain final stderr line' },
  });
});

test('pipeChildLogs invokes the optional onOutput sink per emitted line', () => {
  const stdout = createStream();
  const stderr = createStream();
  const seen = [];

  pipeChildLogs({ stdout, stderr }, {
    prefix: 'ollama',
    onOutput: ({ stream, line, level }) => seen.push({ stream, line, level }),
  });

  stdout.emit('data', 'hello\n');
  stderr.emit('data', 'a warning\n');

  assert.deepEqual(seen, [
    { stream: 'stdout', line: 'hello', level: 'DEBUG' },
    { stream: 'stderr', line: 'a warning', level: 'WARN' },
  ]);
});

test('pipeChildLogs is unaffected when onOutput is omitted', () => {
  const stderr = createStream();
  const logs = [];

  pipeChildLogs({ stderr }, {
    prefix: 'ollama',
    logger: (level, event, details) => logs.push({ level, event, details }),
  });

  stderr.emit('data', 'plain line\n');

  assert.deepEqual(logs, [
    { level: 'WARN', event: 'ollama.output', details: { stream: 'stderr', line: 'plain line' } },
  ]);
});

test('pipeChildLogs swallows a throwing onOutput sink without breaking log piping', () => {
  const stderr = createStream();
  const logs = [];

  pipeChildLogs({ stderr }, {
    prefix: 'ollama',
    logger: (level, event, details) => logs.push({ level, event, details }),
    onOutput: () => {
      throw new Error('sink boom');
    },
  });

  assert.doesNotThrow(() => stderr.emit('data', 'still logged\n'));
  assert.deepEqual(logs, [
    { level: 'WARN', event: 'ollama.output', details: { stream: 'stderr', line: 'still logged' } },
  ]);
});

// F17: the unterminated-line accumulator used to be unbounded. A child that
// writes megabytes with no newline grew `pending` in the main process until V8
// or the box gave up. These pin the byte-bounded replacement.
test('pipeChildLogs bounds an unterminated line and reports the truncation once', () => {
  const stderr = createStream();
  const logs = [];

  pipeChildLogs({ stderr }, {
    prefix: 'ollama',
    logger: (level, event, details) => logs.push({ level, event, details }),
    maxLineBytes: 64,
  });

  // Three chunks, no newline anywhere: pre-fix this accumulates 300 chars.
  stderr.emit('data', 'a'.repeat(100));
  stderr.emit('data', 'b'.repeat(100));
  stderr.emit('data', 'c'.repeat(100));

  const truncationEvents = logs.filter((entry) => entry.event === 'ollama.output_truncated');
  assert.equal(truncationEvents.length, 1, 'one truncation event per oversize line, not per chunk');
  assert.equal(truncationEvents[0].level, 'WARN');
  assert.equal(truncationEvents[0].details.stream, 'stderr');
  assert.equal(truncationEvents[0].details.maxLineBytes, 64);
  assert.ok(truncationEvents[0].details.droppedBytes > 0);

  // Terminate the line: the emitted payload is the bounded prefix, annotated.
  stderr.emit('data', '\n');
  const output = logs.filter((entry) => entry.event === 'ollama.output');
  assert.equal(output.length, 1);
  assert.equal(output[0].details.line.length, 64);
  assert.equal(output[0].details.truncated, true);
  assert.equal(output[0].details.droppedBytes, 300 - 64);
});

test('pipeChildLogs bounds the accumulator in UTF-8 bytes, not characters', () => {
  const stderr = createStream();
  const logs = [];

  pipeChildLogs({ stderr }, {
    prefix: 'ollama',
    logger: (level, event, details) => logs.push({ level, event, details }),
    // 12 bytes == 4 three-byte characters. A character-count bound would have
    // let 12 characters (36 bytes) through.
    maxLineBytes: 12,
  });

  stderr.emit('data', `${'你'.repeat(20)}\n`);

  const output = logs.filter((entry) => entry.event === 'ollama.output');
  assert.equal(output.length, 1);
  assert.equal(Buffer.byteLength(output[0].details.line, 'utf8'), 12);
  // The cut landed on a code-point boundary — no U+FFFD replacement char.
  assert.equal(output[0].details.line, '你'.repeat(4));
  assert.equal(output[0].details.line.includes('�'), false);
});

test('pipeChildLogs leaves ordinary lines unannotated and re-arms per line', () => {
  const stderr = createStream();
  const logs = [];

  pipeChildLogs({ stderr }, {
    prefix: 'ollama',
    logger: (level, event, details) => logs.push({ level, event, details }),
    maxLineBytes: 32,
  });

  stderr.emit('data', `${'x'.repeat(100)}\nshort line\n${'y'.repeat(100)}\n`);

  const output = logs.filter((entry) => entry.event === 'ollama.output');
  const truncations = logs.filter((entry) => entry.event === 'ollama.output_truncated');
  assert.deepEqual(output[1].details, { stream: 'stderr', line: 'short line' });
  // Each oversize line gets its own truncation event: the flag re-arms.
  assert.equal(truncations.length, 2);
  assert.equal(output[0].details.truncated, true);
  assert.equal(output[2].details.truncated, true);
});

test('MAX_PENDING_LINE_BYTES is the default bound and is a byte count', () => {
  assert.equal(MAX_PENDING_LINE_BYTES, 256 * 1024);

  const stderr = createStream();
  const logs = [];
  pipeChildLogs({ stderr }, {
    prefix: 'ollama',
    logger: (level, event, details) => logs.push({ level, event, details }),
  });

  stderr.emit('data', 'x'.repeat(MAX_PENDING_LINE_BYTES + 10));
  const truncations = logs.filter((entry) => entry.event === 'ollama.output_truncated');
  assert.equal(truncations.length, 1);
  assert.equal(truncations[0].details.maxLineBytes, MAX_PENDING_LINE_BYTES);
});

test('resolveStructuredLogLevel maps known structured levels and preserves fallback otherwise', () => {
  assert.equal(resolveStructuredLogLevel({
    line: 'time=2026-04-29T16:03:23 level=TRACE msg="trace"',
    defaultLevel: 'WARN',
  }), 'DEBUG');
  assert.equal(resolveStructuredLogLevel({
    line: 'time=2026-04-29T16:03:23 level=DEBUG msg="debug"',
    defaultLevel: 'WARN',
  }), 'DEBUG');
  assert.equal(resolveStructuredLogLevel({
    line: 'time=2026-04-29T16:03:23 level=INFO msg="info"',
    defaultLevel: 'WARN',
  }), 'INFO');
  assert.equal(resolveStructuredLogLevel({
    line: 'time=2026-04-29T16:03:23 level=WARNING msg="warning"',
    defaultLevel: 'INFO',
  }), 'WARN');
  assert.equal(resolveStructuredLogLevel({
    line: 'time=2026-04-29T16:03:23 level=FATAL msg="fatal"',
    defaultLevel: 'INFO',
  }), 'ERROR');
  assert.equal(resolveStructuredLogLevel({
    line: 'plain stderr warning',
    defaultLevel: 'WARN',
  }), 'WARN');
  assert.equal(resolveStructuredLogLevel({
    line: 'time=2026-04-29T16:03:23 msg="contains level=ERROR in text"',
    defaultLevel: 'WARN',
  }), 'WARN');
  assert.equal(resolveStructuredLogLevel({
    line: 'time=2026-04-29T16:03:23 level=NOTICE msg="unknown"',
    defaultLevel: 'WARN',
  }), 'WARN');
});
