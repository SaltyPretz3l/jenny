"use strict";
// A call the person approved and that then finds its resource busy parks and
// runs after the wait, without a second card. Real backend and real Python.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { ROOT, waitFor, createBackend, holdAtAdmission, stopReleasingHolds } = require('../helpers/session-runtime-stdio-fixture');

const SETTLED = ['paused', 'completed', 'failed', 'needs_attention'];
const cards = seen => seen.filter(event => event.type === 'tool_approval_needed');

for (const [priorEffect, restart] of [[false, false], [true, false], [false, true]]) {
  test(`approved call parks on a busy resource (priorEffect=${priorEffect}, restart=${restart})`, { timeout: 60_000 }, async t => {
    const artifacts = path.join(ROOT, 'artifacts'); fs.mkdirSync(artifacts, { recursive: true });
    const root = fs.mkdtempSync(path.join(artifacts, 'approved-park-'));
    const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
    const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, 'blocked.txt'), 'blocked.txt body');
    const blocked = { tool_calls: [{ tool_id: 'read_file', arguments: { path: 'blocked.txt' } }] };
    const script = path.join(root, 'replay.json');
    fs.writeFileSync(script, JSON.stringify({ version: 1, calls: [
      ...(priorEffect ? [{ tool_calls: [{ tool_id: 'list_dir', arguments: { path: '.' } }] }] : []),
      blocked, { text: 'Finished after the wait.' },
    ] }));
    const prior = process.env.JENNY_REPLAY_SCRIPT; process.env.JENNY_REPLAY_SCRIPT = script;
    t.after(() => {
      if (prior === undefined) delete process.env.JENNY_REPLAY_SCRIPT; else process.env.JENNY_REPLAY_SCRIPT = prior;
      fs.rmSync(root, { recursive: true, force: true });
    });
    const seen = []; const logs = [];
    let backend = createBackend(profile, workspace, seen, logs, 'approval');
    let held = null; let workId = null;
    const work = () => backend.sessionRuntime.store.get(workId);
    const events = kind => backend.sessionStore.getSession(work().session_id).turn_events.filter(row => row.kind === kind);
    const approveNext = async alreadyAnswered => {
      const [reference] = await waitFor(() => {
        if (SETTLED.includes(work().status)) throw new Error(JSON.stringify({ status: work().status, results: events('tool_result').map(row => row.payload) }));
        return [...backend.pendingToolApprovals.entries()].find(([id]) => !alreadyAnswered.has(id));
      });
      alreadyAnswered.add(reference);
      assert.equal(backend.approveToolCall(reference), true);
    };
    try {
      await backend.start();
      const sessionId = (await backend.createSession({ title: 'Approved park' })).data.id;
      const project = backend.ensureWorkspaceProject(workspace, 'test_fixture').project;
      assert.equal(backend.projectApplicationService.assignSessionProject({ session_id: sessionId, project_id: project.id }).ok, true);
      held = holdAtAdmission(backend.sessionRuntime, workspace, priorEffect ? 2 : 1);
      const sent = await backend.runtimeApplicationService.submit({ session_id: sessionId,
        prompt: 'Read the blocked file.', idempotency_key: 'approved_park_fixture' });
      assert.equal(sent.ok, true, JSON.stringify(sent)); workId = sent.work_id;
      const answered = new Set();
      await approveNext(answered);
      await waitFor(() => SETTLED.includes(work().status));

      const paused = work();
      assert.equal(paused.status, 'paused', JSON.stringify({ paused, results: events('tool_result').map(row => row.payload) }));
      assert.equal(events('tool_result').filter(row => row.payload.tool_name === 'read_file').length, 0, 'the parked call must not have a failed result');
      assert.equal(cards(seen).length, 1);
      const checkpoint = backend.sessionRuntime.checkpointStore.read(paused.checkpoint_ref, paused);
      assert.equal(checkpoint.kind, 'before_tool_dispatch');
      assert.equal(checkpoint.wait.kind, 'resource');
      assert.equal(checkpoint.completed_effect_refs.length, priorEffect ? 1 : 0);
      // Consent never reaches a checkpoint or the disk.
      assert.equal(JSON.stringify(checkpoint).includes('approved'), false);

      if (restart) {
        await stopReleasingHolds(backend, held); held = null; backend.dispose();
        backend = createBackend(profile, workspace, seen, logs, 'approval'); await backend.start();
        const saved = work();
        assert.equal(backend.runtimeApplicationService.resume({ work_id: workId, expected_revision: saved.revision }).ok, true);
        // The approval lived only in memory, so the restarted app asks again.
        await approveNext(answered);
        await waitFor(() => cards(seen).length === 2);
      } else {
        assert.equal(held(), true); held = null;
      }
      await waitFor(() => ['completed', 'failed', 'needs_attention'].includes(work().status), 30_000);
      assert.equal(work().status, 'completed', JSON.stringify({ work: work(), results: events('tool_result').map(row => row.payload) }));
      assert.equal(cards(seen).length, restart ? 2 : 1, 'the approved call must not ask twice');
      const reads = events('tool_result').filter(row => row.payload.tool_name === 'read_file');
      assert.equal(reads.length, 1); assert.equal(reads[0].payload.success, true);
      assert.match(reads[0].payload.tool_output_summary, /blocked\.txt body/);
    } catch (error) {
      t.diagnostic(JSON.stringify({ work: workId ? work() : null, errors: seen.filter(row => row.type === 'error'),
        logs: logs.filter(row => /resource|continuation|stderr|error/i.test(JSON.stringify(row))).slice(-16) }));
      throw error;
    } finally { await stopReleasingHolds(backend, held); backend.dispose(); }
  });
}
