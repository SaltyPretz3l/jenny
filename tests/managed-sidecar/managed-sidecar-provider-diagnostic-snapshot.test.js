const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startManagedSidecarChatStream } = require('../../services/backend/managed-sidecar-chat');
const {
  buildManagedChatRequest,
  createManagedChatServiceStub,
  waitForDiagnosticDump,
} = require('../helpers/managed-sidecar-chat-lifecycle-helpers');

for (const outcome of ['completed', 'failed', 'diagnostic_fetch_failed']) {
  test(`managed ${outcome} turn fetches one provider snapshot for phases and its disk dump`, async (t) => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-provider-snapshot-'));
    t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
    const service = createManagedChatServiceStub();
    service.options = { userDataPath };
    const phases = [];
    service.phasePercentilesAggregator = { record: (name, duration) => phases.push([name, duration]) };
    const providerDiagnostics = {
      provider_call_count: 1,
      provider_call_outcome: outcome === 'failed' ? 'failed' : 'completed',
      time_to_provider_request_start_ms: 12,
      time_to_first_chunk_ms: 34,
      time_to_first_visible_token_ms: 56,
    };
    const requests = [];
    let releaseSnapshot;
    const snapshotReady = new Promise((resolve) => { releaseSnapshot = resolve; });
    t.after(releaseSnapshot);
    service.sidecarClient = {
      async harnessTurnDiagnostic(params) {
        requests.push(params);
        if (outcome === 'failed') await snapshotReady;
        if (outcome === 'diagnostic_fetch_failed') throw new Error('diagnostic RPC unavailable');
        return { provider_diagnostics: { ...providerDiagnostics, provider_call_count: requests.length } };
      },
      async chatSend(_params, options) {
        if (outcome === 'failed') throw new Error('provider generation failed');
        options.onNotification({ method: 'chat.token', params: { delta: 'Done.' } });
        options.onNotification({ method: 'chat.done', params: {} });
        return { status: 'completed' };
      },
    };

    const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest());
    const controller = service.activeStreams.get(stream.streamId);
    // A failed turn must settle while its diagnostic RPC is still pending.
    await controller._pendingPromise;
    if (outcome === 'failed') {
      assert.ok(service.emittedEvents.some(({ payload }) => payload.type === 'error'));
      assert.equal(service.activeStreams.has(stream.streamId), false);
      releaseSnapshot();
    }
    const diagnosticPath = await waitForDiagnosticDump(service, stream.streamId);
    const payload = JSON.parse(fs.readFileSync(diagnosticPath, 'utf8'));
    assert.equal(payload.terminal_status, outcome === 'failed' ? 'runtime_error' : 'completed');
    assert.deepEqual(requests, [{ request_id: stream.streamId }]);
    assert.deepEqual(payload.provider_diagnostics,
      outcome === 'diagnostic_fetch_failed' ? null : providerDiagnostics);
    const providerPhases = phases.filter(([name]) => [
      'sidecar_request_sent_to_provider_request_start',
      'provider_request_start_to_first_chunk',
      'first_chunk_to_first_visible_token',
    ].includes(name));
    assert.deepEqual(providerPhases, outcome === 'diagnostic_fetch_failed' ? [] : [
      ['sidecar_request_sent_to_provider_request_start', 12],
      ['provider_request_start_to_first_chunk', 34],
      ['first_chunk_to_first_visible_token', 22],
    ]);
    if (outcome === 'diagnostic_fetch_failed') {
      const warnings = service.serviceLogs.filter(({ event }) => event === 'chat.turn_diagnostic_sidecar_fetch_failed');
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0].level, 'WARN');
    }
  });
}

test('a failed turn still dumps when recording provider phases throws', async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-provider-snapshot-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const service = createManagedChatServiceStub();
  service.options = { userDataPath };
  service.phasePercentilesAggregator = { record(name) {
    if (name === 'provider_request_start_to_first_chunk') throw new Error('aggregator broken');
  } };
  service.sidecarClient = {
    async harnessTurnDiagnostic() { return { provider_diagnostics: { time_to_first_chunk_ms: 5 } }; },
    async chatSend() { throw new Error('provider generation failed'); },
  };
  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest());
  await service.activeStreams.get(stream.streamId)._pendingPromise;
  const payload = JSON.parse(fs.readFileSync(await waitForDiagnosticDump(service, stream.streamId), 'utf8'));
  assert.equal(payload.terminal_status, 'runtime_error');
  const warnings = service.serviceLogs.filter(({ event }) => event === 'chat.provider_phase_percentiles_failed');
  assert.equal(warnings.length, 1);
});
