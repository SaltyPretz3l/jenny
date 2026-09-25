'use strict';

const DEFAULT_SESSION_RUNTIME = Object.freeze({
  local: Object.freeze({ runnable_turns: 1, inference_requests: 1, descendants: 8, descendant_depth: 2 }),
  cloud: Object.freeze({ runnable_turns: 2, inference_requests: 4, descendants: 16, descendant_depth: 3 }),
  resources: Object.freeze({ tool_operations: 2, native_processes: 2, tests: 1 }),
});
const LIMIT_RANGES = Object.freeze({
  runnable_turns: [1, 16], inference_requests: [1, 64], descendants: [0, 512],
  descendant_depth: [0, 8], tool_operations: [1, 64], native_processes: [1, 64], tests: [1, 16],
});

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function validLimit(key, value) {
  const [min, max] = LIMIT_RANGES[key];
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function normalizeSessionRuntime(value) {
  const source = record(value) ? value : {};
  return Object.fromEntries(Object.entries(DEFAULT_SESSION_RUNTIME).map(([group, defaults]) => [
    group, Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [
      key, validLimit(key, source[group]?.[key]) ? source[group][key] : fallback,
    ])),
  ]));
}

function applySessionRuntimePatch(current, patch) {
  const next = normalizeSessionRuntime(current);
  if (!record(patch) || !Object.keys(patch).length) throw new TypeError('session_runtime_settings_invalid');
  for (const [group, changes] of Object.entries(patch)) {
    if (!Object.hasOwn(DEFAULT_SESSION_RUNTIME, group) || !record(changes) || !Object.keys(changes).length) {
      throw new TypeError('session_runtime_settings_invalid');
    }
    for (const [key, value] of Object.entries(changes)) {
      if (!Object.hasOwn(DEFAULT_SESSION_RUNTIME[group], key) || !validLimit(key, value)) {
        throw new TypeError('session_runtime_settings_invalid');
      }
      next[group][key] = value;
    }
  }
  return next;
}

// Downstream sandbox capacity is deliberately not a configurable limit here.
module.exports = { DEFAULT_SESSION_RUNTIME, normalizeSessionRuntime, applySessionRuntimePatch };
