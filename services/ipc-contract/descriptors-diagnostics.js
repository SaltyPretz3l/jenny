/**
 * Renderer log forwarding and diagnostics (renderer errors, stream metrics,
 * startup marks, phase percentiles).
 *
 * Composed into JENNY_SHELL_BRIDGE_DESCRIPTORS by services/ipc-contract.js;
 * the key order here is the bridge's key order.
 */

const { invokeMethod, subscribeMethod, sendMethod } = require('./bridge-methods');

module.exports = Object.freeze({
  // Fire-and-forget renderer→main log batches mirrored into shell.log.
  'logs.clientAppend': sendMethod('logs:client-append'),
  'diagnostics.logs.getSnapshot': invokeMethod('diagnostics:logs:snapshot'),
  'diagnostics.logs.onEntry': subscribeMethod('diagnostics:logs:entry'),
  'diagnostics.logs.appendRendererBatch': sendMethod('diagnostics:logs:renderer-batch'),
  'diagnostics.reportRendererError': invokeMethod('diagnostics:renderer-error'),
  // Per-stream renderer render/paint counters merged into the turn diagnostic
  // dump (client_timing) at stream terminal.
  'diagnostics.reportClientStreamMetrics': invokeMethod('diagnostics:client-stream-metrics'),
  'diagnostics.getStartupAuditConfig': invokeMethod('diagnostics:startup-audit-config'),
  'diagnostics.reportStartupMark': invokeMethod('diagnostics:startup-mark'),
  'diagnostics.reportStartupMarksBatch': invokeMethod('diagnostics:startup-marks-batch'),
  'diagnostics.getJennyStatus': invokeMethod('diagnostics:jenny-status'),
  'diagnostics.phasePercentiles.get': invokeMethod('diagnostics:phase-percentiles:get'),
  'diagnostics.phasePercentiles.reset': invokeMethod('diagnostics:phase-percentiles:reset'),
});
