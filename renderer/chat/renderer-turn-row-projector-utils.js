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

  return Object.freeze({
    normalizeId,
    cloneSortKey,
    traceEventCompare,
    pushDistinct,
    normalizeGeneratedArtifact,
    normalizeToolLifecycleStatus,
    clonePlainObject,
  });
});
