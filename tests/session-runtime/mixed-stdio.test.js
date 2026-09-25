'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { ROOT, waitFor, createBackend } = require('../helpers/session-runtime-stdio-fixture');
for (const [kind, publicationFailure] of [['user_questions', null], ['approval', null],
  ['user_questions', 'write'], ['user_questions', 'cancel']]) {
  test(`real Python child wait -> ${kind} -> reconstruction -> child wait (${publicationFailure || 'complete'})`, { timeout: 55_000 }, async t => {
    const root = fs.mkdtempSync(path.join(ROOT, 'artifacts', 'mixed-stdio-'));
    const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
    const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, 'fixture.txt'), 'Mixed approved read.');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const seen = []; const logs = [];
    const create = () => createBackend(profile, workspace, seen, logs, kind,
      [path.join(ROOT, 'tests/helpers/session-runtime-mixed-sidecar.py')]);
    let backend = create(); let workId; let sessionId;
    const pending = () => kind === 'approval' ? backend.pendingToolApprovals : backend.pendingUserQuestions;
    const answer = reference => kind === 'approval' ? backend.approveToolCall(reference)
      : backend.answerUserQuestions(reference, { answers: [{ id: 'choice', value: 'Continue' }] });
    try {
      await backend.start();
      sessionId = (await backend.createSession({ title: 'Mixed continuation' })).data.id;
      const projects = backend.projectApplicationService;
      const created = projects.createProject({ name: 'Mixed workspace' });
      assert.equal(created.ok, true);
      assert.equal(projects.bindProjectRoot({ project_id: created.project.id, root_path: workspace,
        expected_root_revision: created.project.root_revision }).ok, true);
      assert.equal(projects.assignSessionProject({ session_id: sessionId, project_id: created.project.id }).ok, true);
      const sent = await backend.runtimeApplicationService.start({ session_id: sessionId,
        prompt: kind === 'approval' ? 'MIXED_APPROVAL' : 'MIXED_QUESTION',
        purpose: 'Exercise bounded child and decision cycles', idempotency_key: 'mixed_cycle',
        limits: { inference_requests: 10, input_tokens: 1_000_000, output_tokens: 1_000_000 } });
      assert.equal(sent.ok, true, JSON.stringify(sent)); workId = sent.work_id;
      const [oldReference, oldWaiter] = await waitFor(() => {
        const work = backend.sessionRuntime.store.get(workId);
        if (['failed', 'completed', 'needs_attention'].includes(work.status)) throw new Error(JSON.stringify(work));
        return [...pending().entries()][0];
      });
      assert.equal(oldWaiter.requireExactRef, true);
      let work = backend.sessionRuntime.store.get(workId);
      assert.equal(backend.runtimeApplicationService.pause({ work_id: workId, expected_revision: work.revision }).ok, true);
      await waitFor(() => backend.sessionRuntime.store.get(workId).status === 'paused');
      work = backend.sessionRuntime.store.get(workId);
      const checkpoint = backend.sessionRuntime.checkpointStore.read(work.checkpoint_ref, work);
      assert.equal(checkpoint.kind, 'before_decision_wait');
      assert.deepEqual(checkpoint.completed_effect_refs.map(row => row.tool_id), ['session_spawn', 'session_wait']);
      assert.ok(checkpoint.prior_checkpoint_ref);
      const before = backend.sessionRuntime.budgetStore.get(sent.root_run_id);
      assert.equal(answer(oldReference), false);
      await backend.stop(); backend.dispose(); backend = create(); await backend.start();
      work = backend.sessionRuntime.store.get(workId);
      assert.equal(work.status, 'paused');
      assert.deepEqual(backend.sessionRuntime.budgetStore.get(sent.root_run_id).charged, before.charged);
      assert.equal(backend.runtimeApplicationService.resume({ work_id: workId, expected_revision: work.revision }).ok, true);
      const [reference] = await waitFor(() => [...pending().entries()][0]);
      assert.notEqual(reference, oldReference); assert.equal(answer(oldReference), false);
      if (publicationFailure) {
        const begin = backend.sessionRuntime.checkpointStore.begin.bind(backend.sessionRuntime.checkpointStore);
        backend.sessionRuntime.checkpointStore.begin = (body, ...args) => {
          const decoded = Buffer.isBuffer(body) ? JSON.parse(body.toString('utf8')) : body;
          if ((decoded.base_schema_version || decoded.schema_version) !== 5) return begin(body, ...args);
          if (publicationFailure === 'cancel') {
            const current = backend.sessionRuntime.store.get(workId);
            assert.equal(backend.runtimeApplicationService.cancel({ work_id: workId,
              expected_revision: current.revision }).ok, true);
          }
          throw new Error('fixture_mixed_publication_failed');
        };
      }
      assert.equal(answer(reference), true);
      if (publicationFailure) {
        await waitFor(() => !['running', 'pending'].includes(backend.sessionRuntime.store.get(workId).status));
        assert.notEqual(backend.sessionRuntime.store.get(workId).status, 'completed');
        const results = backend.sessionStore.getSession(sessionId).turn_events.filter(row => row.kind === 'tool_result');
        assert.deepEqual(results.map(row => row.payload.tool_name), ['session_spawn', 'session_wait', 'ask_user', 'session_spawn']);
        assert.equal(pending().size, 0);
        assert.equal(answer(reference), false);
        return;
      }

      await waitFor(() => {
        const current = backend.sessionRuntime.store.get(workId);
        if (['failed', 'needs_attention'].includes(current.status)) throw new Error(JSON.stringify(current));
        return current.status === 'completed';
      });
      const results = backend.sessionStore.getSession(sessionId).turn_events.filter(row => row.kind === 'tool_result');
      assert.deepEqual(results.map(row => row.payload.tool_name), ['session_spawn', 'session_wait',
        kind === 'approval' ? 'read_file' : 'ask_user', 'session_spawn', 'session_wait']);
      assert.equal(new Set(results.map(row => row.tool_call_id)).size, 5);
      assert.equal(results.every(row => row.payload.success), true);
      assert.equal(backend.sessionRuntime.lineageStore.get(sent.root_run_id).children.length, 2);
      const finalWork = backend.sessionRuntime.store.get(workId);
      const finalCheckpoint = backend.sessionRuntime.checkpointStore.readHistorical(finalWork.checkpoint_ref,
        { ...finalWork, attempt: finalWork.checkpoint_ref.source_attempt });
      assert.equal(finalCheckpoint.schema_version, 7);
      assert.equal(finalCheckpoint.base_schema_version, 5);
      assert.equal(finalCheckpoint.quota_state.enabled, true);
      assert.equal(finalCheckpoint.quota_state.admissions.length, 5);
      assert.deepEqual(finalCheckpoint.quota_state.admissions.slice(0, 3), checkpoint.quota_state.admissions);
      assert.equal(finalCheckpoint.quota_state.session_baseline, checkpoint.quota_state.session_baseline);
      assert.equal(finalCheckpoint.completed_effect_refs.length, 4);
      assert.equal(finalCheckpoint.position.tool_calls_consumed, 5);
      const budget = backend.sessionRuntime.budgetStore.get(sent.root_run_id);
      assert.deepEqual(budget.limits, before.limits);
      assert.equal(budget.charged.inference_requests, 8);
    } catch (error) {
      t.diagnostic(JSON.stringify({ works: backend.sessionRuntime.store.listSummaries({ limit: 10 }),
        results: sessionId ? backend.sessionStore.getSession(sessionId).turn_events.filter(row => row.kind === 'tool_result') : [],
        errors: seen.filter(row => row.type === 'error'), logs: logs.slice(-12) }));
      throw error;
    } finally { await backend.stop(); backend.dispose(); }
  });
}
