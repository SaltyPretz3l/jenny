'use strict';

// P3-PERF-A baseline (2026-09-25): an unmeasured renderer marker must stay
// absent/null end to end. Number(null) === 0 once turned it into a 0 ms phase
// sample, a 0 in every turn-diagnostic JSON, and an epoch-sized ipc_latency_ms.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { dumpTurnDiagnostic } = require('../services/backend/turn-diagnostic-dump');
const { startManagedSidecarChatStream } = require('../services/backend/managed-sidecar-chat');
const {
  buildManagedChatRequest,
  createManagedChatServiceStub,
} = require('./helpers/managed-sidecar-chat-lifecycle-helpers');

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-phase-client-timing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('client_timing keeps unmeasured send-phase markers absent instead of writing 0 (P3-PERF-A 2026-09-25)', async (t) => {
  // The aggregator shape carries explicit nulls for markers the renderer never
  // sent; Number(null) === 0 wrote 0 for all three into every diagnostic JSON.
  const userDataPath = makeTempDir(t);
  const service = { options: { userDataPath }, _emitServiceLog() {} };
  const dumped = await dumpTurnDiagnostic({
    service,
    sessionId: 'session-unmeasured',
    streamId: 'stream_unmeasured_1',
    terminalStatus: 'completed',
    clientTiming: { sendStartedAtMs: null, optimisticRenderedAtMs: null, localRenderLatencyMs: null },
  });
  const payload = JSON.parse(fs.readFileSync(dumped, 'utf8'));
  assert.equal(payload.client_timing, null);

  const partial = await dumpTurnDiagnostic({
    service,
    sessionId: 'session-unmeasured',
    streamId: 'stream_unmeasured_2',
    terminalStatus: 'completed',
    clientTiming: { send_started_at_ms: 0, optimistic_rendered_at_ms: '', local_render_latency_ms: 7, deltas_received: 0 },
  });
  const partialPayload = JSON.parse(fs.readFileSync(partial, 'utf8'));
  assert.equal('send_started_at_ms' in partialPayload.client_timing, false, 'epoch 0 is not a timestamp');
  assert.equal('optimistic_rendered_at_ms' in partialPayload.client_timing, false);
  assert.equal(partialPayload.client_timing.local_render_latency_ms, 7);
  assert.equal(partialPayload.client_timing.deltas_received, 0, 'a real zero counter survives');
});

test('managed chat logs null send-initiation latencies when the renderer sent no timing', async () => {
  const service = createManagedChatServiceStub();
  service.sidecarManager = {
    process: { pid: 4242 },
    getStatus: () => ({ phase: 'ready' }),
  };
  service.sidecarClient = {
    connected: true,
    async chatSend(_params, { onNotification }) {
      onNotification({ method: 'chat.token', params: { delta: 'Untimed.' } });
      onNotification({ method: 'chat.done', params: {} });
      return { status: 'completed' };
    },
  };
  const recorded = [];
  service.phasePercentilesAggregator = { record: (phase, value) => recorded.push([phase, value]) };
  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId: 'session_send_untimed',
  }));
  await service.activeStreams.get(stream.streamId)._pendingPromise;

  const sendInitiated = service.serviceLogs.find((entry) => entry.event === 'chat.send_initiated');
  assert.equal(sendInitiated.details.ipc_latency_ms, null);
  assert.equal(sendInitiated.details.local_render_latency_ms, null);
  assert.deepEqual(recorded.filter(([phase]) => phase === 'click_to_optimistic_render'
    || phase === 'optimistic_render_to_context_assembly_started'), []);
});
