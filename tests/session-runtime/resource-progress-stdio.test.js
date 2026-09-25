"use strict";
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { ROOT, waitFor, createBackend, holdAtAdmission } = require('../helpers/session-runtime-stdio-fixture');
for (const [laterGeneration, repeated, action = 'resume'] of [
  [false, false], [false, true], [true, false], [true, true],
  [false, false, 'write_failure'], [false, false, 'cancel'], [false, false, 'policy'],
]) test(`real resource wait preserves completed read across restart (laterGeneration=${laterGeneration}, repeated=${repeated}, action=${action})`, { timeout: 45000 }, async t => {
  const root = fs.mkdtempSync(path.join(ROOT, 'artifacts', 'resource-progress-'));
  const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  for (const name of ['first.txt', 'blocked.txt']) fs.writeFileSync(path.join(workspace, name), name);
  const first = { tool_id: 'read_file', arguments: { path: 'first.txt' } };
  const blocked = { tool_id: 'read_file', arguments: { path: 'blocked.txt' } };
  const script = path.join(root, 'replay.json');
  fs.writeFileSync(script, JSON.stringify({ version: 1, calls: laterGeneration
    ? [{ tool_calls: [first] }, { tool_calls: [blocked] }, { text: 'Done.' }]
    : [{ tool_calls: [first, blocked] }, { text: 'Unused result slot.' }, { text: 'Done.' }] }));
  const old = process.env.JENNY_REPLAY_SCRIPT; process.env.JENNY_REPLAY_SCRIPT = script;
  t.after(() => { if (old === undefined) delete process.env.JENNY_REPLAY_SCRIPT; else process.env.JENNY_REPLAY_SCRIPT = old;
    fs.rmSync(root, { recursive: true, force: true }); });
  const seen = []; const logs = [];
  const make = () => createBackend(profile, workspace, seen, logs, 'user_questions');
  let backend = make(); let workId;
  try {
    await backend.start();
    const sessionId = (await backend.createSession({ title: 'Resource suffix' })).data.id;
    const projects = backend.projectApplicationService;
    const project = projects.createProject({ name: 'Resource workspace' }).project;
    assert.equal(projects.bindProjectRoot({ project_id: project.id, root_path: workspace, expected_root_revision: project.root_revision }).ok, true);
    assert.equal(projects.assignSessionProject({ session_id: sessionId, project_id: project.id }).ok, true);
    const runtime = backend.sessionRuntime;
    holdAtAdmission(runtime, workspace, 2);
    if (['write_failure', 'cancel'].includes(action)) runtime.checkpointStore.begin = () => {
      if (action === 'cancel') {
        const current = runtime.store.get(workId);
        assert.equal(backend.runtimeApplicationService.cancel({ work_id: workId, expected_revision: current.revision }).ok, true);
      }
      throw new Error('fixture_resource_checkpoint_write_failed');
    };
    const sent = await backend.runtimeApplicationService.submit({ session_id: sessionId,
      prompt: 'Read the two files in order.', idempotency_key: 'resource_fixture' });
    assert.equal(sent.ok, true); workId = sent.work_id;
    await waitFor(() => !['running', 'pending'].includes(runtime.store.get(workId).status));
    const paused = runtime.store.get(workId);
    if (['write_failure', 'cancel'].includes(action)) {
      assert.notEqual(paused.status, 'paused'); assert.notEqual(paused.status, 'completed');
      const results = backend.sessionStore.getSession(sessionId).turn_events.filter(event => event.kind === 'tool_result');
      assert.equal(results.length, 1, JSON.stringify(results));
      assert.match(results[0].payload.tool_output_summary, /first.txt/);
      return;
    }
    assert.equal(paused.status, 'paused', JSON.stringify(paused));
    const checkpoint = runtime.checkpointStore.read(paused.checkpoint_ref, paused);
    assert.equal(checkpoint.schema_version, 7); assert.equal(checkpoint.base_schema_version, 8);
    assert.equal(checkpoint.completed_effect_refs.length, 1);
    assert.equal(checkpoint.position.ordered_call_ids.length, 1);
    assert.equal(checkpoint.quota_state.admissions.length, 2);
    const before = backend.sessionStore.getSession(sessionId).turn_events.filter(event => event.kind === 'tool_result');
    assert.equal(before.length, 1); assert.match(before[0].payload.tool_output_summary, /first.txt/);
    await backend.stop(); backend.dispose(); backend = make(); await backend.start();
    if (action === 'policy') backend.toolPermissionStore.setPolicy('read_file', 'deny');
    const release = repeated ? holdAtAdmission(backend.sessionRuntime, workspace, 1) : null;
    let saved = backend.sessionRuntime.store.get(workId);
    assert.equal(backend.runtimeApplicationService.resume({ work_id: workId, expected_revision: saved.revision }).ok, true);
    if (repeated) {
      await waitFor(() => !['running', 'pending'].includes(backend.sessionRuntime.store.get(workId).status));
      saved = backend.sessionRuntime.store.get(workId);
      assert.equal(saved.status, 'paused', JSON.stringify(saved));
      const again = backend.sessionRuntime.checkpointStore.read(saved.checkpoint_ref, saved);
      assert.deepEqual(again.completed_effect_refs, checkpoint.completed_effect_refs);
      assert.deepEqual(again.quota_state.admissions, checkpoint.quota_state.admissions);
      assert.equal(again.prior_checkpoint_ref.checkpoint_id, checkpoint.identity.checkpoint_id);
      assert.equal(release(), true);
      assert.equal(backend.runtimeApplicationService.resume({ work_id: workId, expected_revision: saved.revision }).ok, true);
    }
    await waitFor(() => ['completed', 'failed', 'needs_attention'].includes(backend.sessionRuntime.store.get(workId).status));
    if (action === 'policy') {
      assert.equal(backend.sessionRuntime.store.get(workId).status, 'failed');
      assert.deepEqual(backend.sessionStore.getSession(sessionId).turn_events.filter(event => event.kind === 'tool_result'), before);
      return;
    }
    assert.equal(backend.sessionRuntime.store.get(workId).status, 'completed');
    const results = backend.sessionStore.getSession(sessionId).turn_events.filter(event => event.kind === 'tool_result');
    assert.equal(results.length, 2); assert.deepEqual(results[0], before[0]);
    assert.match(results[1].payload.tool_output_summary, /blocked.txt/);
    assert.notEqual(results[0].tool_call_id, results[1].tool_call_id);
  } catch (error) {
    t.diagnostic(JSON.stringify({ work: workId ? backend.sessionRuntime.store.get(workId) : null,
      errors: seen.filter(row => row.type === 'error'), results: workId ? backend.sessionStore.getSession(backend.sessionRuntime.store.get(workId).session_id).turn_events.filter(row => row.kind === 'tool_result') : [], logs: logs.filter(row => /resource|capture|stderr|error/i.test(JSON.stringify(row))).slice(-16) })); throw error;
  } finally { await backend.stop(); backend.dispose(); }
});
