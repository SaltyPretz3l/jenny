/* renderer/chat/renderer-stream-text-cursor.js -- live-stream aggregate text cursor (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStreamTextCursor = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // The single definition of "this payload carries an authoritative aggregate".
  // The caller needs it to decide whether to build a delta-concat basis, and
  // readDelta needs it to decide how to derive pendingContent -- if those two
  // ever disagree, the basis goes uncomputed and the pending row silently loses
  // its prior text. One predicate, used by both.
  function usesAggregate(payload) {
    return Object.prototype.hasOwnProperty.call(payload || {}, 'aggregate');
  }

  function aggregateLengthOf(payload) {
    if (Number.isInteger(payload?.aggregateLength) && payload.aggregateLength >= 0) {
      return payload.aggregateLength;
    }
    return usesAggregate(payload) ? String(payload.aggregate || '').length : null;
  }

  function createTextCursor() {
    return {
      aggregateOffset: 0,
      segmentBaseOffset: 0,
    };
  }

  function resetCursor(cursor) {
    cursor.aggregateOffset = 0;
    cursor._lastAggregateLength = 0;
    cursor.segmentBaseOffset = 0;
  }

  function beginSegment(cursor) {
    const segmentOffset = cursor._lastAggregateLength || 0;
    cursor.aggregateOffset = segmentOffset;
    cursor.segmentBaseOffset = segmentOffset;
  }

  function readDelta(cursor, payload, options = {}) {
    const hasAggregate = usesAggregate(payload);
    const aggregateLength = aggregateLengthOf(payload);
    const fullAggregate = hasAggregate ? String(payload.aggregate || '') : '';
    const payloadContent = String(payload.content || '');
    const aggregateCursor = Number(cursor.aggregateOffset) || 0;
    const aggregateDelta = hasAggregate && fullAggregate.length > aggregateCursor
      ? fullAggregate.substring(aggregateCursor)
      : '';
    const segmentContent = payloadContent || aggregateDelta;

    if (
      typeof aggregateLength === 'number'
      && cursor._lastAggregateLength > 0
      && aggregateLength < cursor._lastAggregateLength
    ) {
      return deltaResult(true, segmentContent, '', false);
    }

    if (typeof aggregateLength === 'number') {
      cursor._lastAggregateLength = aggregateLength;
      cursor.aggregateOffset = hasAggregate
        ? aggregateLength
        : aggregateCursor + segmentContent.length;
    }
    const pendingContent = hasAggregate
      ? seedContent(cursor, payload, '')
      : `${String(options.basisContent || '')}${segmentContent}`;
    const lengthMismatch = !hasAggregate
      && typeof aggregateLength === 'number'
      && aggregateLength !== cursor.aggregateOffset;
    return deltaResult(false, segmentContent, pendingContent, lengthMismatch);
  }

  // lengthMismatch says the producer's authoritative length disagrees with what
  // this cursor accumulated locally -- the signal a later recovery slice acts on.
  // It is a plain enumerable field: hiding it from Object.keys/deepEqual would
  // only serve to keep an existing test from noticing the shape changed.
  function deltaResult(regressed, segmentContent, pendingContent, lengthMismatch) {
    return { regressed, segmentContent, pendingContent, lengthMismatch };
  }

  function seedContent(cursor, payload, fallbackContent) {
    if (usesAggregate(payload)) {
      return String(payload.aggregate || '').substring(Number(cursor?.segmentBaseOffset) || 0);
    }
    return String(fallbackContent || '');
  }

  return {
    usesAggregate,
    aggregateLengthOf,
    createTextCursor,
    resetCursor,
    beginSegment,
    readDelta,
    seedContent,
  };
});
