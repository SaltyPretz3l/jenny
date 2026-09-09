'use strict';

function createChatStartCancellation({ onCancelStream } = {}) {
  const controller = new AbortController();
  let boundStreamId = '';
  let cancelled = false;
  let streamCancellationIssued = false;

  function cancelBoundStream(reason) {
    if (streamCancellationIssued || !boundStreamId || typeof onCancelStream !== 'function') return;
    streamCancellationIssued = true;
    onCancelStream(boundStreamId, reason);
  }

  const cancellation = {
    signal: controller.signal,
    cancel(reason = 'remote_cancelled') {
      if (cancelled) return false;
      cancelled = true;
      controller.abort(reason);
      cancelBoundStream(reason);
      return true;
    },
    bindStream(streamId) {
      const normalized = String(streamId || '').trim();
      if (!normalized) throw new TypeError('A chat-start cancellation requires a stream id.');
      if (boundStreamId && boundStreamId !== normalized) {
        throw new Error('A chat-start cancellation is already bound to another stream.');
      }
      boundStreamId = normalized;
      if (cancelled) cancelBoundStream(controller.signal.reason || 'remote_cancelled');
      return boundStreamId;
    },
    get boundStreamId() {
      return boundStreamId || null;
    },
  };
  return Object.freeze(cancellation);
}

module.exports = { createChatStartCancellation };
