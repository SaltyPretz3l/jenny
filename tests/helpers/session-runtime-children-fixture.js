'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAdapterHarness, waitFor } = require('./session-runtime-chat-adapter-harness');
const { initializeSessionRuntimeComposition } = require('../../services/session-runtime/composition');
const { RuntimeApplicationService } = require('../../services/session-runtime/application-service');
const { ensureSessionTurnActorRegistry } = require('../../services/backend/session-turn-actor');
const { retainManagedRuntimeController } = require('../../services/backend/chat-lifecycle-contracts');

async function fixture(t, { workspace = false } = {}) {
  const h = createAdapterHarness(t, { registerTeardown: false });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-runtime-children-'));
  const authority = { ...h.service.projectAuthority.captureSession(h.sessionId),
    ...(workspace ? { root_path: root, root_id: 'root_fixture', root_revision: 1 } : {}) };
  h.service.projectAuthority.requireCurrent = current => { assert.deepEqual(current, authority); return current; };
  h.service.projectAuthority.captureSession = id => {
    assert.equal(h.service.sessionStore.getSessionSummary(id).project_id, authority.project_id);
    return authority;
  };
  h.service.options = { userDataPath: root };
  h.service.featureFlags.session_runtime = true;
  h.service.turnEventJournal = { list: () => [] };
  const logs = [];
  h.service._emitServiceLog = (...args) => logs.push(args);
  ensureSessionTurnActorRegistry(h.service);
  const runtime = initializeSessionRuntimeComposition(h.service);
  const starts = [];
  h.service.cancelChatStream = streamId => {
    starts.find(entry => entry.request.turnLease.identity.streamId === streamId)?.complete('cancelled');
  };
  h.service._startManagedSidecarChatStream = async request => {
    const lease = request.turnLease;
    if (!h.service.sessionStore.getSession(request.sessionId).messages.some(row => row.id === lease.identity.userMessageId)) {
      h.service.sessionStore.appendMessage(request.sessionId, { id: lease.identity.userMessageId,
        role: 'user', kind: 'message', content: request.prompt, turn_id: lease.identity.turnId,
        timestamp: new Date().toISOString() });
    }
    const controller = new AbortController();
    h.service.sessionTurnActors.attachController(lease, controller);
    let finish;
    controller._runtimeCompletion = new Promise(resolve => { finish = resolve; });
    const complete = (status = 'completed') => {
      h.service.sessionTurnActors.release(lease, { status });
      finish({ status, producerSettled: true, canonicalSettled: true });
    };
    controller.signal.addEventListener('abort', () => complete('cancelled'), { once: true });
    starts.push({ request, complete, settle: finish });
    return retainManagedRuntimeController({ sessionId: request.sessionId, streamId: lease.identity.streamId }, controller);
  };
  t.after(async () => {
    const schedulers = new Set([runtime.scheduler, h.service.sessionRuntime?.scheduler].filter(Boolean));
    for (const scheduler of schedulers) scheduler.beginClosing();
    for (const entry of starts) entry.complete();
    await Promise.allSettled([...schedulers].flatMap(scheduler => scheduler.cleanupPromises()));
    await h.disposeHarness();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const app = new RuntimeApplicationService({ getRuntime: () => runtime });
  const started = await app.start({ session_id: h.sessionId, prompt: 'Inspect', idempotency_key: 'root_1',
    purpose: 'Inspect project', limits: { inference_requests: 3, input_tokens: 96, output_tokens: 96 } });
  assert.equal(started.ok, true);
  await waitFor(() => starts.length === 1, () => JSON.stringify(logs));
  return { ...h, runtime, app, started, starts, logs,
    spawn: (task = 'Read the project', call = 'spawn_1') => starts[0].request.runtimeOperationGateway.children.spawn({ task }, call) };
}

module.exports = { fixture };
