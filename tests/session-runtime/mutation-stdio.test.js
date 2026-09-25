'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { ROOT, createBackend, waitFor } = require('../helpers/session-runtime-stdio-fixture');
function pending(backend, kind) { return kind === 'approval' ? backend.pendingToolApprovals : backend.pendingUserQuestions; }
async function pause(backend, workId, kind) {
  const [key] = await waitFor(() => [...pending(backend, kind).entries()][0]);
  const work = backend.sessionRuntime.store.get(workId);
  assert.equal(backend.runtimeApplicationService.pause({ work_id: workId, expected_revision: work.revision }).ok, true);
  await waitFor(() => backend.sessionRuntime.store.get(workId).status !== 'running');
  const saved = backend.sessionRuntime.store.get(workId);
  assert.equal(saved.status, 'paused', JSON.stringify(saved));
  assert.equal(pending(backend, kind).size, 0);
  const checkpoint = backend.sessionRuntime.checkpointStore.read(saved.checkpoint_ref, saved);
  assert.equal(checkpoint.schema_version, 7);
  assert.equal(checkpoint.base_schema_version, 6);
  assert.ok(checkpoint.mutation_ref);
  return { key, saved, checkpoint };
}
for (const [kind, action] of [['user_questions', 'resume'], ['approval', 'resume'],
  ['user_questions', 'cancel'], ['approval', 'recover_cancel'], ['user_questions', 'publish_fail'], ['approval', 'resume_bundle'], ['user_questions', 'append_write']]) test(`actual typed mutation ${kind} pause and reconstruction: ${action}`, { timeout: 65000 }, async t => {
  const root = fs.mkdtempSync(path.join(ROOT, 'artifacts', 'mutation-stdio-'));
  const profile = path.join(root, 'profile'); const workspace = path.join(root, 'workspace');
  fs.mkdirSync(profile); fs.mkdirSync(workspace);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'replay.json');
  const target = path.join(workspace, 'created.txt');
  const decision = kind === 'approval'
    ? { tool_id: 'read_file', arguments: { path: 'created.txt' } }
    : { tool_id: 'ask_user', arguments: { questions: [{ id: 'choice', prompt: 'Finish?' }] } };
  fs.writeFileSync(script, JSON.stringify({ version: 1, calls: [
    { tool_calls: [{ tool_id: 'write_file', arguments: { path: 'created.txt', content: 'Preserved mutation.' } }] },
    { tool_calls: action === 'resume_bundle' ? [decision, { tool_id: 'list_dir', arguments: { path: '.' } }] : [decision] },
    ...(action === 'append_write' ? [
      { tool_calls: [{ tool_id: 'write_file', arguments: { path: 'later.txt', content: 'Later mutation.' } }] },
      { tool_calls: [{ tool_id: 'ask_user', arguments: { questions: [{ id: 'later', prompt: 'Finish later write?' }] } }] },
    ] : []),
    ...(action === 'resume_bundle' ? [{ text: 'Unused per-result replay slot.' }] : []),
    { text: 'Completed after preserved mutation.' },
  ] }));
  const previous = process.env.JENNY_REPLAY_SCRIPT; process.env.JENNY_REPLAY_SCRIPT = script;
  t.after(() => { if (previous === undefined) delete process.env.JENNY_REPLAY_SCRIPT; else process.env.JENNY_REPLAY_SCRIPT = previous; });
  const seen = []; const logs = [];
  const make = () => {
    const backend = createBackend(profile, workspace, seen, logs, kind);
    return backend;
  };
  let backend = make();
  try {
    await backend.start();
    const sessionId = (await backend.createSession({ title: 'Mutation checkpoint' })).data.id;
    const projects = backend.projectApplicationService;
    const created = projects.createProject({ name: 'Mutation workspace' });
    assert.equal(created.ok, true);
    assert.equal(projects.bindProjectRoot({ project_id: created.project.id, root_path: workspace,
      expected_root_revision: created.project.root_revision }).ok, true);
    assert.equal(projects.assignSessionProject({ session_id: sessionId, project_id: created.project.id }).ok, true);
    const sent = await backend.runtimeApplicationService.start({ session_id: sessionId,
      prompt: 'Write the fixture, then ask before finishing.', idempotency_key: 'mutation_fixture',
      purpose: 'Mutation recovery', limits: { inference_requests: action === 'append_write' ? 5 : 4, input_tokens: 1000000, output_tokens: 1000000 } });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    const [initialWrite] = await waitFor(() => [...backend.pendingToolApprovals.entries()][0]);
    assert.equal(backend.approveToolCall(initialWrite), true);
    if (action === 'publish_fail') {
      await waitFor(() => [...pending(backend, kind).entries()][0]);
      backend.sessionRuntime.checkpointStore.begin = () => { throw new Error('Injected checkpoint write failure'); };
      const current = backend.sessionRuntime.store.get(sent.work_id);
      assert.equal(backend.runtimeApplicationService.pause({ work_id: sent.work_id, expected_revision: current.revision }).ok, true);
      await waitFor(() => backend.sessionRuntime.store.get(sent.work_id).status !== 'running');
      assert.ok(['failed', 'needs_attention'].includes(backend.sessionRuntime.store.get(sent.work_id).status));
      assert.equal(backend.pendingUserQuestions.size, 0);
      assert.deepEqual(backend.sessionStore.getSession(sessionId).turn_events.filter(row => row.kind === 'tool_result')
        .map(row => row.payload.tool_name), ['write_file']);
      const recovery = path.join(profile, 'workspace-recovery');
      const files = fs.readdirSync(recovery, { recursive: true }).filter(file => file.endsWith('journal.json'));
      assert.equal(files.length, 1);
      const record = JSON.parse(fs.readFileSync(path.join(recovery, files[0])));
      assert.equal(record.state, 'interrupted');
      assert.equal(record.retention.protected, true);
      assert.ok(record.extensions.runtime_checkpoint);
      assert.equal(record.operation_count, 1);
      assert.equal(fs.readFileSync(target, 'utf8'), 'Preserved mutation.');
      return;
    }
    const first = await pause(backend, sent.work_id, kind);
    assert.equal(fs.readFileSync(target, 'utf8'), 'Preserved mutation.');
    const modified = fs.statSync(target).mtimeMs;
    const journal = path.join(profile, 'workspace-recovery', 'v1', first.checkpoint.mutation_ref.workspace_id,
      first.checkpoint.mutation_ref.change_set_id, 'journal.json');
    assert.equal(JSON.parse(fs.readFileSync(journal)).state, 'in_progress');
    if (action === 'recover_cancel') {
      // Crash boundary: durable cancellation intent exists before owner release.
      backend.sessionRuntime.store.requestCancellation(sent.work_id, {
        expectedRevision: first.saved.revision, expectedAttempt: first.saved.attempt, reason: 'user' });
    }
    await backend.stop(); backend.dispose(); backend = make(); await backend.start();
    if (['cancel', 'recover_cancel'].includes(action)) {
      if (action === 'cancel') {
        const current = backend.sessionRuntime.store.get(sent.work_id);
        const cancelled = backend.runtimeApplicationService.cancel({ work_id: sent.work_id, expected_revision: current.revision });
        assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
      }
      await waitFor(() => backend.sessionRuntime.store.get(sent.work_id).status === 'cancelled');
      const released = JSON.parse(fs.readFileSync(journal));
      assert.equal(released.state, 'interrupted');
      assert.equal(released.termination_reason, 'turn_cancelled');
      assert.equal(released.operation_count, 1);
      assert.equal(released.retention.protected, true);
      assert.equal(fs.statSync(target).mtimeMs, modified);
      assert.equal(backend.sessionRuntime.scheduler.cancellationFences.size, 0);
      return;
    }
    assert.equal(backend.sessionRuntime.store.get(sent.work_id).status, 'paused');
    const resume = () => {
      const work = backend.sessionRuntime.store.get(sent.work_id);
      const response = backend.runtimeApplicationService.resume({ work_id: sent.work_id, expected_revision: work.revision });
      assert.equal(response.ok, true, JSON.stringify(response));
    };
    resume();
    const second = await pause(backend, sent.work_id, kind);
    assert.deepEqual(second.checkpoint.mutation_ref, first.checkpoint.mutation_ref);
    assert.notEqual(second.checkpoint.decision.decision_id, first.checkpoint.decision.decision_id);
    resume();
    const [fresh] = await waitFor(() => [...pending(backend, kind).entries()][0]);
    assert.notEqual(fresh, second.key);
    assert.equal(kind === 'approval' ? backend.approveToolCall(fresh)
      : backend.answerUserQuestions(fresh, { answers: [{ id: 'choice', value: 'yes' }] }), true);
    if (action === 'append_write') {
      const [writeApproval] = await waitFor(() => [...backend.pendingToolApprovals.entries()][0]);
      assert.equal(backend.approveToolCall(writeApproval), true);
      const third = await pause(backend, sent.work_id, kind);
      assert.equal(third.checkpoint.mutation_ref.operation_count, 2);
      assert.equal(third.checkpoint.mutation_ref.change_set_id, first.checkpoint.mutation_ref.change_set_id);
      resume();
      const [finalQuestion] = await waitFor(() => [...backend.pendingUserQuestions.entries()][0]);
      assert.equal(backend.answerUserQuestions(finalQuestion, { answers: [{ id: 'later', value: 'yes' }] }), true);
    }
    await waitFor(() => backend.sessionRuntime.store.get(sent.work_id).status !== 'running');
    assert.equal(backend.sessionRuntime.store.get(sent.work_id).status, 'completed', JSON.stringify(logs.slice(-8)));
    const record = JSON.parse(fs.readFileSync(journal));
    assert.equal(record.state, 'committed');
    assert.equal(record.operation_count, action === 'append_write' ? 2 : 1);
    assert.equal(record.extensions.runtime_claimed_checkpoints.length, action === 'append_write' ? 3 : 2);
    assert.equal(record.extensions.runtime_checkpoint, undefined);
    assert.equal(fs.statSync(target).mtimeMs, modified, 'completed mutation was not replayed');
    const results = backend.sessionStore.getSession(sessionId).turn_events.filter(row => row.kind === 'tool_result');
    assert.deepEqual(results.map(row => row.payload.tool_name), ['write_file',
      ...(action === 'resume_bundle' ? ['list_dir'] : []), decision.tool_id,
      ...(action === 'append_write' ? ['write_file', 'ask_user'] : [])]);
    if (action === 'resume_bundle') assert.equal(results.find(row => row.payload.tool_name === 'list_dir').payload.success, false);
  } catch (error) {
    fs.writeFileSync(path.join(ROOT, 'artifacts', `mutation-pilot-${kind}.json`), JSON.stringify({
      error: error.message, logs, seen, work: backend.sessionRuntime?.store?._listRecords?.(),
      journalFiles: fs.existsSync(path.join(profile, 'workspace-recovery'))
        ? fs.readdirSync(path.join(profile, 'workspace-recovery'), { recursive: true }).filter(name => name.endsWith('journal.json'))
          .map(name => JSON.parse(fs.readFileSync(path.join(profile, 'workspace-recovery', name)))) : [],
    }));
    throw error;
  } finally { await backend.stop(); backend.dispose(); }
});
