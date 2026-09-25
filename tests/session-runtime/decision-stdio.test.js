'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { ROOT, waitFor, createBackend } = require('../helpers/session-runtime-stdio-fixture');
function pendingDecisions(backend, kind) {
  return kind === 'approval' ? backend.pendingToolApprovals : backend.pendingUserQuestions;
}
function answer(backend, kind, reference) {
  return kind === 'approval' ? backend.approveToolCall(reference)
    : backend.answerUserQuestions(reference, { answers: [{ id: 'choice', value: 'Continue' }] });
}
async function pauseAtDecision(backend, workId, kind, expectedStream = null) {
  const [reference, waiter] = await waitFor(() => {
    const work = backend.sessionRuntime.store.get(workId);
    if (work.status !== 'running' && work.status !== 'pending') {
      throw new Error(JSON.stringify({ status: work.status,
        events: backend.sessionStore.getSession(work.session_id).turn_events
          .filter(row => row.kind === 'tool_result').map(row => row.payload) }));
    }
    return [...pendingDecisions(backend, kind).entries()]
      .find(([, entry]) => !expectedStream || entry.streamId !== expectedStream);
  });
  assert.equal(waiter.requireExactRef, true, 'Python must offer a restorable decision');
  const runtime = backend.sessionRuntime;
  const work = runtime.store.get(workId);
  assert.equal(backend.runtimeApplicationService.pause({ work_id: workId, expected_revision: work.revision }).ok, true);
  await waitFor(() => runtime.store.get(workId).status !== 'running');
  const paused = runtime.store.get(workId);
  assert.equal(paused.status, 'paused', JSON.stringify(paused));
  assert.ok(paused.checkpoint_ref);
  assert.equal(pendingDecisions(backend, kind).size, 0);
  assert.equal(answer(backend, kind, reference), false);
  const checkpoint = runtime.checkpointStore.read(paused.checkpoint_ref, paused);
  assert.equal(checkpoint.kind, 'before_decision_wait');
  assert.equal(checkpoint.schema_version, 7);
  assert.equal(checkpoint.quota_state.enabled, true);
  assert.equal(checkpoint.quota_state.admissions.length, 3);
  assert.equal(checkpoint.decision.kind, kind);
  assert.equal(checkpoint.completed_effect_refs.length, 1);
  assert.equal(checkpoint.position.tool_calls_consumed, 3);
  return { paused, checkpoint, reference, waiter };
}
for (const [kind, reconstruct, publicationFailure, policyDrift = false] of [
  ['approval', false, false], ['approval', true, false],
  ['user_questions', false, false], ['user_questions', true, false],
  ['user_questions', false, 'write'], ['user_questions', false, 'cancel'],
  ['user_questions', true, false, true],
]) {
  test(`real Python ${kind} checkpoint resumes once with fresh consent (reconstruct=${reconstruct}, publicationFailure=${publicationFailure}, policyDrift=${policyDrift})`, { timeout: 55_000 }, async t => {
    const artifacts = path.join(ROOT, 'artifacts'); fs.mkdirSync(artifacts, { recursive: true });
    const root = fs.mkdtempSync(path.join(artifacts, 'desktop-decision-'));
    const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
    const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(workspace, 'fixture.txt'), 'Saved approval result.');
    fs.writeFileSync(path.join(workspace, 'later.txt'), 'Later file.');
    const script = path.join(root, 'replay.json');
    const completedCall = { tool_id: 'list_dir', arguments: { path: '.' } };
    const decisionCall = kind === 'approval'
      ? { tool_id: 'read_file', arguments: { path: 'fixture.txt' } }
      : { tool_id: 'ask_user', arguments: { questions: [{ id: 'choice', prompt: 'Continue?' }] } };
    const laterCall = { tool_id: 'read_file', arguments: { path: kind === 'approval' ? 'later.txt' : 'fixture.txt' } };
    // Replay advances by result count. Unused slots preserve a stable final index.
    const padding = { text: 'Unused per-result replay slot.' };
    const batches = kind === 'approval'
      ? [{ tool_calls: [completedCall] }, { tool_calls: [decisionCall, laterCall] }, padding]
      : reconstruct
        ? [{ tool_calls: [completedCall] }, { tool_calls: [decisionCall, laterCall] }, padding]
        : [{ tool_calls: [completedCall, decisionCall, laterCall] }, padding, padding];
    fs.writeFileSync(script, JSON.stringify({ version: 1, calls: [
      ...batches, { text: 'Finished after the decision.' },
    ] }));
    const prior = process.env.JENNY_REPLAY_SCRIPT;
    process.env.JENNY_REPLAY_SCRIPT = script;
    t.after(() => { if (prior === undefined) delete process.env.JENNY_REPLAY_SCRIPT; else process.env.JENNY_REPLAY_SCRIPT = prior; });
    const seen = []; const logs = [];
    let backend = createBackend(profile, workspace, seen, logs, kind);
    try {
      await backend.start();
      const sessionId = (await backend.createSession({ title: 'Decision checkpoint' })).data.id;
      const projects = backend.projectApplicationService;
      const created = projects.createProject({ name: 'Fixture workspace' });
      assert.equal(created.ok, true, JSON.stringify(created));
      assert.equal(projects.bindProjectRoot({ project_id: created.project.id, root_path: workspace,
        expected_root_revision: created.project.root_revision }).ok, true);
      assert.equal(projects.assignSessionProject({ session_id: sessionId, project_id: created.project.id }).ok, true);
      const request = { session_id: sessionId, prompt: 'List and read the fixture.', idempotency_key: 'decision_fixture' };
      const sent = reconstruct ? await backend.runtimeApplicationService.start({ ...request,
        purpose: 'Bounded decision continuation',
        limits: { inference_requests: 3, input_tokens: 1_000_000, output_tokens: 1_000_000 } })
        : await backend.runtimeApplicationService.submit(request);
      assert.equal(sent.ok, true, JSON.stringify(sent));
      if (publicationFailure) {
        const [reference] = await waitFor(() => [...backend.pendingUserQuestions.entries()][0]);
        backend.sessionRuntime.checkpointStore.begin = () => {
          if (publicationFailure === 'cancel') {
            const current = backend.sessionRuntime.store.get(sent.work_id);
            assert.equal(backend.runtimeApplicationService.cancel({ work_id: sent.work_id,
              expected_revision: current.revision }).ok, true);
          }
          throw new Error('fixture_checkpoint_write_failed');
        };
        const work = backend.sessionRuntime.store.get(sent.work_id);
        assert.equal(backend.runtimeApplicationService.pause({ work_id: sent.work_id,
          expected_revision: work.revision }).ok, true);
        await waitFor(() => backend.sessionRuntime.store.get(sent.work_id).status !== 'running');
        const stopped = backend.sessionRuntime.store.get(sent.work_id);
        assert.notEqual(stopped.status, 'paused');
        assert.notEqual(stopped.status, 'completed');
        assert.equal(backend.pendingUserQuestions.size, 0);
        assert.equal(answer(backend, kind, reference), false);
        const results = backend.sessionStore.getSession(sessionId).turn_events.filter(row => row.kind === 'tool_result');
        assert.deepEqual(results.map(row => row.payload.tool_name), ['list_dir'], JSON.stringify(results));
        return;
      }
      const first = await pauseAtDecision(backend, sent.work_id, kind);
      const firstBudget = reconstruct ? backend.sessionRuntime.budgetStore.get(sent.root_run_id) : null;
      if (firstBudget) assert.equal(firstBudget.charged.inference_requests, 2);
      if (reconstruct) {
        await backend.stop(); backend.dispose();
        backend = createBackend(profile, workspace, seen, logs, kind);
        await backend.start();
        assert.equal(pendingDecisions(backend, kind).size, 0);
        assert.equal(backend.sessionRuntime.store.get(sent.work_id).status, 'paused');
        assert.deepEqual(backend.sessionRuntime.budgetStore.get(sent.root_run_id).charged, firstBudget.charged);
        assert.equal(answer(backend, kind, first.reference), false);
      }
      if (policyDrift) {
        backend.toolPermissionStore.setPolicy('read_file', 'deny');
        const waiting = backend.sessionRuntime.store.get(sent.work_id);
        const response = backend.runtimeApplicationService.resume({ work_id: sent.work_id,
          expected_revision: waiting.revision });
        if (response.ok) await waitFor(() => !['running', 'pending'].includes(backend.sessionRuntime.store.get(sent.work_id).status));
        assert.notEqual(backend.sessionRuntime.store.get(sent.work_id).status, 'completed');
        assert.equal(backend.pendingUserQuestions.size, 0);
        assert.equal(answer(backend, kind, first.reference), false);
        assert.deepEqual(backend.sessionStore.getSession(sessionId).turn_events
          .filter(row => row.kind === 'tool_result').map(row => row.payload.tool_name), ['list_dir']);
        return;
      }
      const paused = backend.sessionRuntime.store.get(sent.work_id);
      assert.equal(backend.runtimeApplicationService.resume({ work_id: sent.work_id, expected_revision: paused.revision }).ok, true);
      if (reconstruct) {
        const second = await pauseAtDecision(backend, sent.work_id, kind, first.waiter.streamId);
        assert.equal(second.checkpoint.prior_checkpoint_ref.checkpoint_id, first.checkpoint.identity.checkpoint_id);
        assert.equal(second.checkpoint.prior_effect_count, 1);
        assert.deepEqual(backend.sessionRuntime.budgetStore.get(sent.root_run_id).charged, firstBudget.charged);
        assert.deepEqual(second.checkpoint.completed_effect_refs, first.checkpoint.completed_effect_refs);
        assert.deepEqual(second.checkpoint.quota_state.admissions, first.checkpoint.quota_state.admissions);
        assert.equal(second.checkpoint.quota_state.session_baseline, first.checkpoint.quota_state.session_baseline);
        assert.ok(second.checkpoint.position.active_budget_ms_remaining <= first.checkpoint.position.active_budget_ms_remaining);
        assert.notEqual(second.checkpoint.decision.decision_id, first.checkpoint.decision.decision_id);
        assert.equal(backend.runtimeApplicationService.resume({ work_id: sent.work_id, expected_revision: second.paused.revision }).ok, true);
      }
      const [freshRef, fresh] = await waitFor(() => [...pendingDecisions(backend, kind).entries()]
        .find(([, waiter]) => waiter.streamId !== first.waiter.streamId));
      assert.notEqual(freshRef, first.reference);
      assert.equal(answer(backend, kind, first.waiter.callId), false);
      assert.equal(answer(backend, kind, first.reference), false);
      assert.equal(answer(backend, kind, freshRef), true);
      await waitFor(() => backend.sessionRuntime.store.get(sent.work_id).status === 'completed');
      const results = backend.sessionStore.getSession(sessionId).turn_events.filter(event => event.kind === 'tool_result');
      const expectedTools = kind === 'approval' ? ['list_dir', 'read_file', 'read_file'] : ['list_dir', 'ask_user', 'read_file'];
      assert.deepEqual(results.map(event => event.payload.tool_name), expectedTools, JSON.stringify(results));
      assert.equal(new Set(results.map(event => event.tool_call_id)).size, expectedTools.length);
      assert.equal(results.at(-1).payload.tool_output_summary, 'Saved approval result.');
      if (kind === 'approval') {
        // Ordinary approval executes its selected window and explicitly settles
        // later reserved calls as dropped; continuation preserves that contract.
        assert.equal(results[1].payload.success, false);
        assert.equal(results[1].payload.metadata.approval_window_dropped, true);
        assert.equal(results[1].payload.tool_input.path, 'later.txt');
        assert.equal(results[2].payload.success, true);
      }
      else assert.match(results[1].payload.tool_output_summary, /A: Continue/);
      assert.notEqual(fresh.streamId, first.waiter.streamId);
      if (firstBudget) {
        const finalBudget = backend.sessionRuntime.budgetStore.get(sent.root_run_id);
        assert.equal(finalBudget.charged.inference_requests, 3);
        assert.deepEqual(finalBudget.limits, firstBudget.limits);
      }
    } catch (error) {
      t.diagnostic(JSON.stringify({ work: backend.sessionRuntime.store.listSummaries({ limit: 10 }),
        errors: seen.filter(event => event.type === 'error'),
        logs: logs.filter(event => /continuation|pause|attention/i.test(JSON.stringify(event))).slice(-6),
        pending: [...backend.pendingToolApprovals.keys()] }));
      throw error;
    } finally { await backend.stop(); backend.dispose(); }
  });
}
