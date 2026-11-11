'use strict';
// Row 106: synced-workspace approval rules, grant stamps and review metadata in the command bridge.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { executeSandboxCommand } = require('../services/execution/command-bridge');
const { SyncedWorkspace } = require('../services/execution/desktop-sandbox-synced');
const { normalizeSandboxResultMetadata } = require('../services/backend/sandbox-result-metadata');

async function fixture(t, { policy = 'auto', undo = true, mode = 'synced', result = null, failure = null } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jenny-synced-approval-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const process = {};
  const authority = Object.freeze({ project_id: 'project_test', root_path: path.join(directory, 'workspace'), root_id: 'root',
    root_revision: 0, device_id: null, inode: null });
  const state = { prompts: [], submitted: 0, policy };
  const service = {
    projectAuthority: { captureSession: () => authority, requireCurrent: () => authority },
    sidecarManager: { process }, _desktopPolicyProcess: process,
    activeStreams: new Map([['stream', {}]]),
    configService: { getState: () => ({ commandSandbox: { enabled: true, mode }, safetyMode: 'normal' }) },
    toolPermissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: { run_command: state.policy }, rules: [] }) },
    commandSandbox: { enabled: true, state: 'ready', mode, synced: new SyncedWorkspace({ directory }),
      execute: async (_args, _context, authorize) => {
        const binding = { command_digest: 'test', workspace: mode === 'synced' ? 'synced' : 'copy',
          ...(mode === 'synced' ? { undo } : {}) };
        const approval = await authorize(binding, () => {});
        if (!approval.approved) throw Object.assign(new Error(), { reason: 'sandbox_approval_denied' });
        approval.validate();
        state.submitted += 1;
        if (failure) throw failure;
        return result || { success: true, status: 'completed', stdout: 'ok', exit_code: 0, cleanup_confirmed: true,
          synced: mode === 'synced' ? { command_may_start: true, undo, restore_point: null,
            write_back: { status: 'applied', applied: [], refused: [] } } : undefined };
      } },
  };
  const options = { input: { command: 'npm test' }, sessionId: 'session', streamId: 'stream', callId: 'call_1',
    canonicalReadOnly: false, readOnly: false, planMode: false, projectAuthority: authority,
    authorize: async (request) => { state.prompts.push(request.reason); return true; } };
  return { service, options, state };
}

test('an auto grant asks once in synced mode, then runs unattended while a restore point exists', async (t) => {
  const setup = await fixture(t);
  await executeSandboxCommand(setup.service, setup.options);
  assert.equal(setup.state.prompts.length, 1, 'unstamped grant asks once');
  assert.match(setup.state.prompts[0], /copied back.*can be undone/su);
  await executeSandboxCommand(setup.service, setup.options);
  assert.equal(setup.state.prompts.length, 1, 'stamped grant runs unattended');
  assert.equal(setup.state.submitted, 2);
  // A different permission snapshot is a different grant: it asks again.
  setup.state.policy = 'ask';
  await executeSandboxCommand(setup.service, setup.options);
  assert.equal(setup.state.prompts.length, 2);
});

test('a Full auto answer leaves no grant behind, so plain Auto asks again', async (t) => {
  const setup = await fixture(t);
  let armed = true;
  setup.service.primaryFullAuto = { isArmed: (sessionId) => armed && sessionId === 'session' };
  await executeSandboxCommand(setup.service, setup.options);
  await executeSandboxCommand(setup.service, setup.options);
  assert.equal(setup.state.prompts.length, 2, 'each armed run is answered, none is stamped');
  armed = false;
  await executeSandboxCommand(setup.service, setup.options);
  assert.equal(setup.state.prompts.length, 3, 'after Full auto the person is asked');
  await executeSandboxCommand(setup.service, setup.options);
  assert.equal(setup.state.prompts.length, 3, "a person's approval still stamps the grant");
});

test('without a restore point a synced run always asks and says there is no undo', async (t) => {
  const setup = await fixture(t, { undo: false });
  for (let index = 0; index < 2; index += 1) await executeSandboxCommand(setup.service, setup.options);
  assert.equal(setup.state.prompts.length, 2);
  assert.ok(setup.state.prompts.every((reason) => /No undo/u.test(reason)));
});

test('copy mode keeps unattended auto runs and the disposable-copy wording', async (t) => {
  const auto = await fixture(t, { mode: 'copy' });
  const result = await executeSandboxCommand(auto.service, auto.options);
  assert.equal(auto.state.prompts.length, 0);
  assert.equal(result.metadata.execution.workspace, 'disposable_copy');
  assert.equal(result.metadata.scripted_change_review, undefined);
  const ask = await fixture(t, { mode: 'copy', policy: 'ask' });
  await executeSandboxCommand(ask.service, ask.options);
  assert.match(ask.state.prompts[0], /discarded/u);
});

test('synced results carry the change review on success and on failure once the command may have run', async (t) => {
  const applied = [{ path: 'src/app.js', change: 'modified', kind: 'file', before: Buffer.from('a\n'), after: Buffer.from('b\n'),
    beforeSize: 2, afterSize: 2 }];
  const synced = { command_may_start: true, undo: true, restore_point: null,
    write_back: { status: 'applied', applied, refused: [{ path: '.git/config', reason: 'protected' }] } };
  const ok = await fixture(t, { result: { success: true, status: 'completed', stdout: '', exit_code: 0, cleanup_confirmed: true, synced } });
  const result = await executeSandboxCommand(ok.service, ok.options);
  assert.equal(result.metadata.execution.workspace, 'synced');
  assert.equal(normalizeSandboxResultMetadata(result.metadata).execution.workspace, 'synced');
  assert.deepEqual(result.metadata.scripted_change_review.changed_paths, ['src/app.js']);
  assert.equal(result.metadata.scripted_change_review.refused_count, 1);
  assert.equal(result.metadata.diffs.length, 1);

  const failed = await fixture(t, { failure: Object.assign(new Error(), { reason: 'sandbox_job_failed', synced }) });
  const refused = await executeSandboxCommand(failed.service, failed.options);
  assert.equal(refused.success, false);
  assert.equal(refused.metadata.execution.workspace, 'synced');
  assert.equal(refused.metadata.scripted_change_review.call_outcome, 'failed');
  assert.match(refused.output, /may have run in the synced copy\. Copied 1 changed path\(s\) back.*\.git\/config \(protected\)/su);
  assert.match(result.output, /Copied 1 changed path\(s\) back to the workspace\. 1 changed path\(s\) were not copied back/u);

  // The model learns that nothing landed, and a write-back that did not happen is not a success.
  for (const [status, text] of [['too_large', /copied none of these changes back.*sync limit/u], ['failed', /could not copy/u]]) {
    const write_back = { status, applied: [], refused: [] };
    const run = await fixture(t, { result: { success: true, status: 'completed', stdout: 'done', exit_code: 0,
      cleanup_confirmed: true, synced: { ...synced, write_back } } });
    const outcome = await executeSandboxCommand(run.service, run.options);
    assert.equal(outcome.success, false);
    assert.match(outcome.output, text);
    assert.match(outcome.output, /workspace on this computer is unchanged/u);
  }

  const before = await fixture(t, { failure: Object.assign(new Error(), { reason: 'snapshot_limit' }) });
  const limit = await executeSandboxCommand(before.service, before.options);
  assert.equal(limit.metadata.scripted_change_review, undefined);
  assert.match(limit.output, /too large to sync into the sandbox \(limits: 4096 MiB, 200,000 files/u);
});
