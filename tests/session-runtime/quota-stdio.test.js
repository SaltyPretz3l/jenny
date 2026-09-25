'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { ROOT, waitFor, createBackend } = require('../helpers/session-runtime-stdio-fixture');
for (const kind of ['approval', 'user_questions']) for (const mixed of [false, true]) test(`real offline web quotas survive ${kind}, restart, repeated pause and later cap (mixed=${mixed})`, { timeout: 55000 }, async t => {
  const root = fs.mkdtempSync(path.join(ROOT, 'artifacts', 'quota-stdio-'));
  const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'fixture.txt'), 'Quota read result.');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const seen = []; const logs = [];
  const create = () => createBackend(profile, workspace, seen, logs, kind,
    [path.join(ROOT, 'tests/helpers/session-runtime-quota-sidecar.py'), ...(mixed ? ['--quota-mixed'] : [])]);
  let backend = create(); let workId;
  const pending = decision => decision === 'approval' ? backend.pendingToolApprovals : backend.pendingUserQuestions;
  const answer = (decision, reference) => decision === 'approval' ? backend.approveToolCall(reference)
    : backend.answerUserQuestions(reference, { answers: [{ id: 'choice', value: 'Continue' }] });
  const checkpointAt = async decision => {
    const [reference, waiter] = await waitFor(() => {
      const work = backend.sessionRuntime.store.get(workId);
      if (['failed', 'completed', 'needs_attention'].includes(work.status)) throw new Error(JSON.stringify(work));
      return [...pending(decision).entries()][0];
    });
    assert.equal(waiter.requireExactRef, true);
    const work = backend.sessionRuntime.store.get(workId);
    assert.equal(backend.runtimeApplicationService.pause({ work_id: workId, expected_revision: work.revision }).ok, true);
    await waitFor(() => backend.sessionRuntime.store.get(workId).status !== 'running');
    const paused = backend.sessionRuntime.store.get(workId);
    assert.equal(paused.status, 'paused', JSON.stringify(paused));
    assert.equal(answer(decision, reference), false);
    return backend.sessionRuntime.checkpointStore.read(paused.checkpoint_ref, paused);
  };
  const resume = () => {
    const work = backend.sessionRuntime.store.get(workId);
    assert.equal(backend.runtimeApplicationService.resume({ work_id: workId, expected_revision: work.revision }).ok, true);
  };
  try {
    await backend.start();
    const sessionId = (await backend.createSession({ title: 'Quota continuation' })).data.id;
    const projects = backend.projectApplicationService;
    const project = projects.createProject({ name: 'Quota workspace' }).project;
    assert.equal(projects.bindProjectRoot({ project_id: project.id, root_path: workspace, expected_root_revision: project.root_revision }).ok, true);
    assert.equal(projects.assignSessionProject({ session_id: sessionId, project_id: project.id }).ok, true);
    const request = { session_id: sessionId,
      prompt: kind === 'approval' ? 'QUOTA_APPROVAL' : 'QUOTA_QUESTION', idempotency_key: 'quota_fixture' };
    const sent = mixed ? await backend.runtimeApplicationService.start({ ...request,
      purpose: 'Offline quota and child continuation',
      limits: { inference_requests: 15, input_tokens: 1000000, output_tokens: 1000000 } })
      : await backend.runtimeApplicationService.submit(request);
    assert.equal(sent.ok, true); workId = sent.work_id;
    const first = await checkpointAt(kind);
    assert.equal(first.schema_version, 7);
    assert.deepEqual(first.quota_state.policy, { web_per_turn: 2, code_per_turn: 16, session_calls: mixed ? 7 : 5, cooldown_ms: 30000 });
    assert.equal(first.quota_state.admissions.length, mixed ? 5 : 3);
    assert.equal(first.quota_state.admissions.filter(row => row.web_refunded).length, 1);
    assert.equal(first.completed_effect_refs.length, mixed ? 5 : 3);
    await backend.stop(); backend.dispose(); backend = create(); await backend.start();
    resume();
    const repeated = await checkpointAt(kind);
    assert.deepEqual(repeated.quota_state.admissions, first.quota_state.admissions);
    assert.equal(repeated.quota_state.session_baseline, first.quota_state.session_baseline);
    resume();
    const [reference] = await waitFor(() => [...pending(kind).entries()][0]);
    assert.equal(answer(kind, reference), true);
    const later = await checkpointAt('user_questions');
    assert.equal(later.quota_state.admissions.length, mixed ? 7 : 5, 'pending question is already charged at the session cap');
    assert.deepEqual(later.quota_state.admissions.slice(0, first.quota_state.admissions.length), first.quota_state.admissions);
    assert.equal(later.quota_state.admissions.filter(row => row.web_refunded).length, 1);
    assert.equal(later.quota_state.cooldowns.entries.find(row => row.name === 'web_search')?.reason, 'web_per_turn');
    await backend.stop(); backend.dispose(); backend = create(); await backend.start();
    resume();
    const [last] = await waitFor(() => [...pending('user_questions').entries()][0]);
    assert.equal(answer('user_questions', last), true);
    await waitFor(() => backend.sessionRuntime.store.get(workId).status === 'completed');
    const results = backend.sessionStore.getSession(sessionId).turn_events.filter(row => row.kind === 'tool_result');
    assert.equal(results.length, mixed ? 10 : 8);
    const web = results.filter(row => row.payload.tool_name === 'web_search');
    assert.equal(web.length, 5);
    assert.deepEqual(web.filter(row => row.payload.success).map(row => row.payload.tool_output_summary), ['Offline web success', 'Offline web after']);
    assert.equal(web.filter(row => row.payload.metadata?.quota_scope === 'web_per_turn').length, 2);
    assert.equal(results.at(-1).payload.metadata.quota_scope, 'session_tool_budget');
    assert.equal(pending('approval').size + pending('user_questions').size, 0);
  } catch (error) {
    t.diagnostic(JSON.stringify({ work: workId ? backend.sessionRuntime.store.get(workId) : null,
      errors: seen.filter(row => row.type === 'error'), logs: logs.slice(-6) })); throw error;
  } finally { await backend.stop(); backend.dispose(); }
});
