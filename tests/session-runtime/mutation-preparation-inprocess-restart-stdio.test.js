"use strict";
// In-process counterpart of mutation-preparation-recovery-stdio.test.js: the
// same backend object is stopped and started again (no dispose/create), so the
// start-time mutation-preparation recovery runs while the abandoned entry is
// still active. The reclaim in reopenBackendRuntimeAfterStart must then recover
// it the way a new process does, ending in the same persisted state.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { ROOT, createBackend, waitFor } = require('../helpers/session-runtime-stdio-fixture');

for (const crashPoint of ['bind', 'confirm']) test(`in-process restart after process death at ${crashPoint} recovers its exact project journal`, { timeout: 50000 }, async t => {
  const root = fs.mkdtempSync(path.join(ROOT, 'artifacts', 'mutation-prepare-inprocess-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profile = path.join(root, 'profile'); const workspace = path.join(root, 'project');
  const legacy = path.join(root, 'global-workspace');
  for (const directory of [profile, workspace, legacy]) fs.mkdirSync(directory);
  const script = path.join(root, 'replay.json');
  fs.writeFileSync(script, JSON.stringify({ version: 1, calls: [
    { tool_calls: [{ tool_id: 'write_file', arguments: { path: 'effect.txt', content: 'Saved before crash.' } }] },
    { tool_calls: [{ tool_id: 'ask_user', arguments: { questions: [{ id: 'choice', prompt: 'Finish?' }] } }] },
    { text: 'Finished after recovery.' },
  ] }));
  const previous = process.env.JENNY_REPLAY_SCRIPT; process.env.JENNY_REPLAY_SCRIPT = script;
  t.after(() => { if (previous === undefined) delete process.env.JENNY_REPLAY_SCRIPT; else process.env.JENNY_REPLAY_SCRIPT = previous; });
  const crash = ['-c', [
    'from sidecar.__main__ import main', 'import os',
    'from sidecar.runtime.mutation_continuation import FrozenMutationCheckpoint',
    'original=FrozenMutationCheckpoint.transition',
    'def transition(self,action,*args):',
    `    if action=="confirm" and "${crashPoint}"=="confirm": os._exit(86)`,
    '    result=original(self,action,*args)',
    `    if action=="bind" and "${crashPoint}"=="bind": os._exit(86)`,
    '    return result',
    'FrozenMutationCheckpoint.transition=transition', 'main()',
  ].join('\n')];
  const seen = []; const logs = [];
  const backend = createBackend(profile, legacy, seen, logs, 'user_questions', crash);
  const diagnostics = workId => JSON.stringify({ work: backend.sessionRuntime.store.get(workId),
    active: [...backend.sessionRuntime.scheduler.active.keys()],
    logs: logs.filter(row => !/web_search|provider_key/.test(row.event)).map(row => ({ event: row.event, details: row.details ?? row.data })) });
  try {
    await backend.start();
    const session = (await backend.createSession({ title: 'Preparation crash' })).data.id;
    const projects = backend.projectApplicationService;
    const project = backend.ensureWorkspaceProject(workspace, 'test_fixture').project;
    assert.equal(projects.assignSessionProject({ session_id: session, project_id: project.id }).ok, true);
    const start = await backend.runtimeApplicationService.start({ session_id: session, prompt: 'Write then ask.',
      idempotency_key: 'preparation_crash_inprocess', purpose: 'Crash recovery',
      limits: { inference_requests: 3, input_tokens: 1000000, output_tokens: 1000000 } });
    assert.equal(start.ok, true);
    const [approval] = await waitFor(() => [...backend.pendingToolApprovals.entries()][0]);
    assert.equal(backend.approveToolCall(approval), true);
    await waitFor(() => backend.pendingUserQuestions.size > 0);
    const work = backend.sessionRuntime.store.get(start.work_id);
    assert.equal(backend.runtimeApplicationService.pause({ work_id: start.work_id, expected_revision: work.revision }).ok, true);
    await waitFor(() => backend.sessionRuntime.store.get(start.work_id).status !== 'running');
    const recovery = path.join(profile, 'workspace-recovery');
    const files = fs.readdirSync(recovery, { recursive: true }).filter(file => file.endsWith('journal.json'));
    assert.equal(files.length, 1);
    const journal = path.join(recovery, files[0]);
    const prepared = JSON.parse(fs.readFileSync(journal));
    assert.equal(prepared.state, 'in_progress', diagnostics(start.work_id));
    assert.equal(prepared.extensions.runtime_checkpoint_phase, 'preparing');
    if (crashPoint === 'bind') assert.equal(backend.sessionRuntime.store.get(start.work_id).checkpoint_ref, null);
    // In-process restart: same backend object. The respawned sidecar runs the
    // stock entrypoint, as the new-process case's fresh backend does.
    await backend.stop();
    backend.sidecarManager.launchArgs = null;
    await backend.start();
    if (crashPoint === 'confirm') {
      // Recovery finishes before the runtime reopens, as a new process finishes
      // it before ready: once start returns, no resume can race the reconcile.
      const atStart = JSON.parse(fs.readFileSync(journal));
      const current = backend.sessionRuntime.store.get(start.work_id);
      assert.equal(current.status, 'cancelled', diagnostics(start.work_id));
      assert.equal(atStart.state, 'interrupted');
      assert.equal(backend.runtimeApplicationService.resume({ work_id: start.work_id,
        expected_revision: current.revision }).ok, false);
      const cancelled = JSON.parse(fs.readFileSync(journal));
      assert.equal(cancelled.state, 'interrupted', JSON.stringify({ journal: cancelled, diagnostics: JSON.parse(diagnostics(start.work_id)) }));
      assert.equal(cancelled.termination_reason, 'turn_cancelled');
      assert.equal(cancelled.operation_count, 1);
      assert.equal(cancelled.retention.protected, true);
      assert.deepEqual(cancelled.extensions.runtime_checkpoint, prepared.extensions.runtime_checkpoint);
      assert.equal(fs.readFileSync(path.join(workspace, 'effect.txt'), 'utf8'), 'Saved before crash.');
      const settled = backend.sessionRuntime.store.get(start.work_id);
      assert.ok(settled.checkpoint_ref, diagnostics(start.work_id));
      assert.equal(settled.control_request.kind, 'cancel');
      assert.deepEqual([settled.transition.from, settled.transition.reason], ['paused', 'service_stop']);
      const reclaim = logs.filter(row => row.event === 'session_runtime.abandoned_work_reclaimed').at(-1);
      assert.deepEqual([reclaim.details.reclaimed, reclaim.details.recovering, reclaim.details.actorLeasesDropped],
        [[], [start.work_id], [start.work_id]]);
      // A further in-process restart neither waits on nor refuses over this work.
      const mark = logs.length;
      await backend.stop(); await backend.start();
      assert.deepEqual(logs.slice(mark).filter(row => /shutdown_unconfirmed|abandoned_work_reclaimed/.test(row.event)), []);
      // The abandoned turn no longer holds the session: a new send starts.
      const next = await backend.runtimeApplicationService.start({ session_id: session, prompt: 'Again.',
        idempotency_key: 'after_inprocess_restart', purpose: 'Crash recovery',
        limits: { inference_requests: 3, input_tokens: 1000000, output_tokens: 1000000 } });
      assert.equal(next.ok, true, JSON.stringify(next));
      await waitFor(() => ['running', 'completed'].includes(backend.sessionRuntime.store.get(next.work_id).status))
        .catch(error => { throw new Error(`${error.message}: ${diagnostics(next.work_id)}`); });
      return;
    }
    const recovered = JSON.parse(fs.readFileSync(journal));
    assert.equal(recovered.state, 'interrupted', JSON.stringify({ journal: recovered, diagnostics: JSON.parse(diagnostics(start.work_id)) }));
    assert.equal(recovered.retention.protected, true);
    assert.deepEqual(recovered.extensions.runtime_checkpoint, prepared.extensions.runtime_checkpoint);
    assert.equal(recovered.operation_count, 1);
    assert.equal(fs.readFileSync(path.join(workspace, 'effect.txt'), 'utf8'), 'Saved before crash.');
    assert.equal(recovered.termination_reason, 'process_recovered');
    // The producer settled (failed) before the restart, as in a new process.
    assert.equal(backend.sessionRuntime.store.get(start.work_id).status, 'failed');
  } finally { await backend.stop(); backend.dispose(); }
});
