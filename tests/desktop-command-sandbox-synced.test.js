'use strict';
// Row 106: synced-workspace service ordering, crash handling and mode switching.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DesktopSandboxService } = require('../services/execution/desktop-sandbox-service');
const { sandboxError } = require('../services/execution/sandbox-errors');
const { readyService, fakeLauncher, fixture } = require('./helpers/desktop-sandbox-lifecycle-fixture');

const sha = (text) => createHash('sha256').update(text).digest('hex');
const INCARNATION = '11111111-1111-4111-8111-111111111111';

async function syncedService(t, { probe = { available: true }, createError = null, worker = {} } = {}) {
  const events = [];
  const restorePoints = {
    async probe() { events.push('probe'); return probe; },
    async create() {
      events.push('restore_point');
      if (createError) throw createError;
      return { kind: 'git_checkpoint', ref: 'refs/jenny/sandbox/session/1', created_at: '2026-11-03T00:00:00Z' };
    },
  };
  // The folder must sit outside the profile, or staging refuses it (snapshot_profile_overlap).
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jenny-synced-root-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const setup = await readyService(t, { root });
  setup.config.state = { ...setup.config.state, commandSandbox: { enabled: true, mode: 'synced' } };
  setup.service.configuredMode = 'synced';
  setup.service.restorePoints = restorePoints;
  await fs.writeFile(path.join(setup.workspace, 'a.txt'), 'alpha');
  await fs.writeFile(path.join(setup.workspace, 'del.txt'), 'bye');
  await fs.mkdir(path.join(setup.workspace, '.git'));
  await fs.writeFile(path.join(setup.workspace, '.git', 'config'), '[core]\n');
  setup.events = events;
  setup.workers = [];
  setup.service._worker = async (snapshot, binding, mirror) => {
    events.push('worker');
    assert.ok(mirror?.outboxDirectory && mirror.volume, 'synced workers get the mirror layout');
    Object.assign(binding, { container_id: 'c'.repeat(64), image_id: setup.service.imageId });
    const handle = {
      containerId: binding.container_id,
      mirror,
      transport: { admissionCheck: null, async request() { return { incarnation: INCARNATION }; }, dispose() {} },
      broker: {
        async execute(_args, options) {
          await options.beforeAdmission();
          events.push('admitted');
          if (worker.beforeOutbox) await worker.beforeOutbox(setup);
          const changes = worker.changes || [
            { path: 'a.txt', change: 'modified', kind: 'file', text: 'alpha two' },
            { path: 'new.txt', change: 'added', kind: 'file', text: 'fresh' },
            { path: 'del.txt', change: 'deleted', kind: 'file' },
            { path: '.GIT/config', change: 'added', kind: 'file', text: '[core]\n\thooksPath = x\n' },
          ];
          await fs.mkdir(path.join(mirror.outboxDirectory, 'files'), { recursive: true });
          const entries = [];
          for (const [index, entry] of changes.entries()) {
            const { text, ...rest } = entry;
            if (text === undefined) { entries.push(rest); continue; }
            await fs.writeFile(path.join(mirror.outboxDirectory, 'files', String(index)), text);
            entries.push({ ...rest, file: String(index), size: Buffer.byteLength(text), sha256: sha(text) });
          }
          await fs.writeFile(path.join(mirror.outboxDirectory, 'changes.json'),
            JSON.stringify({ schema_version: 1, job_id: binding.job_id, status: 'ok', entries }));
          if (worker.fail) throw worker.fail;
          return { status: 'completed', exit_code: 0, stdout: 'ok', stderr: '', output_truncated: false,
            success: true, cleanup_confirmed: true };
        },
      },
    };
    setup.workers.push(handle);
    return handle;
  };
  const originalStop = setup.launcher.stopAndRemove;
  setup.launcher.stopAndRemove = async (id) => { events.push('container_removed'); return originalStop(id); };
  return setup;
}

function run(setup, approve = async () => ({ approved: true, digest: 'd'.repeat(64) })) {
  return setup.service.execute({ command: 'edit things' }, { sessionId: 'session', streamId: 'stream', callId: 'call',
    projectAuthority: setup.authority }, async (binding, ...rest) => {
    setup.events.push('approval');
    setup.binding = binding;
    return approve(binding, ...rest);
  });
}

async function indexFiles(setup) {
  return (await fs.readdir(path.join(setup.service.directory, 'mirrors')).catch(() => [])).filter((name) => /^[a-f0-9]{16}\.json$/u.test(name));
}

test('synced run orders approval, restore point, admission, cleanup, then write-back', async (t) => {
  const setup = await syncedService(t);
  const result = await run(setup);
  assert.deepEqual(setup.events, ['probe', 'worker', 'approval', 'restore_point', 'admitted', 'container_removed']);
  assert.equal(setup.binding.workspace, 'synced');
  assert.equal(setup.binding.undo, true);
  assert.match(setup.binding.snapshot_digest, /^[a-f0-9]{64}$/u);
  assert.match(setup.binding.mirror_id, /^[a-f0-9]{16}$/u);
  assert.equal(await fs.readFile(path.join(setup.workspace, 'a.txt'), 'utf8'), 'alpha two');
  assert.equal(await fs.readFile(path.join(setup.workspace, 'new.txt'), 'utf8'), 'fresh');
  await assert.rejects(fs.lstat(path.join(setup.workspace, 'del.txt')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(setup.workspace, '.git', 'config'), 'utf8'), '[core]\n');
  assert.equal(result.synced.write_back.status, 'applied');
  assert.deepEqual(result.synced.write_back.refused.map((item) => [item.path, item.reason]), [['.GIT', 'protected']]);
  assert.equal(result.synced.restore_point.ref, 'refs/jenny/sandbox/session/1');
  assert.deepEqual(await indexFiles(setup), [setup.binding.mirror_id + '.json']);
  assert.deepEqual(await fs.readdir(path.join(setup.service.directory, 'outbox')), []);
  const terminal = setup.service.receipts.records.find((item) => item.kind === 'terminal');
  assert.equal(terminal.binding.restore_ref, 'refs/jenny/sandbox/session/1');
  assert.equal(terminal.binding.outbox_id.length, 36);
  assert.equal(setup.service.state, 'ready');
});

test('a denied synced run takes no restore point and leaves the folder and outbox clean', async (t) => {
  const setup = await syncedService(t);
  await assert.rejects(run(setup, async () => ({ approved: false })), /sandbox_approval_denied/u);
  assert.equal(setup.events.includes('restore_point'), false);
  assert.equal(setup.events.includes('admitted'), false);
  assert.equal(await fs.readFile(path.join(setup.workspace, 'a.txt'), 'utf8'), 'alpha');
  assert.deepEqual(await fs.readdir(path.join(setup.service.directory, 'outbox')), []);
  assert.equal(setup.service.state, 'ready');
});

test('no restore point is surfaced on the binding; a failed checkpoint refuses the run without latching', async (t) => {
  const noUndo = await syncedService(t, { probe: { available: false, reason: 'not_git' } });
  const result = await run(noUndo);
  assert.equal(noUndo.binding.undo, false);
  assert.equal(noUndo.events.includes('restore_point'), false);
  assert.equal(result.synced.undo, false);

  const broken = await syncedService(t, { createError: new Error('git failed') });
  await assert.rejects(run(broken), /sandbox_restore_point_failed/u);
  assert.equal(broken.events.includes('admitted'), false);
  assert.equal(await fs.readFile(path.join(broken.workspace, 'a.txt'), 'utf8'), 'alpha');
  assert.equal(broken.service.state, 'ready');
});

test('a crash before write-back leaves the folder untouched and the mirror marked for a full resync', async (t) => {
  const setup = await syncedService(t, { worker: { fail: sandboxError('sandbox_cleanup_unconfirmed') } });
  setup.launcher.stopAndRemove = async () => { setup.events.push('container_stuck'); throw sandboxError('sandbox_cleanup_unconfirmed'); };
  const error = await run(setup).then(() => null, (failure) => failure);
  assert.equal(error.reason, 'sandbox_cleanup_unconfirmed');
  assert.equal(error.synced.command_may_start, true);
  assert.equal(error.synced.write_back, null);
  assert.equal(await fs.readFile(path.join(setup.workspace, 'a.txt'), 'utf8'), 'alpha');
  assert.deepEqual(await indexFiles(setup), []);
  // The outbox stays for reconcile, which discards it without ever writing into the folder.
  const outboxes = await fs.readdir(path.join(setup.service.directory, 'outbox'));
  assert.equal(outboxes.length, 1);
  const before = await fs.readFile(path.join(setup.workspace, 'a.txt'));
  setup.launcher.stopAndRemove = async () => ({ cleanupConfirmed: true });
  setup.service.pendingRuntimeCleanup = null;
  await setup.service._reconcile();
  assert.deepEqual(await fs.readdir(path.join(setup.service.directory, 'outbox')), []);
  assert.deepEqual(await fs.readFile(path.join(setup.workspace, 'a.txt')), before);
  await assert.rejects(fs.lstat(path.join(setup.workspace, 'new.txt')), { code: 'ENOENT' });
});

test('a project root that changed during the run is never written back', async (t) => {
  const setup = await syncedService(t, { worker: { beforeOutbox: async (current) => {
    current.currentAuthority = { ...current.authority, root_revision: 1 };
  } } });
  const result = await run(setup);
  // The command ran in the mirror, but nothing reached the folder and the next run fully resyncs.
  assert.equal(result.synced.write_back.status, 'failed');
  assert.equal(result.synced.write_back.reason, 'write_back_stale');
  assert.equal(await fs.readFile(path.join(setup.workspace, 'a.txt'), 'utf8'), 'alpha');
  assert.deepEqual(await indexFiles(setup), []);
});

test('setMode switches through the transition path, removes mirrors for copy and honours the kill switch', async (t) => {
  const setup = await syncedService(t);
  assert.equal(setup.service.getState().mode, 'synced');
  assert.equal(setup.service.getState().workspace, 'synced');
  assert.equal(setup.service.getState().limits.entries, 200000);
  setup.service._prepare = async () => setup.service._publish('ready');
  setup.launcher.listMirrorVolumes = async () => ['e'.repeat(16)];
  const state = await setup.service.setMode({ mode: 'copy' });
  assert.equal(state.mode, 'copy');
  assert.equal(state.workspace, 'disposable_copy');
  assert.equal(state.limits.entries, 2048);
  assert.equal(setup.config.state.commandSandbox.mode, 'copy');
  assert.ok(setup.launcher.calls.some((call) => call[0] === 'removeMirrorVolume' && call[1] === 'e'.repeat(16)));
  await assert.rejects(setup.service.setMode({ mode: 'live' }), /sandbox_settings_invalid/u);
  await assert.rejects(setup.service.setMode({ mode: 'synced', extra: 1 }), /sandbox_settings_invalid/u);
  setup.service.active = {};
  await assert.rejects(setup.service.setMode({ mode: 'synced' }), /sandbox_wait_for_active_chats/u);
  setup.service.active = null;

  const killed = await fixture(t, { enabled: true });
  killed.config.state.commandSandbox.mode = 'synced';
  const service = new DesktopSandboxService({ userDataPath: killed.base, sourceRoot: killed.base, configService: killed.config,
    launcherFactory: () => fakeLauncher(), env: { JENNY_ENABLE_SANDBOX_SYNCED_MODE: '0' } });
  assert.equal(service.getState().mode, 'copy');
  assert.deepEqual(service.getState().modes, ['copy']);
  await assert.rejects(service.setMode({ mode: 'synced' }), /sandbox_settings_invalid/u);
});
