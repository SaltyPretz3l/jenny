'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createManagedService, waitForChatStreamEvent } = require('../helpers/managed-sidecar-runtime-helpers');
const { cleanupTrackedResources, trackDirectory } = require('../helpers/resource-cleanup');
const { API_VERSION } = require('../../services/backend/sidecar-client');
const { requestRuntimeInference } = require('../../services/backend/backend-runtime-inference');
const { preemptibleAuxiliaryCount } = require('../../services/backend/auxiliary-preemption');

const ADMISSION_BUDGET_MS = 2000;

test('chat admission preempts a held suggestion request and is admitted within the budget', async t => {
  t.after(cleanupTrackedResources);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-aux-preempt-'));
  trackDirectory(profile);
  const service = createManagedService(profile, { featureFlags: { session_runtime: true },
    sidecarArgs: ['--hold-auxiliary-until-cancel'] });
  await service.start();
  t.after(() => service.stop());
  const session = await service.createSession({ title: 'Preempt background work' });
  const lanes = service.sessionRuntime.lanes;
  const logs = [];
  service.on('service-log', entry => logs.push(entry));

  // The fake sidecar admits the attempt and holds the request until chat.cancel
  // names it, so the single local inference lane stays occupied.
  const suggestion = requestRuntimeInference(service, 'suggestions.generate',
    { accept_version: API_VERSION, time_of_day: 'morning' }, { preemptible: true });
  const suggestionOutcome = suggestion.then(value => ({ value }), error => ({ error }));
  // A later round trip proves the fake has already sent its admit reverse request.
  await service.sidecarClient.request('models.list', { engine_type: 'mock' });
  assert.equal(preemptibleAuxiliaryCount(service), 1);
  assert.equal(lanes.snapshot().lanes.find(lane => lane.lane === 'local')?.inference_requests, 1);

  const started = waitForChatStreamEvent(service, event => event.type === 'started', 10000);
  const terminal = waitForChatStreamEvent(service, event => event.type === 'complete' || event.type === 'error', 10000);
  const submittedAt = performance.now();
  const stream = await service.startChatStream({ sessionId: session.data.id, prompt: 'Say hello.',
    preferredModel: 'mock-v1' });
  const admissionMs = performance.now() - submittedAt;
  t.diagnostic(`chat admission after preemption: ${admissionMs.toFixed(1)} ms`);

  assert.ok(stream?.streamId, JSON.stringify(stream));
  assert.ok(admissionMs < ADMISSION_BUDGET_MS, `admission took ${admissionMs} ms`);
  assert.equal((await started).sessionId, session.data.id);
  const { error } = await suggestionOutcome;
  assert.equal(error?.reason, 'auxiliary_preempted');
  assert.equal(preemptibleAuxiliaryCount(service), 0);
  const preempted = logs.find(entry => entry.event === 'runtime.auxiliary_preempted');
  assert.deepEqual({ ...preempted.details, elapsed_ms: 0 },
    { reason: 'chat_admission', preempted: 1, settled: 1, abandoned: 0, elapsed_ms: 0 });
  assert.equal(lanes.snapshot().quarantined, 0);
  assert.equal((await terminal).type, 'complete');
});

test('a durable runtime submit also preempts held background work before taking the lane', async t => {
  t.after(cleanupTrackedResources);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-aux-preempt-submit-'));
  trackDirectory(profile);
  const service = createManagedService(profile, { featureFlags: { session_runtime: true },
    sidecarArgs: ['--hold-auxiliary-until-cancel'] });
  await service.start();
  t.after(() => service.stop());
  const session = await service.createSession({ title: 'Preempt on submit' });
  const suggestion = requestRuntimeInference(service, 'suggestions.generate',
    { accept_version: API_VERSION, time_of_day: 'morning' }, { preemptible: true });
  const suggestionOutcome = suggestion.then(value => ({ value }), error => ({ error }));
  await service.sidecarClient.request('models.list', { engine_type: 'mock' });
  assert.equal(preemptibleAuxiliaryCount(service), 1);

  const started = waitForChatStreamEvent(service, event => event.type === 'started', 10000);
  const submittedAt = performance.now();
  await service.sessionRuntime.submit({ sessionId: session.data.id, prompt: 'Say hello.',
    preferredModel: 'mock-v1' }, { idempotencyKey: 'preempt-submit' });
  assert.equal((await started).sessionId, session.data.id);
  const admissionMs = performance.now() - submittedAt;
  t.diagnostic(`durable submit admission after preemption: ${admissionMs.toFixed(1)} ms`);
  assert.ok(admissionMs < ADMISSION_BUDGET_MS, `admission took ${admissionMs} ms`);
  assert.equal((await suggestionOutcome).error?.reason, 'auxiliary_preempted');
  assert.equal(preemptibleAuxiliaryCount(service), 0);
});
