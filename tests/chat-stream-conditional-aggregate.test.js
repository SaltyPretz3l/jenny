const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mergeDeltaPayloads,
} = require('../services/chat-stream-bridge-support');
const {
  aggregateLengthOf,
  createTextCursor,
  readDelta,
  seedContent,
} = require('../renderer/chat/renderer-stream-text-cursor');

function referenceMergeDeltaPayloads(existing, incoming) {
  const merged = { ...existing, ...incoming };
  const existingContent = String(existing.content || '');
  const incomingContent = String(incoming.content || '');
  if (existingContent || incomingContent) {
    merged.content = existingContent + incomingContent;
  }
  if (Object.prototype.hasOwnProperty.call(incoming, 'aggregate')) {
    merged.aggregate = incoming.aggregate;
  }
  const existingReasoning = existing.reasoning && typeof existing.reasoning === 'object'
    && !Array.isArray(existing.reasoning)
    ? existing.reasoning : null;
  const incomingReasoning = incoming.reasoning && typeof incoming.reasoning === 'object'
    && !Array.isArray(incoming.reasoning)
    ? incoming.reasoning : null;
  if (existingReasoning || incomingReasoning) {
    const existingEntries = Array.isArray(existingReasoning?.entriesDelta)
      ? existingReasoning.entriesDelta : [];
    const incomingEntries = Array.isArray(incomingReasoning?.entriesDelta)
      ? incomingReasoning.entriesDelta : [];
    const entriesDelta = existingEntries.slice();
    const entryIndexById = new Map();
    for (let index = 0; index < entriesDelta.length; index += 1) {
      const id = String(entriesDelta[index]?.id || '').trim();
      if (id && !entryIndexById.has(id)) entryIndexById.set(id, index);
    }
    for (const entry of incomingEntries) {
      const id = String(entry?.id || '').trim();
      const existingIndex = id ? entryIndexById.get(id) : undefined;
      if (Number.isInteger(existingIndex)) {
        entriesDelta[existingIndex] = entry;
      } else {
        if (id) entryIndexById.set(id, entriesDelta.length);
        entriesDelta.push(entry);
      }
    }
    merged.reasoning = {
      ...(existingReasoning || {}),
      ...(incomingReasoning || {}),
      entriesDelta,
    };
  }
  return merged;
}

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
  const pendingContent = hasAggregate
    ? fullAggregate.substring(Number(cursor.segmentBaseOffset) || 0)
    : `${String(options.basisContent || '')}${segmentContent}`;
  return { regressed: false, segmentContent, pendingContent, lengthMismatch: false };
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
  const length = 1 + Math.floor(random() * 7);
  let chunk = '';
  for (let index = 0; index < length; index += 1) {
    chunk += alphabet[Math.floor(random() * alphabet.length)];
  }
  return chunk;
}

function cursorOffsets(cursor) {
  return {
    aggregateOffset: cursor.aggregateOffset,
    segmentBaseOffset: cursor.segmentBaseOffset,
    _lastAggregateLength: cursor._lastAggregateLength,
  };
}

test('today-shaped coalesced payloads and cursor results remain byte-for-byte inert', (t) => {
  const random = createRandom(0xa11ce5ed);
  const payloads = [];
  let aggregate = '';
  for (let index = 0; index < 240; index += 1) {
    const content = randomChunk(random);
    aggregate += content;
    payloads.push({
      type: 'delta',
      streamId: 'stream-inertness',
      sessionId: 'session-inertness',
      content,
      aggregate,
      ordinal: index,
    });
  }

  const actualCursor = createTextCursor();
  const referenceCursor = { aggregateOffset: 0, segmentBaseOffset: 0 };
  let groupCount = 0;
  let payloadIndex = 0;
  let addedLengthKeyCount = 0;
  let nonFalseMismatchCount = 0;
  while (payloadIndex < payloads.length) {
    const remaining = payloads.length - payloadIndex;
    let groupWidth = Math.min(remaining, 2 + Math.floor(random() * 7));
    if (remaining - groupWidth === 1) groupWidth += 1;
    const group = payloads.slice(payloadIndex, payloadIndex + groupWidth);
    let actualMerged = { ...group[0] };
    let referenceMerged = { ...group[0] };
    for (const payload of group.slice(1)) {
      actualMerged = mergeDeltaPayloads(actualMerged, payload);
      referenceMerged = referenceMergeDeltaPayloads(referenceMerged, payload);
    }

    assert.deepEqual(
      actualMerged,
      referenceMerged,
      `legacy merged fields changed in group ${groupCount}`
    );
    // A legacy-shaped payload (aggregate, no aggregateLength) must come out of the
    // merge with no aggregateLength either. The merge used to synthesize one here,
    // which put a key on every coalesced frame that the pre-change bridge never
    // emitted -- breaking the byte-identical rollback aggregate_checkpoints=0
    // promises. This is why the comparison above no longer strips the key first.
    if (Object.prototype.hasOwnProperty.call(actualMerged, 'aggregateLength')) {
      addedLengthKeyCount += 1;
    }

    const actualResult = readDelta(actualCursor, actualMerged, { basisContent: '' });
    const referenceResult = referenceReadDelta(referenceCursor, referenceMerged, { basisContent: '' });
    assert.deepEqual(actualResult, referenceResult, `cursor result changed in group ${groupCount}`);
    assert.deepEqual(
      cursorOffsets(actualCursor),
      cursorOffsets(referenceCursor),
      `cursor offsets changed in group ${groupCount}`
    );
    if (actualResult.lengthMismatch !== false) nonFalseMismatchCount += 1;

    payloadIndex += group.length;
    groupCount += 1;
  }

  assert.equal(addedLengthKeyCount, 0);
  assert.equal(nonFalseMismatchCount, 0);
  t.diagnostic(`${payloads.length} payloads completed with zero legacy-result differences`);
});

test('a checkpoint followed by an aligned plain delta reconstructs the aggregate', () => {
  const merged = mergeDeltaPayloads(
    { aggregate: 'abc', content: 'abc' },
    { content: 'd', aggregateLength: 4 }
  );

  assert.equal(merged.aggregate, 'abcd');
  assert.equal(merged.aggregateLength, 4);
});

test('a checkpoint followed by a misaligned plain delta drops the stale aggregate', () => {
  const merged = mergeDeltaPayloads(
    { aggregate: 'abc', content: 'abc' },
    { content: 'd', aggregateLength: 99 }
  );
  const withoutCheckpoint = mergeDeltaPayloads(
    { content: 'a' },
    { content: 'b', aggregateLength: 2 }
  );

  assert.equal(Object.prototype.hasOwnProperty.call(merged, 'aggregate'), false);
  assert.equal(merged.aggregateLength, 99);
  assert.equal(Object.prototype.hasOwnProperty.call(withoutCheckpoint, 'aggregate'), false);
  assert.equal(withoutCheckpoint.aggregateLength, 2);
});

test('the final consistency guard drops a carried aggregate when incoming has neither pair member', () => {
  const merged = mergeDeltaPayloads(
    { aggregate: 'abc', aggregateLength: 4, content: 'abc' },
    { content: '' }
  );

  assert.equal(Object.prototype.hasOwnProperty.call(merged, 'aggregate'), false);
  assert.equal(merged.aggregateLength, 4);
});

test('three-way coalescing reconstructs the aggregate and keeps concatenated content', () => {
  const checkpoint = { aggregate: 'abc', content: 'abc' };
  const firstPlain = { content: 'd', aggregateLength: 4 };
  const secondPlain = { content: 'e', aggregateLength: 5 };
  const merged = mergeDeltaPayloads(
    mergeDeltaPayloads(checkpoint, firstPlain),
    secondPlain
  );

  assert.equal(merged.aggregate, 'abcde');
  assert.equal(merged.aggregateLength, 5);
  assert.equal(merged.content, 'abcde');
});

test('aggregateLengthOf preserves aggregate-length behavior and validates numeric lengths', () => {
  assert.equal(aggregateLengthOf({ aggregate: 'abcd' }), 4);
  assert.equal(aggregateLengthOf({ aggregate: 'abcd', aggregateLength: 4 }), 4);
  assert.equal(aggregateLengthOf({ aggregate: 'abcd', aggregateLength: -1 }), 4);
  assert.equal(aggregateLengthOf({ aggregateLength: 2.5 }), null);
  assert.equal(aggregateLengthOf({ content: 'abcd' }), null);
});

test('aggregateLength-only regression matches a short aggregate regression', () => {
  const aggregateCursor = createTextCursor();
  const lengthCursor = createTextCursor();
  readDelta(aggregateCursor, { aggregate: 'abcde' }, { basisContent: '' });
  readDelta(lengthCursor, { aggregate: 'abcde' }, { basisContent: '' });
  const aggregateBefore = cursorOffsets(aggregateCursor);
  const lengthBefore = cursorOffsets(lengthCursor);

  const aggregateResult = readDelta(aggregateCursor, { aggregate: 'abc' }, { basisContent: '' });
  const lengthResult = readDelta(lengthCursor, { aggregateLength: 3 }, { basisContent: '' });

  assert.equal(aggregateResult.regressed, true);
  assert.equal(lengthResult.regressed, aggregateResult.regressed);
  assert.deepEqual(cursorOffsets(aggregateCursor), aggregateBefore);
  assert.deepEqual(cursorOffsets(lengthCursor), lengthBefore);
});

test('aggregateLength advances the cursor without an aggregate and a matching checkpoint stays aligned', () => {
  const cursor = createTextCursor();
  readDelta(cursor, { content: 'abc', aggregate: 'abc' }, { basisContent: '' });

  const plainResult = readDelta(
    cursor,
    { content: 'd', aggregateLength: 4 },
    { basisContent: 'abc' }
  );
  assert.deepEqual(cursorOffsets(cursor), {
    aggregateOffset: 4,
    segmentBaseOffset: 0,
    _lastAggregateLength: 4,
  });
  assert.equal(plainResult.pendingContent, 'abcd');
  assert.equal(plainResult.lengthMismatch, false);

  const checkpointResult = readDelta(
    cursor,
    { content: '', aggregate: 'abcd', aggregateLength: 4 },
    { basisContent: '' }
  );
  assert.equal(checkpointResult.regressed, false);
  assert.equal(checkpointResult.lengthMismatch, false);
});

test('lengthMismatch reports disagreement between accumulated text and aggregateLength', () => {
  const cursor = createTextCursor();
  readDelta(cursor, { content: 'abc', aggregate: 'abc' }, { basisContent: '' });

  const result = readDelta(
    cursor,
    { content: 'd', aggregateLength: 5 },
    { basisContent: 'abc' }
  );

  assert.equal(result.pendingContent, 'abcd');
  assert.equal(result.lengthMismatch, true);
});

test('seedContent keeps aggregate slicing and falls back when no checkpoint is present', () => {
  const cursor = {
    aggregateOffset: 8,
    segmentBaseOffset: 3,
    _lastAggregateLength: 8,
  };

  assert.equal(seedContent(cursor, { aggregate: 'abcdefgh' }, 'fallback'), 'defgh');
  assert.equal(seedContent(cursor, { aggregateLength: 8 }, 'fallback'), 'fallback');
});
