(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-turn-normalization-utils'));
    return;
  }
  root.rendererTurnRowProjectorUtils = factory(root.rendererTurnNormalizationUtils || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (turnNormalizationUtils) {
  'use strict';

  const {
    clonePlainObject,
    cloneSortKey,
    normalizeGeneratedArtifact,
    normalizeId,
    normalizeToolLifecycleStatus,
    pushDistinct,
    sortKeyCompare,
  } = turnNormalizationUtils;

  function traceEventCompare(left, right) {
    const leftSeq = Number(left && left.event_seq);
    const rightSeq = Number(right && right.event_seq);
    const hasLeftSeq = Number.isInteger(leftSeq) && leftSeq >= 0;
    const hasRightSeq = Number.isInteger(rightSeq) && rightSeq >= 0;
    if (hasLeftSeq && hasRightSeq && leftSeq !== rightSeq) {
      return leftSeq - rightSeq;
    }
    return sortKeyCompare(left && left.sort_key, right && right.sort_key);
  }

  // Where a row is painted: the turn's own position (sort_key, the order of
  // turn.events and of the terminal fold) first, the recorded sequence after.
  // A notice recorded ahead of the message it belongs to stays at that message.
  function projectionEventCompare(left, right) {
    const leftKey = left && left.sort_key;
    const rightKey = right && right.sort_key;
    if (Array.isArray(leftKey) && leftKey.length && Array.isArray(rightKey) && rightKey.length) {
      const delta = sortKeyCompare(leftKey, rightKey);
      if (delta !== 0) return delta;
    }
    return traceEventCompare(left, right);
  }

  return Object.freeze({
    normalizeId,
    cloneSortKey,
    traceEventCompare,
    projectionEventCompare,
    pushDistinct,
    normalizeGeneratedArtifact,
    normalizeToolLifecycleStatus,
    clonePlainObject,
  });
});
