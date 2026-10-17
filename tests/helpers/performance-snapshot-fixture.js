'use strict';

/* Row 59 checkpoint 6 renderer fixtures: the frozen window.jennyShell.performance bridge (W4) as a fake,
   plus builders for the snapshot shapes it returns ({ok, settings, inference, gpu}). */

const GiB = 1024 ** 3;
const UUID_A = '11111111-2222-4333-8444-555555555555';
const UUID_B = '66666666-7777-4888-8999-aaaaaaaaaaaa';

const metric = (value, state = 'available', sampledAt = 1000) => ({ value, state, sampled_at: sampledAt });

function observation(overrides = {}) {
  return {
    attempt_id: 'abcdef0123456789', sequence: 3, sampled_at: 1000, phase: 'decode', source: 'provider', provider_kind: 'ninfer',
    turn_id: 'turn_1', provider_call_id: null, generated_tokens: 40, decode_interval_tokens: 39, prompt_tokens: 100,
    cached_prompt_tokens: 60, processed_prompt_tokens: 100, decode_elapsed_ms: 220, prefill_elapsed_ms: 400,
    time_to_first_generated_token_ms: 640, terminal_decode_tps: null, terminal_prefill_tps: null,
    ...overrides,
  };
}

function inference(overrides = {}) {
  return {
    observation: observation(),
    live_decode: metric(182.4),
    live_prefill: metric(8800),
    cache_fraction: metric(0.6),
    ...overrides,
  };
}

function settings(overrides = {}) {
  return { schema_version: 1, show_counter: true, gpu_warnings_enabled: true, ...overrides };
}

function warning(overrides = {}) {
  return {
    warning_id: null, state: 'clear', since: null, evidence_codes: [], dismissed_until: null, last_confirmed_state: null,
    ...overrides,
  };
}

function gpu(overrides = {}) {
  return {
    schema_version: 1, sequence: 4, sampled_at: 1000, cadence_ms: 2000, state: 'fresh', reason: null,
    adapter: { gpu_uuid: 'GPU-aaaa', pci_bus_id: '00000000:01:00.0', luid: 'luid_1', physical_index: 0,
      dedicated_total_bytes: 32 * GiB, dedicated_used_bytes: 24.8 * GiB, dedicated_free_bytes: 7.2 * GiB, shared_used_bytes: 0.4 * GiB },
    managed_process: { pid: 4242, created_at: '1', basename: 'ninfer.exe', dedicated_bytes: 24.1 * GiB, shared_bytes: 0.2 * GiB },
    external_processes: [], other_process_count: 0, truncated: false,
    warning: warning(),
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return { ok: true, settings: settings(), inference: inference(), gpu: gpu(), ...overrides };
}

/* A fake bridge. `respond` may be replaced per test; every call is recorded. */
function createPerformanceBridge(initial = {}) {
  const listeners = new Set();
  const bridge = {
    snapshotCalls: [], updateCalls: [], dismissCalls: [],
    current: snapshot(initial),
    getSnapshot: async (request) => { bridge.snapshotCalls.push(request); return bridge.respondSnapshot(request); },
    respondSnapshot: () => bridge.current,
    updateSettings: async (request) => { bridge.updateCalls.push(request); return bridge.respondUpdate(request); },
    respondUpdate: (request) => ({ ok: true, settings: settings({ ...bridge.current.settings, ...request, schema_version: 1 }) }),
    dismissWarning: async (request) => { bridge.dismissCalls.push(request); return bridge.respondDismiss(request); },
    respondDismiss: () => ({ ok: true, gpu: bridge.current.gpu }),
    onChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    emit: (event) => listeners.forEach((listener) => listener(event)),
    listenerCount: () => listeners.size,
  };
  return bridge;
}

module.exports = {
  GiB, UUID_A, UUID_B, metric, observation, inference, settings, warning, gpu, snapshot, createPerformanceBridge,
};
