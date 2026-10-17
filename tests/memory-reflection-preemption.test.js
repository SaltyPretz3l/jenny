'use strict';

// Reflection through the real runtime path (agentic memory v2, row 58 W2):
// memory.reflect holds the chat's turn lease as a preemptible, session-scoped
// auxiliary request; a foreground chat submit preempts it and is admitted, and
// a preempted reflection applies nothing. The scheduler runs on a fake clock;
// the managed fake sidecar speaks the reflection methods.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createManagedService, waitForChatStreamEvent } = require('./helpers/managed-sidecar-runtime-helpers');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');
const { preemptibleAuxiliaryCount } = require('../services/backend/auxiliary-preemption');
const { MemoryReflectionScheduler } = require('../services/backend/memory-reflection-scheduler');
const { buildMemoryReflectionFacet } = require('../services/backend/memory-reflection-status');

async function startService(t, sidecarArgs = []) {
  t.after(cleanupTrackedResources);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-reflection-runtime-'));
  trackDirectory(profile);
  const service = createManagedService(profile, { featureFlags: { session_runtime: true, memory_v2_enabled: true },
    sidecarArgs });
  await service.start();
  t.after(() => service.stop());
  const methods = [];
  const client = service.sidecarClient;
  const original = client.request.bind(client);
  client.request = (method, params, options) => {
    methods.push(method);
    return original(method, params, options);
  };
  const session = await service.createSession({ title: 'Reflect' });
  const sessionId = session.data.id;
  service.sessionStore.appendMessage(sessionId, { id: 'u1', role: 'user', content: 'I prefer tabs over spaces.' });
  service.sessionStore.appendMessage(sessionId, { id: 'a1', role: 'assistant', content: 'Tabs it is.' });
  const clock = { now: Date.now() };
  const scheduler = new MemoryReflectionScheduler({ service, now: () => clock.now, isBusy: () => false });
  service.memoryReflectionScheduler = scheduler;
  t.after(() => scheduler.dispose());
  clock.now += 31_000;
  return { service, sessionId, scheduler, methods };
}

async function waitFor(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('reflection runs under the session lease and appends a receipt', async t => {
  const { service, sessionId, scheduler, methods } = await startService(t);
  await scheduler.tick();
  assert.deepEqual(methods.filter(method => method.startsWith('memory.')),
    ['memory.reflection_state', 'memory.reflect', 'memory.apply']);
  const facet = buildMemoryReflectionFacet(service);
  assert.equal(facet.last_outcome, 'applied');
  assert.equal(facet.saved, 1);
  const receipt = service.sessionStore.getSessionMessages(sessionId).at(-1);
  assert.equal(receipt.kind, 'memory_note');
  assert.deepEqual(receipt.memory_notes.map(note => [note.origin, note.text_preview]),
    [['reflection', 'I prefer tabs over spaces.']]);
  assert.equal(service.sessionRuntime.lanes.snapshot().active_leases, 0);
});

test('a foreground chat submit preempts a running reflection, is admitted, and nothing is applied', async t => {
  const { service, sessionId, scheduler, methods } = await startService(t, ['--hold-auxiliary-until-cancel']);
  const running = scheduler.tick();
  await waitFor(() => preemptibleAuxiliaryCount(service) === 1, 'the held reflection');
  // A later round trip proves the fake has already admitted the held attempt.
  await service.sidecarClient.request('models.list', { engine_type: 'mock' });
  assert.equal(buildMemoryReflectionFacet(service).state, 'running');

  const started = waitForChatStreamEvent(service, event => event.type === 'started', 10000);
  const terminal = waitForChatStreamEvent(service, event => event.type === 'complete' || event.type === 'error', 10000);
  const stream = await service.startChatStream({ sessionId, prompt: 'Say hello.', preferredModel: 'mock-v1' });
  assert.ok(stream?.streamId, JSON.stringify(stream));
  assert.equal((await started).sessionId, sessionId);
  await running;

  const facet = buildMemoryReflectionFacet(service);
  assert.equal(facet.last_outcome, 'preempted');
  assert.equal(facet.preempted, 1);
  assert.equal(facet.failed, 0);
  assert.equal(methods.includes('memory.apply'), false);
  assert.equal(preemptibleAuxiliaryCount(service), 0);
  assert.equal((await terminal).type, 'complete');
  assert.equal(service.sessionStore.getSessionMessages(sessionId).some(message => message.role === 'tool'), false);
});
