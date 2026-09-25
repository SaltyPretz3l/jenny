"use strict";
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { ROOT, waitFor, createBackend, holdAtAdmission } = require('../helpers/session-runtime-stdio-fixture');
for (const child of [false, true]) test(`real ${child ? 'dependency' : 'decision'} -> resource -> ${child ? 'dependency' : 'decision'} preserves progress`, { timeout: 55000 }, async t => {
  const root = fs.mkdtempSync(path.join(ROOT, 'artifacts', 'resource-transitions-'));
  const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  for (const name of ['first.txt', 'blocked.txt']) fs.writeFileSync(path.join(workspace, name), name);
  const question = { tool_id: 'ask_user', arguments: { questions: [{ id: 'choice', prompt: 'Continue?' }] } };
  const script = path.join(root, 'replay.json');
  fs.writeFileSync(script, JSON.stringify({ version: 1, calls: [
    { tool_calls: [{ tool_id: 'read_file', arguments: { path: 'first.txt' } }] },
    { tool_calls: [question] }, { tool_calls: [{ tool_id: 'read_file', arguments: { path: 'blocked.txt' } }] },
    { tool_calls: [question] }, { text: 'Done.' },
  ] }));
  const old = process.env.JENNY_REPLAY_SCRIPT; process.env.JENNY_REPLAY_SCRIPT = script;
  t.after(() => { if (old === undefined) delete process.env.JENNY_REPLAY_SCRIPT; else process.env.JENNY_REPLAY_SCRIPT = old;
    fs.rmSync(root, { recursive: true, force: true }); });
  const seen = []; const logs = [];
  const make = () => createBackend(profile, workspace, seen, logs, 'user_questions', child
    ? [path.join(ROOT, 'tests/helpers/session-runtime-resource-child-sidecar.py')] : undefined);
  let backend = make(); let workId;
  const work = () => backend.sessionRuntime.store.get(workId);
  const resume = () => assert.equal(backend.runtimeApplicationService.resume({ work_id: workId, expected_revision: work().revision }).ok, true);
  const checkpoint = () => backend.sessionRuntime.checkpointStore.read(work().checkpoint_ref, work());
  const pending = () => [...backend.pendingUserQuestions.entries()][0];
  const answer = reference => assert.equal(backend.answerUserQuestions(reference, { answers: [{ id: 'choice', value: 'Continue' }] }), true);
  const pauseQuestion = async () => {
    const [reference] = await waitFor(pending);
    assert.equal(backend.runtimeApplicationService.pause({ work_id: workId, expected_revision: work().revision }).ok, true);
    await waitFor(() => work().status !== 'running'); assert.equal(work().status, 'paused');
    assert.equal(backend.answerUserQuestions(reference, { answers: [] }), false);
    return checkpoint();
  };
  const restart = async () => { await backend.stop(); backend.dispose(); backend = make(); await backend.start(); };
  try {
    await backend.start();
    const sessionId = (await backend.createSession({ title: 'Resource transitions' })).data.id;
    const projects = backend.projectApplicationService;
    const project = projects.createProject({ name: 'Resource workspace' }).project;
    assert.equal(projects.bindProjectRoot({ project_id: project.id, root_path: workspace, expected_root_revision: project.root_revision }).ok, true);
    assert.equal(projects.assignSessionProject({ session_id: sessionId, project_id: project.id }).ok, true);
    if (child) holdAtAdmission(backend.sessionRuntime, workspace, 1);
    const request = { session_id: sessionId, prompt: 'Resource transition parent', idempotency_key: 'transition_fixture' };
    const sent = child ? await backend.runtimeApplicationService.start({ ...request, purpose: 'Resource child transitions',
      limits: { inference_requests: 12, input_tokens: 1000000, output_tokens: 1000000 } })
      : await backend.runtimeApplicationService.submit(request);
    assert.equal(sent.ok, true); workId = sent.work_id;
    if (!child) {
      const first = await pauseQuestion(); assert.equal(first.kind, 'before_decision_wait');
      await restart(); holdAtAdmission(backend.sessionRuntime, workspace, 1); resume();
      answer((await waitFor(pending))[0]);
    }
    await waitFor(() => work().status === 'paused' && checkpoint().kind === 'before_tool_dispatch');
    const resource = checkpoint(); assert.equal(resource.base_schema_version, 8);
    assert.equal(resource.completed_effect_refs.length, 2); assert.ok(resource.prior_checkpoint_ref);
    const prefix = backend.sessionStore.getSession(sessionId).turn_events.filter(event => event.kind === 'tool_result');
    assert.equal(prefix.length, 2);
    await restart(); resume();
    if (!child) {
      const last = await pauseQuestion();
      assert.equal(last.prior_checkpoint_ref.checkpoint_id, resource.identity.checkpoint_id);
      assert.deepEqual(last.completed_effect_refs.slice(0, 2), resource.completed_effect_refs);
      await restart(); resume(); answer((await waitFor(pending))[0]);
    }
    await waitFor(() => ['completed', 'failed', 'needs_attention'].includes(work().status));
    assert.equal(work().status, 'completed', JSON.stringify(work()));
    const results = backend.sessionStore.getSession(sessionId).turn_events.filter(event => event.kind === 'tool_result');
    assert.equal(results.length, child ? 5 : 4); assert.deepEqual(results.slice(0, 2), prefix);
    if (child) {
      assert.deepEqual(results.map(row => row.payload.tool_name), ['session_spawn', 'session_wait', 'read_file', 'session_spawn', 'session_wait']);
      assert.equal(work().checkpoint_ref !== null, true);
    }
  } catch (error) { t.diagnostic(JSON.stringify({ work: workId ? work() : null, errors: seen.filter(row => row.type === 'error'), logs: logs.slice(-6) })); throw error; }
  finally { await backend.stop(); backend.dispose(); }
});
