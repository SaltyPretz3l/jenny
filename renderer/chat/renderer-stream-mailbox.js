/* renderer/chat/renderer-stream-mailbox.js -- per-stream serialized delivery with renderer-epoch invalidation (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStreamMailbox = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function normalizeKey(payload) {
    const streamId = String(payload?.streamId || '').trim();
    if (streamId) return `stream:${streamId}`;
    const sessionId = String(payload?.sessionId || '').trim();
    return sessionId ? `session:${sessionId}` : 'renderer:unscoped';
  }

  // Deliberate lower bound for diagnostics, not an exact byte count: bulk text lengths only.
  function estimateQueuedBytes(payload) {
    let bytes = 0;
    if (typeof payload?.content === 'string') bytes += payload.content.length;
    if (typeof payload?.aggregate === 'string') bytes += payload.aggregate.length;
    // Count reasoning text so reasoning-only backlogs cannot hide queue pressure.
    const entriesDelta = Array.isArray(payload?.reasoning?.entriesDelta)
      ? payload.reasoning.entriesDelta : [];
    for (const entry of entriesDelta) {
      if (typeof entry?.text === 'string') bytes += entry.text.length;
      if (typeof entry?.append === 'string') bytes += entry.append.length;
    }
    if (typeof payload?.reasoning?.delta === 'string') bytes += payload.reasoning.delta.length;
    return bytes;
  }

  function createStreamMailbox() {
    const tailsByKey = new Map();
    const statsByKey = new Map();
    let rendererEpoch = 1;
    let epochController = new AbortController();
    let disposed = false;

    function reportMailboxStats(streamId, sessionId, stats) {
      if (!streamId) return;
      try {
        const streamClientMetrics = (typeof globalThis !== 'undefined'
          && globalThis.rendererStreamClientMetricsModule
          && typeof globalThis.rendererStreamClientMetricsModule.getShared === 'function')
          ? globalThis.rendererStreamClientMetricsModule.getShared()
          : null;
        streamClientMetrics?.noteMailbox?.(streamId, sessionId, {
          peakDepth: stats.peakDepth,
          peakQueuedBytes: stats.peakQueuedBytes,
          dropped: stats.dropped,
        });
      } catch (_error) {
        // Diagnostics are best-effort; never break stream delivery.
      }
    }

    function isEpochCurrent(epoch, signal) {
      return !disposed
        && rendererEpoch === epoch
        && signal === epochController.signal
        && signal.aborted !== true;
    }

    function beginEpoch() {
      epochController.abort('renderer_epoch_replaced');
      rendererEpoch += 1;
      epochController = new AbortController();
      statsByKey.clear();
      tailsByKey.clear();
      return rendererEpoch;
    }

    function enqueue(payload, task) {
      if (disposed) {
        return Promise.resolve({ dropped: true, reason: 'disposed' });
      }
      if (typeof task !== 'function') {
        return Promise.reject(new TypeError('stream mailbox task must be a function'));
      }
      const key = normalizeKey(payload);
      const streamId = String(payload?.streamId || '').trim();
      const sessionId = String(payload?.sessionId || '').trim();
      const epoch = rendererEpoch;
      const signal = epochController.signal;
      const queuedBytes = estimateQueuedBytes(payload);
      let stats = statsByKey.get(key);
      const isNewKey = !stats;
      if (!stats) {
        stats = {
          depth: 0,
          peakDepth: 0,
          queuedBytes: 0,
          peakQueuedBytes: 0,
          dropped: 0,
        };
      }
      stats.depth += 1;
      stats.peakDepth = Math.max(stats.peakDepth, stats.depth);
      stats.queuedBytes += queuedBytes;
      stats.peakQueuedBytes = Math.max(stats.peakQueuedBytes, stats.queuedBytes);
      const previous = tailsByKey.get(key) || Promise.resolve();
      const run = previous.catch(() => undefined).then(async () => {
        stats.depth = Math.max(stats.depth - 1, 0);
        stats.queuedBytes = Math.max(stats.queuedBytes - queuedBytes, 0);
        if (!isEpochCurrent(epoch, signal)) {
          stats.dropped += 1;
          reportMailboxStats(streamId, sessionId, stats);
          return { dropped: true, reason: signal.aborted ? 'aborted' : 'stale_epoch' };
        }
        const guard = Object.freeze({
          isCurrent: () => isEpochCurrent(epoch, signal),
          mutate(mutation) {
            if (!isEpochCurrent(epoch, signal) || typeof mutation !== 'function') return false;
            mutation();
            return true;
          },
        });
        return task({ rendererEpoch: epoch, signal, guard });
      });
      const tail = run.finally(() => {
        if (tailsByKey.get(key) === tail) {
          statsByKey.delete(key);
          tailsByKey.delete(key);
        }
      });
      tailsByKey.set(key, tail);
      if (isNewKey) statsByKey.set(key, stats);
      reportMailboxStats(streamId, sessionId, stats);
      return tail;
    }

    function dispose() {
      if (disposed) return false;
      disposed = true;
      epochController.abort('renderer_disposed');
      rendererEpoch += 1;
      statsByKey.clear();
      tailsByKey.clear();
      return true;
    }

    function getMailboxStats(payloadOrKey) {
      const key = typeof payloadOrKey === 'string' ? payloadOrKey : normalizeKey(payloadOrKey);
      const stats = statsByKey.get(key);
      return stats ? {
        depth: stats.depth,
        peakDepth: stats.peakDepth,
        queuedBytes: stats.queuedBytes,
        peakQueuedBytes: stats.peakQueuedBytes,
        dropped: stats.dropped,
      } : {
        depth: 0,
        peakDepth: 0,
        queuedBytes: 0,
        peakQueuedBytes: 0,
        dropped: 0,
      };
    }

    return {
      beginEpoch,
      enqueue,
      dispose,
      getRendererEpoch: () => rendererEpoch,
      getMailboxStats,
    };
  }

  return { createStreamMailbox };
});
