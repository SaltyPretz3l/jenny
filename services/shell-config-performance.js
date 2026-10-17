'use strict';

/* services/shell-config-performance.js - the `performanceTelemetry` shell-config
 * block (row 59 checkpoint 6): `{schemaVersion:1, showCounter:false,
 * gpuWarningsEnabled:true}`. Strict booleans: anything else falls back to the
 * default. A block written by a NEWER build (schemaVersion > 1) is preserved
 * verbatim and treated read-only here, so an older build never rewrites it.
 * Additive: no CONFIG_VERSION bump. Not portable across machines.
 */

const SCHEMA_VERSION = 1;
const DEFAULT_PERFORMANCE_TELEMETRY = Object.freeze({
  schemaVersion: SCHEMA_VERSION, showCounter: false, gpuWarningsEnabled: true,
});

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// True when the stored block belongs to a newer schema than this build understands.
function isReadOnlyPerformanceTelemetry(value) {
  return isRecord(value) && Number.isSafeInteger(value.schemaVersion) && value.schemaVersion > SCHEMA_VERSION;
}

function normalizePerformanceTelemetry(value) {
  if (isReadOnlyPerformanceTelemetry(value)) return JSON.parse(JSON.stringify(value));
  const source = isRecord(value) ? value : {};
  return {
    schemaVersion: SCHEMA_VERSION,
    showCounter: typeof source.showCounter === 'boolean' ? source.showCounter : DEFAULT_PERFORMANCE_TELEMETRY.showCounter,
    gpuWarningsEnabled: typeof source.gpuWarningsEnabled === 'boolean'
      ? source.gpuWarningsEnabled : DEFAULT_PERFORMANCE_TELEMETRY.gpuWarningsEnabled,
  };
}

// Merge a validated `{showCounter?, gpuWarningsEnabled?}` patch. A read-only
// (future-version) block is returned untouched, so the write becomes a no-op.
function applyPerformanceTelemetryPatch(current, patch) {
  if (isReadOnlyPerformanceTelemetry(current)) return current;
  return normalizePerformanceTelemetry({ ...normalizePerformanceTelemetry(current), ...(isRecord(patch) ? patch : {}) });
}

module.exports = {
  DEFAULT_PERFORMANCE_TELEMETRY,
  applyPerformanceTelemetryPatch,
  isReadOnlyPerformanceTelemetry,
  normalizePerformanceTelemetry,
};
