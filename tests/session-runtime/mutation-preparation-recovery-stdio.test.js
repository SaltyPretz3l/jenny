"use strict";
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { fork } = require('node:child_process');
const { ROOT, createBackend, waitFor } = require('../helpers/session-runtime-stdio-fixture');

for (const crashPoint of ['bind', 'confirm']) test(`process death at ${crashPoint} recovers its exact project journal`, { timeout: 50000 }, async t => {
  const root = fs.mkdtempSync(path.join(ROOT, 'artifacts', 'mutation-prepare-crash-'));
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
  let backend = createBackend(profile, legacy, seen, logs, 'user_questions', crash);
  try {
    await backend.start();
    const session = (await backend.createSession({ title: 'Preparation crash' })).data.id;
    const projects = backend.projectApplicationService;
    const project = projects.createProject({ name: 'Recovery root' }).project;
    assert.equal(projects.bindProjectRoot({ project_id: project.id, root_path: workspace,
      expected_root_revision: project.root_revision }).ok, true);
    assert.equal(projects.assignSessionProject({ session_id: session, project_id: project.id }).ok, true);
    const start = await backend.runtimeApplicationService.start({ session_id: session, prompt: 'Write then ask.',
      idempotency_key: 'preparation_crash', purpose: 'Crash recovery',
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
    assert.equal(prepared.state, 'in_progress', JSON.stringify({ prepared, work: backend.sessionRuntime.store.get(start.work_id), logs: logs.filter(row => /runtime|checkpoint|failed/.test(row.event)) }));
    assert.equal(prepared.extensions.runtime_checkpoint_phase, 'preparing');
    if (crashPoint === 'bind') assert.equal(backend.sessionRuntime.store.get(start.work_id).checkpoint_ref, null);
    await backend.stop(); backend.dispose();
    backend = createBackend(profile, legacy, seen, logs, 'user_questions'); await backend.start();
    if (crashPoint === 'confirm') {
      // Graceful host stop after a sidecar-only crash preserves cancellation intent.
      await waitFor(() => backend.sessionRuntime.store.get(start.work_id).status === 'cancelled');
      const cancelled = JSON.parse(fs.readFileSync(journal));
      assert.equal(cancelled.state, 'interrupted');
      assert.equal(cancelled.termination_reason, 'turn_cancelled');
      assert.equal(cancelled.operation_count, 1);
      assert.equal(cancelled.retention.protected, true);
      assert.deepEqual(cancelled.extensions.runtime_checkpoint, prepared.extensions.runtime_checkpoint);
      assert.equal(fs.readFileSync(path.join(workspace, 'effect.txt'), 'utf8'), 'Saved before crash.');
      return;
    }
    const recovered = JSON.parse(fs.readFileSync(journal));
    assert.equal(recovered.state, 'interrupted', JSON.stringify({ work: backend.sessionRuntime.store.get(start.work_id), logs: logs.filter(row => /runtime|checkpoint|failed/.test(row.event)) }));
    assert.equal(recovered.retention.protected, true);
    assert.deepEqual(recovered.extensions.runtime_checkpoint, prepared.extensions.runtime_checkpoint);
    assert.equal(recovered.operation_count, 1);
    assert.equal(fs.readFileSync(path.join(workspace, 'effect.txt'), 'utf8'), 'Saved before crash.');
    assert.notEqual(backend.sessionRuntime.store.get(start.work_id).status, 'completed');
  } finally { await backend.stop(); backend.dispose(); }
});

test('whole application death after publication confirms the exact pin before explicit resume', { timeout: 50000 }, async t => {
  const root = fs.mkdtempSync(path.join(ROOT, 'artifacts', 'mutation-published-crash-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['profile', 'project']) fs.mkdirSync(path.join(root, name));
  const script = path.join(root, 'replay.json');
  fs.writeFileSync(script, JSON.stringify({ version: 1, calls: [
    { tool_calls: [{ tool_id: 'write_file', arguments: { path: 'effect.txt', content: 'Saved before crash.' } }] },
    { tool_calls: [{ tool_id: 'ask_user', arguments: { questions: [{ id: 'choice', prompt: 'Finish?' }] } }] },
    { text: 'Finished after recovery.' },
  ] }));
  const child = fork(path.join(ROOT, 'tests/helpers/session-runtime-mutation-crash-child.js'), [root], {
    env: { ...process.env, JENNY_REPLAY_SCRIPT: script }, silent: true, windowsHide: true });
  let output = ''; child.stderr.on('data', data => { output += data; });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(exit, 86, output);
  const { session, work_id } = JSON.parse(fs.readFileSync(path.join(root, 'identity.json')));
  const profile = path.join(root, 'profile'); const workspace = path.join(root, 'project');
  const recovery = path.join(profile, 'workspace-recovery');
  const files = fs.readdirSync(recovery, { recursive: true }).filter(file => file.endsWith('journal.json'));
  assert.equal(files.length, 1);
  const journal = path.join(recovery, files[0]);
  const prepared = JSON.parse(fs.readFileSync(journal));
  assert.equal(prepared.state, 'in_progress'); assert.equal(prepared.extensions.runtime_checkpoint_phase, 'preparing');
  const modified = fs.statSync(path.join(workspace, 'effect.txt')).mtimeMs;
  const previous = process.env.JENNY_REPLAY_SCRIPT; process.env.JENNY_REPLAY_SCRIPT = script;
  t.after(() => { if (previous === undefined) delete process.env.JENNY_REPLAY_SCRIPT; else process.env.JENNY_REPLAY_SCRIPT = previous; });
  const logs = []; const backend = createBackend(profile, workspace, [], logs, 'user_questions');
  try {
    await backend.start();
    const current = backend.sessionRuntime.store.get(work_id);
    const recovered = JSON.parse(fs.readFileSync(journal));
    assert.equal(recovered.extensions.runtime_checkpoint_phase, 'confirmed', JSON.stringify({ current, logs: logs.filter(row => row.event.includes('runtime')) }));
    assert.deepEqual(recovered.extensions.runtime_checkpoint, prepared.extensions.runtime_checkpoint);
    assert.equal(current.status, 'paused');
    const resumed = backend.runtimeApplicationService.resume({ work_id, expected_revision: current.revision });
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    const [question] = await waitFor(() => [...backend.pendingUserQuestions.entries()][0]);
    assert.equal(backend.answerUserQuestions(question, { answers: [{ id: 'choice', value: 'yes' }] }), true);
    await waitFor(() => backend.sessionRuntime.store.get(work_id).status !== 'running');
    assert.equal(backend.sessionRuntime.store.get(work_id).status, 'completed', JSON.stringify(logs.slice(-5)));
    assert.equal(JSON.parse(fs.readFileSync(journal)).operation_count, 1);
    assert.equal(fs.statSync(path.join(workspace, 'effect.txt')).mtimeMs, modified);
    assert.deepEqual(backend.sessionStore.getSession(session).turn_events.filter(event => event.kind === 'tool_result').map(event => event.payload.tool_name), ['write_file', 'ask_user']);
  } finally { await backend.stop(); backend.dispose(); }
});
