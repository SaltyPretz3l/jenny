"use strict";
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { ROOT, waitFor, createBackend } = require('../helpers/session-runtime-stdio-fixture');

function holdToolCapacity(runtime, target) {
  const broker = runtime.resourceBroker;
  const acquire = broker.tryAcquire.bind(broker); let calls = 0; let lease;
  broker.tryAcquire = request => {
    if (++calls === target) {
      const held = acquire({ ownerId: 'fixture-electron-held', resources: [
        require('../../services/session-runtime/resource-broker').capacityResource('tool_operations',
          broker.snapshot().limits.tool_operations)] });
      assert.equal(held.status, 'granted'); lease = held.lease;
    }
    return acquire(request);
  };
  return () => broker.release(lease, { producerSettled: true });
}

test('real Electron wait restarts twice without executing the pending producer or replaying the prefix', { timeout: 45000 }, async t => {
  const root = fs.mkdtempSync(path.join(ROOT, 'artifacts', 'electron-resource-'));
  const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  for (const name of ['first.txt', 'blocked.txt']) fs.writeFileSync(path.join(workspace, name), name);
  const script = path.join(root, 'replay.json');
  fs.writeFileSync(script, JSON.stringify({ version: 1, calls: [
    { tool_calls: [{ tool_id: 'read_file', arguments: { path: 'first.txt' } },
      { tool_id: 'jenny_status', arguments: {} }] }, { text: 'Unused slot.' }, { text: 'Done.' },
  ] }));
  const old = process.env.JENNY_REPLAY_SCRIPT; process.env.JENNY_REPLAY_SCRIPT = script;
  t.after(() => { if (old === undefined) delete process.env.JENNY_REPLAY_SCRIPT; else process.env.JENNY_REPLAY_SCRIPT = old;
    fs.rmSync(root, { recursive: true, force: true }); });
  const seen = []; const logs = []; let producerCount = 0;
  const make = () => {
    const backend = createBackend(profile, workspace, seen, logs, 'user_questions');
    const definition = require('../../services/tools/builtin/jenny-status-tool');
    backend.toolExecutor.registry.registerTool({ ...definition, execute: async (...args) => {
      producerCount++; return definition.execute(...args);
    } });
    return backend;
  };
  let backend = make(); let workId;
  try {
    await backend.start();
    const sessionId = (await backend.createSession({ title: 'Electron resource suffix' })).data.id;
    const projects = backend.projectApplicationService;
    const project = projects.createProject({ name: 'Electron workspace' }).project;
    assert.equal(projects.bindProjectRoot({ project_id: project.id, root_path: workspace, expected_root_revision: project.root_revision }).ok, true);
    assert.equal(projects.assignSessionProject({ session_id: sessionId, project_id: project.id }).ok, true);
    holdToolCapacity(backend.sessionRuntime, 2);
    const sent = await backend.runtimeApplicationService.submit({ session_id: sessionId,
      prompt: 'Read first.txt then report Jenny status.', idempotency_key: 'electron_resource_fixture' });
    assert.equal(sent.ok, true); workId = sent.work_id;
    await waitFor(() => !['running', 'pending'].includes(backend.sessionRuntime.store.get(workId).status));
    const paused = backend.sessionRuntime.store.get(workId);
    assert.equal(paused.status, 'paused', JSON.stringify(paused)); assert.equal(producerCount, 0);
    const checkpoint = backend.sessionRuntime.checkpointStore.read(paused.checkpoint_ref, paused);
    assert.equal(checkpoint.base_schema_version, 8);
    const before = backend.sessionStore.getSession(sessionId).turn_events.filter(e => e.kind === 'tool_result');
    assert.equal(before.length, 1);
    await backend.stop(); backend.dispose(); backend = make(); await backend.start();
    const release = holdToolCapacity(backend.sessionRuntime, 1);
    let saved = backend.sessionRuntime.store.get(workId);
    assert.equal(backend.runtimeApplicationService.resume({ work_id: workId, expected_revision: saved.revision }).ok, true);
    await waitFor(() => !['running', 'pending'].includes(backend.sessionRuntime.store.get(workId).status));
    saved = backend.sessionRuntime.store.get(workId);
    assert.equal(saved.status, 'paused', JSON.stringify(saved)); assert.equal(producerCount, 0);
    const again = backend.sessionRuntime.checkpointStore.read(saved.checkpoint_ref, saved);
    assert.deepEqual(again.completed_effect_refs, checkpoint.completed_effect_refs);
    assert.deepEqual(again.quota_state.admissions, checkpoint.quota_state.admissions);
    assert.equal(release(), true);
    assert.equal(backend.runtimeApplicationService.resume({ work_id: workId, expected_revision: saved.revision }).ok, true);
    await waitFor(() => ['completed', 'failed', 'needs_attention'].includes(backend.sessionRuntime.store.get(workId).status));
    assert.equal(backend.sessionRuntime.store.get(workId).status, 'completed');
    const results = backend.sessionStore.getSession(sessionId).turn_events.filter(e => e.kind === 'tool_result');
    assert.equal(results.length, 2); assert.deepEqual(results[0], before[0]); assert.equal(producerCount, 1);
    assert.notEqual(results[0].tool_call_id, results[1].tool_call_id);
  } catch (error) {
    t.diagnostic(JSON.stringify({ work: workId ? backend.sessionRuntime.store.get(workId) : null,
      errors: seen.filter(row => row.type === 'error'), logs: logs.filter(row => /resource|capture|stderr|error/i.test(JSON.stringify(row))).slice(-12) }));
    throw error;
  } finally { await backend.stop(); backend.dispose(); }
});
