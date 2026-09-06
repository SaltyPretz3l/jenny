(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererMemoryActionsV2Utils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function normalizeEditingMemoryId(memoryId) {
    const resolvedMemoryId = Number(memoryId);
    return Number.isInteger(resolvedMemoryId) && resolvedMemoryId > 0 ? resolvedMemoryId : null;
  }

  function resolvePendingFocusTarget(options, buildPendingMemoryKey) {
    const pendingTarget = options?.pendingTarget || null;
    const sessionId = String(pendingTarget?.sessionId || '').trim();
    const fingerprint = String(pendingTarget?.fingerprint || pendingTarget?.contentFingerprint || '').trim();
    const pendingKey = typeof buildPendingMemoryKey === 'function'
      ? buildPendingMemoryKey(sessionId, fingerprint)
      : '';
    return pendingKey ? { key: pendingKey, target: { sessionId, fingerprint } } : { key: '', target: null };
  }

  return {
    normalizeEditingMemoryId,
    resolvePendingFocusTarget,
  };
});
