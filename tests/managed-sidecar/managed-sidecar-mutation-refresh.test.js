'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { API_VERSION } = require('../../services/backend/sidecar-client');
const { ROOT, createBackend, waitFor } = require('../helpers/session-runtime-stdio-fixture');

for (const scenario of ['refresh', 'shell_timeout']) test(`real managed stdio ${scenario} preserves editing, next-turn journals, and Undo`, { timeout: 65000 }, async t => {
  fs.mkdirSync(path.join(ROOT, 'artifacts'), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, 'artifacts', 'mutation-refresh-'));
  const profile = path.join(root, 'profile'); const workspace = path.join(root, 'workspace');
  fs.mkdirSync(profile); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'effect.txt'), 'original');
  const script = path.join(root, 'replay.json');
  const sleeper = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  fs.writeFileSync(script, JSON.stringify({ version: 1, calls: [
    { tool_calls: [{ tool_id: 'edit_file', arguments: { file_path: 'effect.txt', old_string: 'original', new_string: 'first' } }] },
    ...(scenario === 'refresh' ? [{ tool_calls: [{ tool_id: 'ask_user', arguments: { questions: [{ id: 'go', prompt: 'Continue?' }] } }] }] : [
      { tool_calls: [{ tool_id: 'run_command', arguments: { command: `"${sleeper}" -c "import time; time.sleep(10)"`, timeout_seconds: 0.2 } }] },
      { tool_calls: [{ tool_id: 'read_file', arguments: { path: 'effect.txt' } }] },
    ]),
    ...(scenario === 'shell_timeout' ? [{ text: 'Unused recovery-message replay slot.' }] : []),
    { tool_calls: [{ tool_id: 'edit_file', arguments: { file_path: 'effect.txt', old_string: 'first', new_string: 'second' } }] },
    { text: 'Finished.' },
    { tool_calls: [{ tool_id: 'edit_file', arguments: { file_path: 'effect.txt', old_string: 'second', new_string: 'third' } }] },
    { text: 'Next turn finished.' },
  ] }));
  const previous = process.env.JENNY_REPLAY_SCRIPT; process.env.JENNY_REPLAY_SCRIPT = script;
  t.after(() => { if (previous === undefined) delete process.env.JENNY_REPLAY_SCRIPT; else process.env.JENNY_REPLAY_SCRIPT = previous; });
  const seen = []; const logs = [];
  const backend = createBackend(profile, workspace, seen, logs, 'user_questions');
  try {
    await backend.start();
    const session = (await backend.createSession({ title: 'Refresh journal' })).data.id;
    const project = backend.ensureWorkspaceProject(workspace, 'test_fixture').project;
    assert.equal(backend.projectApplicationService.assignSessionProject({ session_id: session, project_id: project.id }).ok, true);
    const start = await backend.runtimeApplicationService.start({ session_id: session, prompt: 'Edit then ask then edit.',
      idempotency_key: 'refresh', purpose: 'Refresh journal', limits: { inference_requests: 5, input_tokens: 1000000, output_tokens: 1000000 } });
    assert.equal(start.ok, true, JSON.stringify(start));
    const [firstApproval] = await waitFor(() => [...backend.pendingToolApprovals.entries()][0]);
    assert.equal(backend.approveToolCall(firstApproval), true);
    let journal; let before; let afterRefresh;
    if (scenario === 'refresh') {
      const [question] = await waitFor(() => [...backend.pendingUserQuestions.entries()][0]);
      assert.equal(fs.readFileSync(path.join(workspace, 'effect.txt'), 'utf8'), 'first');
      const recovery = path.join(profile, 'workspace-recovery');
      journal = path.join(recovery, fs.readdirSync(recovery, { recursive: true }).find(name => name.endsWith('journal.json')));
      before = JSON.parse(fs.readFileSync(journal));
      assert.equal(before.extensions.runtime_checkpoint, undefined, 'fixture is a live turn, not a published pause');
      await backend.refreshManagedConfig('feature_settings_updated');
      afterRefresh = JSON.parse(fs.readFileSync(journal));
      assert.equal(backend.answerUserQuestions(question, { answers: [{ id: 'go', value: 'yes' }] }), true);
    } else {
      const [commandApproval] = await waitFor(() => [...backend.pendingToolApprovals.entries()][0]);
      assert.equal(backend.approveToolCall(commandApproval), true);
    }
    const [secondApproval] = await waitFor(() => [...backend.pendingToolApprovals.entries()][0]);
    assert.equal(backend.approveToolCall(secondApproval), true);
    await waitFor(() => backend.sessionRuntime.store.get(start.work_id).status !== 'running');
    const recovery = path.join(profile, 'workspace-recovery');
    journal ??= path.join(recovery, fs.readdirSync(recovery, { recursive: true }).find(name => name.endsWith('journal.json')));
    const record = JSON.parse(fs.readFileSync(journal));
    const results = backend.sessionStore.getSession(session).turn_events.filter(row => row.kind === 'tool_result');
    fs.writeFileSync(path.join(ROOT, 'artifacts', `mutation-${scenario}-evidence.json`), JSON.stringify({ before, afterRefresh, record, results, seen, logs }, null, 2));
    assert.equal(results.filter(row => row.payload.tool_name === 'edit_file').at(-1).payload.success, true, JSON.stringify({ afterRefresh, results }));
    if (scenario === 'refresh') assert.equal(afterRefresh.state, 'in_progress');
    else {
      const command = results.find(row => row.payload.tool_name === 'run_command').payload;
      assert.equal(command.success, false);
      assert.equal(command.metadata.failure_class, 'limit_exceeded', JSON.stringify(command));
      assert.equal(command.metadata.resource_cleanup.cleanup, 'confirmed', JSON.stringify(command));
      assert.equal(command.metadata.resource_cleanup.process_tree_terminated, true);
      assert.equal(results.find(row => row.payload.tool_name === 'read_file').payload.success, true);
    }
    assert.equal(record.state, 'committed');
    assert.equal(record.operation_count, 2);
    assert.equal(fs.readFileSync(path.join(workspace, 'effect.txt'), 'utf8'), 'second');
    if (scenario === 'shell_timeout') {
      const undone = await backend.sidecarClient.request('workspace.undo_change_set', { accept_version: API_VERSION, change_set_id: record.change_set_id });
      assert.equal(undone.status, 'committed');
      assert.equal(fs.readFileSync(path.join(workspace, 'effect.txt'), 'utf8'), 'original');
      return;
    }
    const next = await backend.runtimeApplicationService.start({ session_id: session, prompt: 'Edit in a new turn.',
      idempotency_key: 'next_turn', purpose: 'Next-turn editing', limits: { inference_requests: 2, input_tokens: 1000000, output_tokens: 1000000 } });
    assert.equal(next.ok, true, JSON.stringify(next));
    const [nextApproval] = await waitFor(() => [...backend.pendingToolApprovals.entries()][0]);
    assert.equal(backend.approveToolCall(nextApproval), true);
    await waitFor(() => backend.sessionRuntime.store.get(next.work_id).status !== 'running');
    assert.equal(backend.sessionRuntime.store.get(next.work_id).status, 'completed');
    assert.equal(fs.readFileSync(path.join(workspace, 'effect.txt'), 'utf8'), 'third');
    const records = fs.readdirSync(recovery, { recursive: true }).filter(name => name.endsWith('journal.json'))
      .map(name => JSON.parse(fs.readFileSync(path.join(recovery, name))));
    const nextRecord = records.find(row => row.change_set_id !== record.change_set_id);
    assert.equal(records.length, 2);
    assert.equal(nextRecord.state, 'committed');
    assert.equal(nextRecord.operation_count, 1);
    for (const [changeSetId, expected] of [[nextRecord.change_set_id, 'second'], [record.change_set_id, 'original']]) {
      const preflight = await backend.sidecarClient.request('workspace.preflight_undo', { accept_version: API_VERSION, change_set_id: changeSetId });
      assert.deepEqual(preflight.conflicts, []);
      const undone = await backend.sidecarClient.request('workspace.undo_change_set', { accept_version: API_VERSION, change_set_id: changeSetId });
      assert.equal(undone.status, 'committed');
      assert.equal(fs.readFileSync(path.join(workspace, 'effect.txt'), 'utf8'), expected);
    }

  } catch (error) { fs.writeFileSync(path.join(ROOT, 'artifacts', 'mutation-refresh-error.json'), JSON.stringify({ error: error.message, seen, logs, work: backend.sessionRuntime?.store?._listRecords?.() }, null, 2)); throw error; } finally { await backend.stop(); backend.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});
