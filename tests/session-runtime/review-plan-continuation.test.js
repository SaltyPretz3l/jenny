'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { waitFor, createBackend } = require('../helpers/session-runtime-stdio-fixture');

test('approved Plan pauses at the next write approval and resumes with fresh consent', { timeout: 45000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-plan-continuation-'));
  const profile = path.join(root, 'profile'); const workspace = path.join(root, 'workspace');
  fs.mkdirSync(profile); fs.mkdirSync(workspace);
  const script = path.join(root, 'replay.json');
  fs.writeFileSync(script, JSON.stringify({ version: 1, calls: [
    { tool_calls: [{ tool_id: 'create_artifact', arguments: { artifact_kind: 'document',
      title: 'Plan', language: 'markdown', content: '# Plan\nWrite a disposable file.' } }] },
    { tool_calls: [{ tool_id: 'exit_plan_mode', arguments: { title: 'Plan', steps: ['Write file'] } }] },
    { tool_calls: [{ tool_id: 'write_file', arguments: { path: 'probe.txt', content: 'verified' } }] },
    { text: 'Finished.' }, { text: 'Next turn.' },
  ] }));
  const previous = process.env.JENNY_REPLAY_SCRIPT; process.env.JENNY_REPLAY_SCRIPT = script;
  const previousLedger = process.env.JENNY_OPERATION_LEDGER_ROOT;
  process.env.JENNY_OPERATION_LEDGER_ROOT = path.join(profile, 'operation-ledger');
  const seen = []; const logs = []; const backend = createBackend(profile, workspace, seen, logs);
  t.after(async () => {
    await backend.stop(); backend.dispose();
    if (previous === undefined) delete process.env.JENNY_REPLAY_SCRIPT; else process.env.JENNY_REPLAY_SCRIPT = previous;
    if (previousLedger === undefined) delete process.env.JENNY_OPERATION_LEDGER_ROOT;
    else process.env.JENNY_OPERATION_LEDGER_ROOT = previousLedger;
    fs.rmSync(root, { recursive: true, force: true });
  });
  await backend.start();
  const projects = backend.projectApplicationService;
  const p = projects.createProject({ name: 'Plan' }).project;
  assert.equal(projects.bindProjectRoot({ project_id: p.id, root_path: workspace, expected_root_revision: p.root_revision }).ok, true);
  const sessionId = (await backend.createSession({ projectId: p.id })).data.id;
  await backend.setSessionPreferences(sessionId, { run_mode: 'ask' });
  await backend.setSessionPreferences(sessionId, { run_mode: 'plan' });
  const sent = await backend.runtimeApplicationService.submit({ session_id: sessionId, prompt: 'Plan and write.',
    plan_mode: true, idempotency_key: 'plan_pause' });
  const [planRef] = await waitFor(() => [...backend.pendingToolApprovals.entries()].find(([, x]) => x.toolName === 'exit_plan_mode'));
  assert.equal(backend.approveToolCall(planRef, { decision: 'approved' }), true);
  const [writeRef, pending] = await waitFor(() => {
    const work = backend.sessionRuntime.store.get(sent.work_id);
    assert.ok(!['completed', 'failed', 'needs_attention'].includes(work.status), JSON.stringify({
      status: work.status, transition: work.transition, errors: seen.filter(x => x.type === 'error').slice(-3) }));
    return [...backend.pendingToolApprovals.entries()].find(([, x]) => x.toolName === 'write_file');
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.requireExactRef, true);
  const runtime = backend.sessionRuntime;
  const current = () => runtime.store.get(sent.work_id);
  assert.equal(backend.runtimeApplicationService.pause({ work_id: sent.work_id, expected_revision: current().revision }).ok, true);
  await waitFor(() => current().status !== 'running');
  assert.equal(current().status, 'paused', JSON.stringify({ seen: seen.filter(x => x.type === 'error').map(x => x.message),
    logs: logs.filter(x => /failed|unavailable|attention|unproven|refused/i.test(JSON.stringify(x))).slice(-8) }));
  assert.equal(backend.approveToolCall(writeRef, true), false);
  assert.equal(fs.existsSync(path.join(workspace, 'probe.txt')), false);
  assert.equal(backend.runtimeApplicationService.resume({ work_id: sent.work_id, expected_revision: current().revision }).ok, true);
  const [freshRef] = await waitFor(() => {
    assert.ok(!['failed', 'needs_attention'].includes(current().status), JSON.stringify({ status: current().status,
      errors: seen.filter(x => x.type === 'error').map(x => ({ message: x.message, code: x.error_code, reason: x.subcode })) }));
    return [...backend.pendingToolApprovals.entries()].find(([, x]) => x.toolName === 'write_file');
  });
  assert.notEqual(freshRef, writeRef);
  backend.approveToolCall(freshRef, true);
  await waitFor(() => current().status === 'completed');
  assert.equal(fs.readFileSync(path.join(workspace, 'probe.txt'), 'utf8'), 'verified');
  assert.equal(runtime.resourceBroker.snapshot().quarantined_count, 0);
  const next = await backend.runtimeApplicationService.submit({ session_id: sessionId, prompt: 'Next.', idempotency_key: 'next' });
  await waitFor(() => runtime.store.get(next.work_id).status === 'completed');
});
