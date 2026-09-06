const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  MAX_FRAME_BYTES,
  MAX_HEADER_BYTES,
  SidecarClient,
} = require('../services/backend/sidecar-client');

const FRAME_SEPARATOR = Buffer.from('\r\n\r\n', 'utf8');

function buildBodyFrame(bodyValue) {
  const body = Buffer.isBuffer(bodyValue) ? bodyValue : Buffer.from(bodyValue, 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8');
  return Buffer.concat([header, body]);
}

function buildFrame(sequence, payload = {}) {
  return buildBodyFrame(JSON.stringify({
    jsonrpc: '2.0',
    method: 'test.event',
    params: { sequence, ...payload },
  }));
}

function createMockProcess() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stdin = new EventEmitter();
  proc.stdin.write = () => true;
  return proc;
}

function createHarness() {
  const client = new SidecarClient();
  const proc = createMockProcess();
  const notifications = [];
  client.on('notification', (message) => notifications.push(message));
  client.attachProcess(proc);
  return { client, proc, notifications };
}

function feed(proc, chunk) {
  proc.stdout.emit('data', chunk);
}

function sequences(notifications) {
  return notifications.map((message) => message.params.sequence);
}

test('one whole frame in one callback is parsed without concatenating', () => {
  const { proc, notifications } = createHarness();
  const frame = buildFrame('whole');
  const originalConcat = Buffer.concat;
  let concatCalls = 0;
  Buffer.concat = (...args) => {
    concatCalls += 1;
    return originalConcat(...args);
  };
  try {
    feed(proc, frame);
  } finally {
    Buffer.concat = originalConcat;
  }

  assert.deepEqual(sequences(notifications), ['whole']);
  assert.equal(concatCalls, 0);
});

test('several whole frames in one callback are delivered in order', () => {
  const { proc, notifications } = createHarness();
  feed(proc, Buffer.concat([
    buildFrame('first'),
    buildFrame('second'),
    buildFrame('third'),
  ]));

  assert.deepEqual(sequences(notifications), ['first', 'second', 'third']);
});

const splitFrame = buildFrame('split');
const splitBodyStart = splitFrame.indexOf(FRAME_SEPARATOR) + FRAME_SEPARATOR.length;
const splitCases = [
  ['mid-header', Math.floor((splitBodyStart - FRAME_SEPARATOR.length) / 2)],
  ['at the header separator', splitBodyStart],
  ['one byte into the body', splitBodyStart + 1],
  ['one byte before the body end', splitFrame.length - 1],
];

for (const [name, splitAt] of splitCases) {
  test(`a frame split ${name} is reassembled`, () => {
    const { proc, notifications } = createHarness();
    feed(proc, splitFrame.subarray(0, splitAt));
    feed(proc, splitFrame.subarray(splitAt));

    assert.deepEqual(sequences(notifications), ['split']);
  });
}

// Regression guard for the completeness check at a NON-ZERO read cursor: a
// whole frame, then a second frame whose header is complete but whose body is
// not. Every other split case breaks out at the missing-separator branch and
// never reaches that check with bufferOffset > 0, so a guard that measured
// buffer.length instead of the bytes remaining after the cursor would drive the
// cursor past the end of the buffer and silently drop the second frame -- with
// the rest of this suite still green.
test('a complete frame followed by a header-complete partial frame is reassembled', () => {
  const { proc, notifications } = createHarness();
  const firstFrame = buildFrame('complete');
  const secondFrame = buildFrame('partial');
  const secondHeaderEnd = secondFrame.indexOf(FRAME_SEPARATOR) + FRAME_SEPARATOR.length;
  const cut = firstFrame.length + secondHeaderEnd + 3;
  const stream = Buffer.concat([firstFrame, secondFrame]);

  feed(proc, stream.subarray(0, cut));
  assert.deepEqual(sequences(notifications), ['complete']);

  feed(proc, stream.subarray(cut));
  assert.deepEqual(sequences(notifications), ['complete', 'partial']);
});

test('a frame delivered one byte at a time is reassembled', () => {
  const { proc, notifications } = createHarness();
  const frame = buildFrame('bytewise');
  for (let index = 0; index < frame.length; index += 1) {
    feed(proc, frame.subarray(index, index + 1));
  }

  assert.deepEqual(sequences(notifications), ['bytewise']);
});

test('small and large frames interleaved in one callback stay synchronized', () => {
  const { proc, notifications } = createHarness();
  feed(proc, Buffer.concat([
    buildFrame('small-1'),
    buildFrame('large-1', { text: 'x'.repeat(128 * 1024) }),
    buildFrame('small-2'),
    buildFrame('large-2', { text: 'y'.repeat(96 * 1024) }),
  ]));

  assert.deepEqual(sequences(notifications), ['small-1', 'large-1', 'small-2', 'large-2']);
});

test('a tiny partial frame after a large frame resumes on the next callback', () => {
  const { proc, notifications } = createHarness();
  const largeFrame = buildFrame('large', { text: 'x'.repeat(128 * 1024) });
  const nextFrame = buildFrame('after-large');
  feed(proc, Buffer.concat([largeFrame, nextFrame.subarray(0, 3)]));
  feed(proc, nextFrame.subarray(3));

  assert.deepEqual(sequences(notifications), ['large', 'after-large']);
});

test('literal separator bytes inside a body do not desynchronize framing', () => {
  const { proc, notifications } = createHarness();
  const body = '{\r\n\r\n"jsonrpc":"2.0","method":"test.event","params":{"sequence":"body-separator"}}';
  feed(proc, buildBodyFrame(body));

  assert.deepEqual(sequences(notifications), ['body-separator']);
});

test('multi-byte UTF-8 split mid-character is reassembled by byte length', () => {
  const { proc, notifications } = createHarness();
  const text = '\u4f60\u597d \ud83d\ude80';
  const body = Buffer.from(JSON.stringify({
    jsonrpc: '2.0', method: 'test.event', params: { sequence: 'utf8', text },
  }), 'utf8');
  const frame = buildBodyFrame(body);
  const bodyStart = frame.indexOf(FRAME_SEPARATOR) + FRAME_SEPARATOR.length;
  const emojiStart = body.indexOf(Buffer.from('\ud83d\ude80', 'utf8'));
  const splitAt = bodyStart + emojiStart + 2;
  feed(proc, frame.subarray(0, splitAt));
  feed(proc, frame.subarray(splitAt));

  assert.equal(notifications[0].params.text, text);
  assert.deepEqual(sequences(notifications), ['utf8']);
});

test('malformed JSON emits parse-error and the following frame is delivered', () => {
  const { client, proc, notifications } = createHarness();
  const parseErrors = [];
  client.on('parse-error', (error) => parseErrors.push(error));
  feed(proc, Buffer.concat([
    buildBodyFrame('{"jsonrpc":'),
    buildFrame('after-malformed'),
  ]));

  assert.equal(parseErrors.length, 1);
  assert.ok(parseErrors[0] instanceof SyntaxError);
  assert.deepEqual(sequences(notifications), ['after-malformed']);
});

const failureCases = [
  {
    name: 'header without a separator exceeds the limit',
    expected: 'Sidecar transport header exceeded the maximum allowed size.',
    chunks: () => [Buffer.alloc(MAX_HEADER_BYTES + 1, 0x78)],
  },
  {
    name: 'separator appears beyond the header limit',
    expected: 'Sidecar transport header exceeded the maximum allowed size.',
    chunks: () => [Buffer.concat([
      Buffer.alloc(MAX_HEADER_BYTES + 1, 0x78),
      FRAME_SEPARATOR,
    ])],
  },
  {
    name: 'buffered frame exceeds the frame limit',
    expected: 'Sidecar transport exceeded the maximum buffered frame size.',
    chunks: () => [Buffer.concat([
      Buffer.from(`Content-Length: ${MAX_FRAME_BYTES}\r\n\r\n`, 'utf8'),
      Buffer.alloc(MAX_FRAME_BYTES + 1, 0x61),
    ])],
  },
  {
    name: 'declared content length exceeds the frame limit',
    expected: 'Sidecar transport declared an invalid frame size.',
    chunks: () => [
      Buffer.from(`Content-Length: ${MAX_FRAME_BYTES + 1}\r\n\r\n`, 'utf8'),
    ],
  },
];

for (const { name, expected, chunks } of failureCases) {
  test(`${name} fails with the exact transport message`, () => {
    const { client, proc } = createHarness();
    const errors = [];
    client.on('error', (error) => errors.push(error));
    for (const chunk of chunks()) feed(proc, chunk);

    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, expected);
    assert.equal(client.connected, false);
  });
}

test('a transport failure resets the cursor before a later attachment', () => {
  const { client, proc, notifications } = createHarness();
  const errors = [];
  client.on('error', (error) => errors.push(error));
  feed(proc, Buffer.concat([
    buildFrame('before-failure'),
    Buffer.alloc(MAX_HEADER_BYTES + 1, 0x78),
  ]));

  assert.equal(errors[0].message, 'Sidecar transport header exceeded the maximum allowed size.');
  const replacement = createMockProcess();
  client.attachProcess(replacement);
  feed(replacement, buildFrame('after-reset'));

  assert.deepEqual(sequences(notifications), ['before-failure', 'after-reset']);
  assert.equal(client.connected, true);
});
