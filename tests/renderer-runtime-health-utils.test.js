const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveRuntimeHealthState,
} = require('../renderer/shell/renderer-runtime-health-utils.js');

function snapshotWithProfiles(profiles, observations) {
  return {
    runtime: {
      provider_capability_profiles: profiles,
      recent_tool_observations: observations || [],
    },
  };
}

function readyProfile(overrides) {
  return Object.assign(
    {
      profile_id: 'ollama:qwen3.6',
      endpoint_id: 'ollama',
      model_id: 'qwen3.6:latest',
      probe_status: 'ready',
      selected_route: 'native_tools',
      reliability_counters: {
        tool_call_parse_success_count: 0,
        tool_call_parse_failure_count: 0,
      },
    },
    overrides || {},
  );
}

test('returns pending when snapshot is null', () => {
  const result = deriveRuntimeHealthState(null);
  assert.equal(result.tone, 'pending');
  assert.equal(result.label, 'Pending');
  assert.match(result.summary, /waiting for first turn/i);
});

test('returns pending when snapshot has no runtime section', () => {
  const result = deriveRuntimeHealthState({});
  assert.equal(result.tone, 'pending');
});

test('returns pending when runtime has no profiles and no observations', () => {
  const result = deriveRuntimeHealthState({ runtime: {} });
  assert.equal(result.tone, 'pending');
});

test('returns pending when profile is present but probe is still pending', () => {
  const result = deriveRuntimeHealthState(
    snapshotWithProfiles([readyProfile({ probe_status: 'pending' })]),
  );
  assert.equal(result.tone, 'pending');
});

test('returns success when at least one profile is ready and nothing else fires', () => {
  const result = deriveRuntimeHealthState(snapshotWithProfiles([readyProfile()]));
  assert.equal(result.tone, 'success');
  assert.equal(result.label, 'Healthy');
  assert.equal(result.summary, 'Healthy');
});

test('returns danger when any profile is fail-closed (highest precedence)', () => {
  const result = deriveRuntimeHealthState(snapshotWithProfiles([
    readyProfile(),
    readyProfile({ model_id: 'broken-model', selected_route: 'fail_closed' }),
  ]));
  assert.equal(result.tone, 'danger');
  assert.equal(result.label, 'Blocked');
  assert.match(result.summary, /fail-closed for broken-model/);
});

test('returns danger when any profile probe failed', () => {
  const result = deriveRuntimeHealthState(snapshotWithProfiles([
    readyProfile({ model_id: 'broken-model', probe_status: 'failed' }),
  ]));
  assert.equal(result.tone, 'danger');
  assert.match(result.summary, /probe failed for broken-model/);
});

test('returns danger when the managed llama-server failed to start, but not for a clean stop', () => {
  const snapshot = snapshotWithProfiles([readyProfile()]);
  snapshot.runtime.llama_server = { state: 'stopped', alias: 'local-coder', last_error: 'llama_server_binary_not_found' };
  assert.deepEqual(deriveRuntimeHealthState(snapshot), {
    tone: 'danger',
    label: 'Blocked',
    summary: 'Blocked: local llama-server failed to start (local-coder): llama_server_binary_not_found',
  });
  const clean = snapshotWithProfiles([readyProfile()]);
  clean.runtime.llama_server = { state: 'stopped', alias: 'local-coder', last_error: '' };
  assert.deepEqual(deriveRuntimeHealthState(clean), deriveRuntimeHealthState(snapshotWithProfiles([readyProfile()])));
});

test('returns danger when the managed llama-server crashed without an alias', () => {
  const snapshot = snapshotWithProfiles([readyProfile()]);
  snapshot.runtime.llama_server = { state: 'crashed' };
  assert.deepEqual(deriveRuntimeHealthState(snapshot), {
    tone: 'danger',
    label: 'Blocked',
    summary: 'Blocked: local llama-server stopped unexpectedly; it restarts on your next message',
  });
});

test('returns danger when the managed llama-server crashed with an alias', () => {
  const snapshot = snapshotWithProfiles([readyProfile()]);
  snapshot.runtime.llama_server = { state: 'crashed', alias: 'local-coder' };
  assert.deepEqual(deriveRuntimeHealthState(snapshot), {
    tone: 'danger',
    label: 'Blocked',
    summary: 'Blocked: local llama-server stopped unexpectedly; it restarts on your next message (local-coder)',
  });
});

for (const state of ['ready', 'starting']) {
  test(`managed llama-server ${state} leaves the health result unchanged`, () => {
    assert.equal(deriveRuntimeHealthState({ runtime: { llama_server: { state: 'crashed' } } }).tone, 'danger');
    const baseline = snapshotWithProfiles([readyProfile()]);
    const withLlamaServer = snapshotWithProfiles([readyProfile()]);
    withLlamaServer.runtime.llama_server = { state };
    assert.deepEqual(deriveRuntimeHealthState(withLlamaServer), deriveRuntimeHealthState(baseline));
  });
}

test('fail-closed profile takes precedence over a crashed managed llama-server', () => {
  assert.equal(deriveRuntimeHealthState({ runtime: { llama_server: { state: 'crashed' } } }).tone, 'danger');
  const snapshot = snapshotWithProfiles([
    readyProfile({ model_id: 'closed', selected_route: 'fail_closed' }),
  ]);
  snapshot.runtime.llama_server = { state: 'crashed', alias: 'local-coder' };
  assert.deepEqual(deriveRuntimeHealthState(snapshot), {
    tone: 'danger',
    label: 'Blocked',
    summary: 'Blocked: route is fail-closed for closed',
  });
});

test('returns warning when any profile roundtrip did not pass', () => {
  const result = deriveRuntimeHealthState(snapshotWithProfiles([
    readyProfile({ model_id: 'shaky-model', roundtrip: { passed: false } }),
  ]));
  assert.equal(result.tone, 'warning');
  assert.equal(result.label, 'Degraded');
  assert.match(result.summary, /schema roundtrip failed for shaky-model/);
});

test('returns warning when any profile probe is expired', () => {
  const result = deriveRuntimeHealthState(snapshotWithProfiles([
    readyProfile({ model_id: 'stale-model', probe_status: 'expired' }),
  ]));
  assert.equal(result.tone, 'warning');
  assert.match(result.summary, /profile expired for stale-model/);
});

test('returns warning when any profile route is tool_disabled', () => {
  const result = deriveRuntimeHealthState(snapshotWithProfiles([
    readyProfile({ model_id: 'no-tools', selected_route: 'tool_disabled' }),
  ]));
  assert.equal(result.tone, 'warning');
  assert.match(result.summary, /tools disabled for no-tools/);
});

test('returns warning when parse failures exceed successes with at least 5 samples', () => {
  const result = deriveRuntimeHealthState(snapshotWithProfiles([
    readyProfile({
      reliability_counters: {
        tool_call_parse_success_count: 1,
        tool_call_parse_failure_count: 4,
      },
    }),
  ]));
  assert.equal(result.tone, 'warning');
  assert.match(result.summary, /tool-call parse failure rate is high/);
});

test('does not fire parse-failure warning below the 5-sample minimum', () => {
  const result = deriveRuntimeHealthState(snapshotWithProfiles([
    readyProfile({
      reliability_counters: {
        tool_call_parse_success_count: 0,
        tool_call_parse_failure_count: 4,
      },
    }),
  ]));
  assert.equal(result.tone, 'success');
});

test('returns warning when most recent observations include a turn_failed', () => {
  const result = deriveRuntimeHealthState(snapshotWithProfiles(
    [readyProfile()],
    [
      { kind: 'tool_execution_observed', tool_name: 'open_file' },
      { kind: 'turn_failed', error_code: 'CMP-LOOP-0017' },
    ],
  ));
  assert.equal(result.tone, 'warning');
  assert.match(result.summary, /recent turn failed \(CMP-LOOP-0017\)/);
});

test('renders no error code as no error code when missing', () => {
  const result = deriveRuntimeHealthState(snapshotWithProfiles(
    [readyProfile()],
    [{ kind: 'turn_failed' }],
  ));
  assert.equal(result.tone, 'warning');
  assert.match(result.summary, /\(no error code\)/);
});

test('only inspects the trailing 10 observations for turn_failed', () => {
  const observations = [];
  observations.push({ kind: 'turn_failed', error_code: 'CMP-OLD' });
  for (let index = 0; index < 10; index += 1) {
    observations.push({ kind: 'tool_execution_observed', tool_name: 'noop' });
  }
  const result = deriveRuntimeHealthState(snapshotWithProfiles([readyProfile()], observations));
  assert.equal(result.tone, 'success');
});

test('precedence: fail_closed beats roundtrip-failed and tool_disabled', () => {
  const result = deriveRuntimeHealthState(snapshotWithProfiles([
    readyProfile({ model_id: 'roundtrip-bad', roundtrip: { passed: false } }),
    readyProfile({ model_id: 'no-tools', selected_route: 'tool_disabled' }),
    readyProfile({ model_id: 'closed', selected_route: 'fail_closed' }),
  ]));
  assert.equal(result.tone, 'danger');
  assert.match(result.summary, /fail-closed for closed/);
});

test('handles malformed profile entries without throwing', () => {
  const snapshot = {
    runtime: {
      provider_capability_profiles: [null, 'oops', 42, readyProfile()],
      recent_tool_observations: [null, 'oops', { kind: null }],
    },
  };
  const result = deriveRuntimeHealthState(snapshot);
  assert.equal(result.tone, 'success');
});

test('falls back to unknown model when model_id is missing', () => {
  const result = deriveRuntimeHealthState(snapshotWithProfiles([
    readyProfile({ model_id: '', selected_route: 'fail_closed' }),
  ]));
  assert.match(result.summary, /fail-closed for unknown model/);
});

test('does not throw when runtime is an array (defensive)', () => {
  const result = deriveRuntimeHealthState({ runtime: [] });
  assert.equal(result.tone, 'pending');
});
