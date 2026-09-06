'use strict';

function settlementPromise(controller) {
  const candidate = controller?._pendingPromise
    || controller?.settledPromise
    || controller?.lease?.settledPromise;
  return candidate && typeof candidate.then === 'function' ? Promise.resolve(candidate) : null;
}

function isolateActiveStreamAbort(service, streamId, cancelReason, abort) {
  try {
    abort();
  } catch (error) {
    service._emitServiceLog?.('WARN', 'chat.stream_abort_failed', {
      streamId,
      cancelReason,
      message: String(error?.message || error).slice(0, 240),
    });
  }
}

async function abortAndDrainActiveStreams(service, {
  reason = 'service_stop',
  timeoutMs = 1500,
} = {}) {
  const snapshot = [...(service.activeStreams || new Map()).entries()];
  service._abortActiveStreams(reason);
  const waiting = [];
  for (const [streamId, controller] of snapshot) {
    const pending = settlementPromise(controller);
    if (!pending) {
      if (service.activeStreams.get(streamId) === controller) {
        service.activeStreams.delete(streamId);
      }
      continue;
    }
    waiting.push(
      pending.finally(() => {
        if (service.activeStreams.get(streamId) === controller) {
          service.activeStreams.delete(streamId);
        }
      })
    );
  }
  if (!waiting.length) {
    return { drained: true, streamCount: snapshot.length, timedOut: false };
  }

  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), Math.max(Number(timeoutMs) || 1, 1));
  });
  const settled = Promise.allSettled(waiting).then(() => ({ timedOut: false }));
  const result = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);
  const timedOut = result.timedOut === true;
  service._emitServiceLog?.(timedOut ? 'WARN' : 'INFO', 'chat.active_stream_shutdown_drain', {
    streamCount: snapshot.length,
    remainingStreamCount: service.activeStreams.size,
    timedOut,
    timeoutMs: Math.max(Number(timeoutMs) || 1, 1),
  });
  return { drained: !timedOut, streamCount: snapshot.length, timedOut };
}

module.exports = {
  abortAndDrainActiveStreams,
  isolateActiveStreamAbort,
  settlementPromise,
};
