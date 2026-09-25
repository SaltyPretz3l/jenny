'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { ROOT, waitFor, createBackend } = require('../helpers/session-runtime-stdio-fixture');

test('real Python Plan recovers from an oversized read and releases the turn for followup', { timeout: 45000 }, async t => {
  const root = fs.mkdtempSync(path.join(ROOT, 'artifacts', 'read-error-smoke-'));
  const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'large.md'), 'Audit fixture line.\n'.repeat(11000));
  const script = path.join(root, 'replay.json');
  fs.writeFileSync(script, JSON.stringify({ version: 1, calls: [
    { tool_calls: [{ tool_id: 'read_file', arguments: { path: 'large.md' } }] },
    // The failed tool adds a user-role recovery instruction as well as its
    // result. Replay therefore advances twice before the bounded retry.
    { text: 'Unexpected replay position.' },
    { tool_calls: [{ tool_id: 'read_file', arguments: { path: 'large.md', offset: 1, limit: 1 } }] },
    { text: 'Recovered with a bounded read.' }, { text: 'Followup complete.' },
  ] }));
  const previous = process.env.JENNY_REPLAY_SCRIPT;
  process.env.JENNY_REPLAY_SCRIPT = script;
  const seen = []; const logs = [];
  const backend = createBackend(profile, workspace, seen, logs);
  t.after(async () => {
    await backend.stop(); backend.dispose();
    if (previous === undefined) delete process.env.JENNY_REPLAY_SCRIPT;
    else process.env.JENNY_REPLAY_SCRIPT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  await backend.start();
  const projects = backend.projectApplicationService;
  const created = projects.createProject({ name: 'Read error fixture' });
  assert.equal(created.ok, true);
  assert.equal(projects.bindProjectRoot({ project_id: created.project.id, root_path: workspace,
    expected_root_revision: created.project.root_revision }).ok, true);
  const sessionId = (await backend.createSession({ projectId: created.project.id })).data.id;
  await backend.setSessionPreferences(sessionId, { run_mode: 'plan', plan_mode: true });
  const sent = await backend.runtimeApplicationService.submit({ session_id: sessionId,
    prompt: 'Read the audit fixture, recover with a bounded read if needed.', plan_mode: true,
    idempotency_key: 'read-error-first' });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  await waitFor(() => {
    const work = backend.sessionRuntime.store.get(sent.work_id);
    if (['failed', 'needs_attention'].includes(work.status)) throw new Error(JSON.stringify(work.transition));
    return work.status === 'completed';
  });
  const session = backend.sessionStore.getSession(sessionId);
  const reads = session.messages.filter(message => message.kind === 'tool_result'
    && message.tool_result?.tool_name === 'read_file');
  assert.equal(reads.length, 2, JSON.stringify(seen.filter(event => event.type === 'tool_result')));
  assert.equal(reads[0].tool_result.is_error, true);
  assert.equal(reads[1].tool_result.is_error, false);
  assert.equal(session.plan_mode, true);
  assert.equal(backend.sessionStore.getActiveTurn(sessionId), null);
  assert.equal(backend.sessionRuntime.resourceBroker.snapshot().quarantined_count, 0);
  const next = await backend.runtimeApplicationService.submit({ session_id: sessionId,
    prompt: 'Report completion.', plan_mode: true, idempotency_key: 'read-error-next' });
  assert.equal(next.ok, true, JSON.stringify(next));
  await waitFor(() => backend.sessionRuntime.store.get(next.work_id).status === 'completed');
});

for (const [decision, priorMode] of [['approved', 'ask'], ['approved_auto', 'ask'], ['approved', 'auto']]) {
  test(`real Python Plan ${decision} from ${priorMode} edits after consent and permits the next submission`, { timeout: 45000 }, async t => {
    const artifacts = path.join(ROOT, 'artifacts'); fs.mkdirSync(artifacts, { recursive: true });
    const root = fs.mkdtempSync(path.join(artifacts, 'plan-smoke-'));
    const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
    const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
    const script = path.join(root, 'replay.json');
    fs.writeFileSync(script, JSON.stringify({ version: 1, calls: [
      ...(priorMode === 'auto' ? [{ tool_calls: [{ tool_id: 'create_artifact', arguments: {
        artifact_kind: 'document', title: 'Safe Plan document', language: 'markdown',
        content: '# Plan\nCreate a disposable test file.',
      } }] }] : []),
      { tool_calls: [{ tool_id: 'exit_plan_mode', arguments: {
        title: 'Test Plan approval', steps: ['Create a disposable test file'],
      } }] },
      { tool_calls: [{ tool_id: 'write_file', arguments: { path: 'smoke.txt', content: 'verified' } }] },
      { text: 'Plan test complete.' },
      { text: 'Followup complete.' },
    ] }));
    const previous = process.env.JENNY_REPLAY_SCRIPT;
    process.env.JENNY_REPLAY_SCRIPT = script;
    const previousLedger = process.env.JENNY_OPERATION_LEDGER_ROOT;
    process.env.JENNY_OPERATION_LEDGER_ROOT = path.join(profile, 'operation-ledger');
    t.after(() => {
      if (previous === undefined) delete process.env.JENNY_REPLAY_SCRIPT;
      else process.env.JENNY_REPLAY_SCRIPT = previous;
      if (previousLedger === undefined) delete process.env.JENNY_OPERATION_LEDGER_ROOT;
      else process.env.JENNY_OPERATION_LEDGER_ROOT = previousLedger;
      fs.rmSync(root, { recursive: true, force: true });
    });
    const seen = []; const logs = [];
    const backend = createBackend(profile, workspace, seen, logs);
    try {
      await backend.start();
      const projects = backend.projectApplicationService;
      const created = projects.createProject({ name: 'Plan fixture' });
      assert.equal(created.ok, true);
      assert.equal(projects.bindProjectRoot({ project_id: created.project.id, root_path: workspace,
        expected_root_revision: created.project.root_revision }).ok, true);
      const sessionId = (await backend.createSession({ projectId: created.project.id })).data.id;
      await backend.setSessionPreferences(sessionId, { run_mode: priorMode });
      await backend.setSessionPreferences(sessionId, { run_mode: 'plan', plan_mode: true });
      const sent = await backend.runtimeApplicationService.submit({ session_id: sessionId,
        prompt: 'Plan and create the test file.', plan_mode: true, idempotency_key: 'plan-smoke-first' });
      assert.equal(sent.ok, true, JSON.stringify(sent));
      const [reference, pending] = await waitFor(() => [...backend.pendingToolApprovals.entries()][0]);
      assert.equal(pending.toolName, 'exit_plan_mode');
      const approvalEvent = seen.find(event => event.type === 'tool_approval_needed');
      assert.ok(approvalEvent.turnId);
      assert.notEqual(approvalEvent.turnId, approvalEvent.streamId);
      assert.equal(fs.existsSync(path.join(workspace, 'smoke.txt')), false);
      assert.equal(backend.approveToolCall(reference, { decision }), true);
      if (decision === 'approved' && priorMode === 'ask') {
        const [writeReference, writeApproval] = await waitFor(() => [...backend.pendingToolApprovals.entries()]
          .find(([, approval]) => approval.toolName === 'write_file'));
        assert.equal(writeApproval.toolName, 'write_file');
        assert.equal(backend.approveToolCall(writeReference, true), true);
      }
      await waitFor(() => {
        const work = backend.sessionRuntime.store.get(sent.work_id);
        if (['failed', 'needs_attention'].includes(work.status)) throw new Error(JSON.stringify(work));
        return work.status === 'completed';
      });
      assert.equal(fs.readFileSync(path.join(workspace, 'smoke.txt'), 'utf8'), 'verified');
      const session = backend.sessionStore.getSession(sessionId);
      if (priorMode === 'auto') {
        const artifact = session.messages.find(message => message.kind === 'tool_result'
          && message.tool_result?.tool_name === 'create_artifact');
        assert.ok(artifact, 'Plan document result must be persisted');
        assert.equal(artifact.tool_result.is_error, false, JSON.stringify(artifact));
      }
      assert.equal(session.plan_mode, false);
      const messages = new Set(session.messages.map(message => message.id));
      assert.ok(session.turn_events.filter(event => event.tool_call_id)
        .every(event => messages.has(event.primary_message_id)));
      const next = await backend.runtimeApplicationService.submit({ session_id: sessionId,
        prompt: 'Report completion.', idempotency_key: 'plan-smoke-next' });
      assert.equal(next.ok, true);
      await waitFor(() => backend.sessionRuntime.store.get(next.work_id).status === 'completed');
      assert.equal(backend.sessionRuntime.resourceBroker.snapshot().quarantined_count, 0);
    } catch (error) {
      t.diagnostic(JSON.stringify({ errors: seen.filter(event => event.type === 'error')
        .map(({ message, terminal_subcode }) => ({ message, terminal_subcode })),
        tools: seen.filter(event => ['tool_result', 'tool_approval_needed'].includes(event.type))
          .map(({ type, toolName, content, isError }) => ({ type, toolName, content, isError })),
        logs: logs.filter(event => /plan|attention|error/i.test(JSON.stringify(event))).slice(-8) }));
      throw error;
    } finally { await backend.stop(); backend.dispose(); }
  });
}
