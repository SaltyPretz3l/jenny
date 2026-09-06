const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTextCursor,
  resetCursor,
  beginSegment,
  readDelta,
  seedContent,
} = require('../renderer/chat/renderer-stream-text-cursor');

function cursorOffsets(cursor) {
  return {
    aggregateOffset: cursor.aggregateOffset,
    segmentBaseOffset: cursor.segmentBaseOffset,
    _lastAggregateLength: cursor._lastAggregateLength,
  };
}

test('monotonic aggregate deltas yield each suffix and cumulative pending content', () => {
  const cursor = createTextCursor();
  assert.deepEqual(cursor, { aggregateOffset: 0, segmentBaseOffset: 0 });

  const first = readDelta(cursor, { aggregate: 'Hello' }, { basisContent: '' });
  assert.deepEqual(first, {
    regressed: false,
    segmentContent: 'Hello',
    pendingContent: 'Hello',
    lengthMismatch: false,
  });

  const second = readDelta(cursor, { aggregate: 'Hello world' }, { basisContent: '' });
  assert.deepEqual(second, {
    regressed: false,
    segmentContent: ' world',
    pendingContent: 'Hello world',
    lengthMismatch: false,
  });
});

test('payload content wins when the aggregate also grows', () => {
  const cursor = createTextCursor();
  readDelta(cursor, { aggregate: 'Hello' }, { basisContent: '' });

  const result = readDelta(
    cursor,
    { content: ' provider delta', aggregate: 'Hello aggregate suffix' },
    { basisContent: '' }
  );

  assert.equal(result.segmentContent, ' provider delta');
  assert.equal(result.pendingContent, 'Hello aggregate suffix');
});

test('empty payload content deliberately falls through to the aggregate suffix', () => {
  const cursor = createTextCursor();
  readDelta(cursor, { aggregate: 'Hello' }, { basisContent: '' });

  // The production contract deliberately uses `payloadContent || aggregateDelta`,
  // so an empty-string payload must not suppress a newly grown aggregate suffix.
  const result = readDelta(
    cursor,
    { content: '', aggregate: 'Hello world' },
    { basisContent: '' }
  );

  assert.equal(result.segmentContent, ' world');
});

test('shorter aggregates regress without moving offsets while equal lengths do not', () => {
  const cursor = createTextCursor();
  readDelta(cursor, { aggregate: 'abcde' }, { basisContent: '' });
  const beforeRegression = cursorOffsets(cursor);

  const regressed = readDelta(cursor, { aggregate: 'abc' }, { basisContent: '' });
  assert.equal(regressed.regressed, true);
  assert.deepEqual(cursorOffsets(cursor), beforeRegression);

  const equal = readDelta(cursor, { aggregate: 'abcde' }, { basisContent: '' });
  assert.deepEqual(equal, {
    regressed: false,
    segmentContent: '',
    pendingContent: 'abcde',
    lengthMismatch: false,
  });
  assert.deepEqual(cursorOffsets(cursor), beforeRegression);
});

test('a no-aggregate delta appends to basis content without moving offsets', () => {
  const cursor = createTextCursor();
  readDelta(cursor, { aggregate: 'Hello' }, { basisContent: '' });
  const beforeDelta = cursorOffsets(cursor);

  const result = readDelta(cursor, { content: '!' }, { basisContent: 'Hello' });

  assert.deepEqual(result, {
    regressed: false,
    segmentContent: '!',
    pendingContent: 'Hello!',
    lengthMismatch: false,
  });
  assert.deepEqual(cursorOffsets(cursor), beforeDelta);
});

test('beginSegment keeps pending content anchored at the W3.6 tool boundary', () => {
  const cursor = createTextCursor();
  const preamble = 'Let me check. ';
  readDelta(cursor, { aggregate: preamble }, { basisContent: '' });

  // W3.6: a tool boundary makes the next bubble start at the current aggregate end.
  beginSegment(cursor);
  const result = readDelta(
    cursor,
    { aggregate: `${preamble}The answer is 42.` },
    { basisContent: '' }
  );

  assert.equal(result.segmentContent, 'The answer is 42.');
  assert.equal(result.pendingContent, 'The answer is 42.');
  assert.equal(seedContent(cursor, { aggregate: `${preamble}The answer is 42.` }, ''), 'The answer is 42.');
});

test('resetCursor zeroes every offset and the next delta behaves like the first', () => {
  const cursor = createTextCursor();
  readDelta(cursor, { aggregate: 'old response' }, { basisContent: '' });
  beginSegment(cursor);

  resetCursor(cursor);
  assert.deepEqual(cursorOffsets(cursor), {
    aggregateOffset: 0,
    segmentBaseOffset: 0,
    _lastAggregateLength: 0,
  });

  const result = readDelta(cursor, { aggregate: 'new response' }, { basisContent: '' });
  assert.deepEqual(result, {
    regressed: false,
    segmentContent: 'new response',
    pendingContent: 'new response',
    lengthMismatch: false,
  });
});

// Reference implementation transcribed from the pre-extraction arithmetic in
// renderer-stream-handler-live-events.js:318-350. It is intentionally local so
// randomized comparisons catch any semantic drift in the extracted module.
function referenceReadDelta(cursor, payload, options = {}) {
  const hasAggregate = Object.prototype.hasOwnProperty.call(payload, 'aggregate');
  const fullAggregate = hasAggregate ? String(payload.aggregate || '') : '';
  const payloadContent = String(payload.content || '');
  const aggregateCursor = Number(cursor.aggregateOffset) || 0;
  const aggregateDelta = hasAggregate && fullAggregate.length > aggregateCursor
    ? fullAggregate.substring(aggregateCursor)
    : '';
  const segmentContent = payloadContent || aggregateDelta;
  if (
    hasAggregate
    && cursor._lastAggregateLength > 0
    && fullAggregate.length < cursor._lastAggregateLength
  ) {
    // lengthMismatch has no pre-change counterpart; a payload that always
    // carries an aggregate can never mismatch, so the reference pins false.
    return { regressed: true, segmentContent, pendingContent: '', lengthMismatch: false };
  }
  if (hasAggregate) {
    cursor._lastAggregateLength = fullAggregate.length;
    cursor.aggregateOffset = fullAggregate.length;
  }
  let pendingContent;
  if (hasAggregate) {
    pendingContent = fullAggregate.substring(Number(cursor.segmentBaseOffset) || 0);
  } else {
    pendingContent = `${options.basisContent}${segmentContent}`;
  }
  return { regressed: false, segmentContent, pendingContent, lengthMismatch: false };
}

function referenceBeginSegment(cursor) {
  cursor.aggregateOffset = cursor._lastAggregateLength || 0;
  cursor.segmentBaseOffset = cursor._lastAggregateLength || 0;
}

function referenceResetCursor(cursor) {
  cursor.aggregateOffset = 0;
  cursor._lastAggregateLength = 0;
  cursor.segmentBaseOffset = 0;
}

function createRandom(seed) {
  let state = seed >>> 0;
  return function random() {
    state = ((state * 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomChunk(random) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz ';
  const length = 1 + Math.floor(random() * 8);
  let chunk = '';
  for (let index = 0; index < length; index += 1) {
    chunk += alphabet[Math.floor(random() * alphabet.length)];
  }
  return chunk;
}

test('extracted cursor matches the pre-change arithmetic over 750 randomized payloads', (t) => {
  const random = createRandom(0x5eedc0de);
  const actualCursor = createTextCursor();
  const referenceCursor = { aggregateOffset: 0, segmentBaseOffset: 0 };
  let aggregate = '';
  let basisContent = '';
  const payloadCount = 750;

  for (let index = 0; index < payloadCount; index += 1) {
    if (index > 0 && index % 47 === 0) {
      resetCursor(actualCursor);
      referenceResetCursor(referenceCursor);
      aggregate = '';
      basisContent = '';
    } else if (index > 0 && index % 29 === 0) {
      beginSegment(actualCursor);
      referenceBeginSegment(referenceCursor);
      basisContent = '';
    }

    const payload = {};
    switch (index % 6) {
      case 0:
        aggregate += randomChunk(random);
        payload.aggregate = aggregate;
        break;
      case 1:
        payload.aggregate = aggregate;
        break;
      case 2: {
        const shorterLength = aggregate.length > 0
          ? Math.floor(random() * aggregate.length)
          : 0;
        aggregate = aggregate.substring(0, shorterLength);
        payload.aggregate = aggregate;
        break;
      }
      case 3:
        aggregate += randomChunk(random);
        payload.aggregate = aggregate;
        payload.content = `payload-${index}`;
        break;
      case 4:
        aggregate += randomChunk(random);
        payload.aggregate = aggregate;
        payload.content = '';
        break;
      default: {
        const contentVariant = Math.floor(index / 6) % 3;
        if (contentVariant === 1) payload.content = randomChunk(random);
        if (contentVariant === 2) payload.content = '';
        basisContent += randomChunk(random);
        break;
      }
    }

    const actual = readDelta(actualCursor, payload, { basisContent });
    const expected = referenceReadDelta(referenceCursor, payload, { basisContent });
    assert.deepEqual(actual, expected, `result mismatch at payload ${index}`);
    assert.deepEqual(
      cursorOffsets(actualCursor),
      cursorOffsets(referenceCursor),
      `offset mismatch at payload ${index}`
    );
  }

  t.diagnostic(`${payloadCount} randomized payloads completed with zero mismatches`);
});
