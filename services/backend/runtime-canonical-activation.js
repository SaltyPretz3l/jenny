'use strict';

// One pre-dispatch transition for the collector and its notification consumer.
// The caller must first verify this process's continuation acknowledgement.
function activateRuntimeCanonicalStream(ctx) {
  const collector = ctx.turnEventCollector;
  if (!collector || ctx.streamSawText || ctx.streamSawBatch || ctx.streamSawDone
    || ctx.latestToolContext || collector.capturedEvents.length) {
    throw new Error('runtime_continuation_activation_too_late');
  }
  collector.canonicalPrimary = true;
  ctx.canonicalBridgeEnabled = true;
}

module.exports = { activateRuntimeCanonicalStream };
